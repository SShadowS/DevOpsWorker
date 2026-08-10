import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { PgUserStore } from '../../src/db/pg-user-store.ts';
import { PgSessionStore } from '../../src/db/pg-session-store.ts';

// Deliberately TEST_DATABASE_URL, never DATABASE_URL: these tests write and
// delete rows, and must not run against the production pipeline database.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('auth stores (integration)', () => {
  let sql: postgres.Sql;
  let users: PgUserStore;
  let sessions: PgSessionStore;

  beforeAll(async () => {
    const { connectDatabase } = await import('../../src/db/postgres.ts');
    sql = await connectDatabase(url!);
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
});
