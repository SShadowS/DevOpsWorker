import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgUserStore } from '../../src/db/pg-user-store.ts';
import { PgSessionStore } from '../../src/db/pg-session-store.ts';

// Deliberately TEST_DATABASE_URL, never DATABASE_URL: these tests write and
// delete rows, and must not run against the production pipeline database.
//
// This file opens its OWN connection with postgres(url) rather than going
// through connectDatabase(): that helper memoises a singleton and silently
// ignores its url argument on every call after the first, so under
// `bun run test:all` a DATABASE_URL connection made by an earlier test file
// would make this file read and write production despite TEST_DATABASE_URL.
// A private connection also means this file's sql.end() cannot pull the
// connection out from under any other file.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('auth stores (integration)', () => {
  let sql: postgres.Sql;
  let users: PgUserStore;
  let sessions: PgSessionStore;

  beforeAll(async () => {
    sql = postgres(url!, {
      max: 5,
      // The schema below is idempotent (CREATE/ALTER ... IF NOT EXISTS), so
      // applying it against a database that already has these tables floods
      // stdout with benign "already exists, skipping" NOTICEs. Drop those;
      // forward anything else so a real notice isn't lost.
      onnotice: (notice) => {
        if (notice.code === '42P07' || notice.code === '42701') return;
        console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
      },
    });
    // A fresh connection has no guarantee the schema already exists (e.g. a
    // TEST_DATABASE_URL database no app process has ever connected to) --
    // apply the same idempotent DDL connectDatabase() runs, directly here.
    await sql.unsafe(SCHEMA);
    users = new PgUserStore(sql);
    sessions = new PgSessionStore(sql);
    await sql`DELETE FROM users WHERE email LIKE 'authstoretest-%'`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM users WHERE email LIKE 'authstoretest-%'`; // cascades to sessions
    await sql.end();
  });

  test('create + findByEmail is case-insensitive and returns hash', async () => {
    const created = await users.create({
      email: 'AuthStoreTest-a@Example.com',
      displayName: 'Test A',
      role: 'operator',
      passwordHash: 'fakehash',
    });
    expect(created.email).toBe('authstoretest-a@example.com');
    const found = await users.findByEmail('AUTHSTORETEST-A@example.COM');
    expect(found?.id).toBe(created.id);
    expect(found?.passwordHash).toBe('fakehash');
    expect(found?.role).toBe('operator');
  });

  test('count and list see the user; findById round-trips', async () => {
    expect(await users.count()).toBeGreaterThanOrEqual(1);
    const found = await users.findByEmail('authstoretest-a@example.com');
    const byId = await users.findById(found!.id);
    expect(byId?.displayName).toBe('Test A');
    expect((byId as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
  });

  test('setPassword replaces the hash', async () => {
    const found = await users.findByEmail('authstoretest-a@example.com');
    await users.setPassword(found!.id, 'newhash');
    const again = await users.findByEmail('authstoretest-a@example.com');
    expect(again?.passwordHash).toBe('newhash');
  });

  test('setRole changes the role', async () => {
    const found = await users.findByEmail('authstoretest-a@example.com');
    expect(found?.role).toBe('operator');
    await users.setRole(found!.id, 'admin');
    const again = await users.findByEmail('authstoretest-a@example.com');
    expect(again?.role).toBe('admin');
    await users.setRole(found!.id, 'operator'); // leave the row as later tests expect it
  });

  test('setDisabled toggles the flag', async () => {
    const found = await users.findByEmail('authstoretest-a@example.com');
    expect(found?.disabled).toBe(false);
    await users.setDisabled(found!.id, true);
    expect((await users.findByEmail('authstoretest-a@example.com'))?.disabled).toBe(true);
    await users.setDisabled(found!.id, false);
    expect((await users.findByEmail('authstoretest-a@example.com'))?.disabled).toBe(false);
  });

  test('session create/findValid/touch/delete lifecycle', async () => {
    const user = await users.findByEmail('authstoretest-a@example.com');
    const future = new Date(Date.now() + 60_000);
    await sessions.create(user!.id, 'tokenhash-live', future);
    expect(await sessions.findValid('tokenhash-live')).toEqual({ userId: user!.id });
    await sessions.touch('tokenhash-live');
    await sessions.delete('tokenhash-live');
    expect(await sessions.findValid('tokenhash-live')).toBeNull();
  });

  test('expired sessions are invalid and deleteExpired removes them', async () => {
    const user = await users.findByEmail('authstoretest-a@example.com');
    const past = new Date(Date.now() - 1000);
    await sessions.create(user!.id, 'tokenhash-expired', past);
    expect(await sessions.findValid('tokenhash-expired')).toBeNull();
    await sessions.deleteExpired();
    const rows = await sql`SELECT 1 FROM sessions WHERE token_hash = 'tokenhash-expired'`;
    expect(rows.length).toBe(0);
  });

  test('deleteByUser removes only that user\'s sessions', async () => {
    const user = await users.findByEmail('authstoretest-a@example.com');
    const other = await users.create({
      email: 'authstoretest-b@example.com',
      displayName: 'Test B',
      role: 'operator',
      passwordHash: 'fakehash',
    });
    const future = new Date(Date.now() + 60_000);
    await sessions.create(user!.id, 'tokenhash-deleteby-1', future);
    await sessions.create(user!.id, 'tokenhash-deleteby-2', future);
    await sessions.create(other.id, 'tokenhash-deleteby-other', future);

    await sessions.deleteByUser(user!.id);

    expect(await sessions.findValid('tokenhash-deleteby-1')).toBeNull();
    expect(await sessions.findValid('tokenhash-deleteby-2')).toBeNull();
    expect(await sessions.findValid('tokenhash-deleteby-other')).toEqual({ userId: other.id });
  });
});
