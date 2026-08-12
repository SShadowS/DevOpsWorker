import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgAuthEventStore } from '../../src/db/pg-auth-event-store.ts';
import { PgUserStore } from '../../src/db/pg-user-store.ts';
import type { IAuthEventStore } from '../../src/auth/auth-event-store.interface.ts';

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

describe.skipIf(!url)('auth events (integration)', () => {
  let sql: postgres.Sql;
  let authEvents: PgAuthEventStore;
  let users: PgUserStore;

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
    authEvents = new PgAuthEventStore(sql);
    users = new PgUserStore(sql);
    await sql`DELETE FROM auth_events WHERE email LIKE 'autoeventtest-%'`;
    await sql`DELETE FROM users WHERE email LIKE 'autoeventtest-%'`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM auth_events WHERE email LIKE 'autoeventtest-%'`;
    await sql`DELETE FROM users WHERE email LIKE 'autoeventtest-%'`;
    await sql.end();
  });

  test('write + list round trip for login-success', async () => {
    const user = await users.create({
      email: 'autoeventtest-success@example.com',
      displayName: 'Success User',
      role: 'operator',
      passwordHash: 'fakehash',
    });

    await authEvents.write({
      kind: 'login-success',
      email: user.email,
      ip: '192.168.1.1',
      userId: user.id,
    });

    const events = await authEvents.list(10);
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0]!;
    expect(latest.kind).toBe('login-success');
    expect(latest.email).toBe('autoeventtest-success@example.com');
    expect(latest.ip).toBe('192.168.1.1');
    expect(latest.userId).toBe(user.id);
  });

  test('write + list round trip for login-failed', async () => {
    await authEvents.write({
      kind: 'login-failed',
      email: 'autoeventtest-failed@example.com',
      ip: '192.168.1.2',
      userId: null,
    });

    const events = await authEvents.list(10);
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0]!;
    expect(latest.kind).toBe('login-failed');
    expect(latest.email).toBe('autoeventtest-failed@example.com');
    expect(latest.ip).toBe('192.168.1.2');
    expect(latest.userId).toBeNull();
  });

  test('write + list round trip for login-locked-out', async () => {
    await authEvents.write({
      kind: 'login-locked-out',
      email: 'autoeventtest-locked@example.com',
      ip: '192.168.1.3',
      userId: null,
    });

    const events = await authEvents.list(10);
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0]!;
    expect(latest.kind).toBe('login-locked-out');
    expect(latest.email).toBe('autoeventtest-locked@example.com');
    expect(latest.ip).toBe('192.168.1.3');
    expect(latest.userId).toBeNull();
  });

  test('write + list round trip for logout', async () => {
    const user = await users.create({
      email: 'autoeventtest-logout@example.com',
      displayName: 'Logout User',
      role: 'operator',
      passwordHash: 'fakehash',
    });

    await authEvents.write({
      kind: 'logout',
      email: user.email,
      ip: '192.168.1.4',
      userId: user.id,
    });

    const events = await authEvents.list(10);
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0]!;
    expect(latest.kind).toBe('logout');
    expect(latest.email).toBe('autoeventtest-logout@example.com');
    expect(latest.ip).toBe('192.168.1.4');
    expect(latest.userId).toBe(user.id);
  });

  test('list returns newest first', async () => {
    const user = await users.create({
      email: 'autoeventtest-order@example.com',
      displayName: 'Order User',
      role: 'operator',
      passwordHash: 'fakehash',
    });

    // Write three events with slight delays to ensure different timestamps
    await authEvents.write({
      kind: 'login-success',
      email: user.email,
      ip: '192.168.1.5',
      userId: user.id,
    });

    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));

    await authEvents.write({
      kind: 'logout',
      email: user.email,
      ip: '192.168.1.5',
      userId: user.id,
    });

    const events = await authEvents.list(10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.kind).toBe('logout');
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test('list respects limit', async () => {
    const user = await users.create({
      email: 'autoeventtest-limit@example.com',
      displayName: 'Limit User',
      role: 'operator',
      passwordHash: 'fakehash',
    });

    // Write exactly 5 events from this user
    for (let i = 0; i < 5; i++) {
      await authEvents.write({
        kind: 'login-success',
        email: user.email,
        ip: '192.168.1.6',
        userId: user.id,
      });
    }

    // Query with limit 3 will return up to 3 rows. Since we just wrote 5,
    // and list() returns newest first, we should get exactly the 3 most recent.
    const events = await authEvents.list(3);
    expect(events.length).toBe(3);
    // All three should be from this test's user
    expect(events.every(e => e.email === user.email)).toBe(true);
  });

  test('failed login against unknown email stores attempted email with null user_id', async () => {
    const unknownEmail = 'autoeventtest-unknown@example.com';

    await authEvents.write({
      kind: 'login-failed',
      email: unknownEmail,
      ip: '192.168.1.7',
      userId: null,
    });

    const events = await authEvents.list(10);
    const event = events.find(e => e.email === unknownEmail);
    expect(event).toBeDefined();
    expect(event!.kind).toBe('login-failed');
    expect(event!.userId).toBeNull();
    expect(event!.email).toBe(unknownEmail);
  });

  test('deleting a user leaves their events in place with user_id set to null', async () => {
    const user = await users.create({
      email: 'autoeventtest-delete@example.com',
      displayName: 'Delete User',
      role: 'operator',
      passwordHash: 'fakehash',
    });

    await authEvents.write({
      kind: 'login-success',
      email: user.email,
      ip: '192.168.1.8',
      userId: user.id,
    });

    const eventsBefore = await authEvents.list(10);
    const eventBefore = eventsBefore.find(e => e.email === user.email);
    expect(eventBefore).toBeDefined();
    expect(eventBefore!.userId).toBe(user.id);

    // Delete the user
    await sql`DELETE FROM users WHERE id = ${user.id}`;

    // Event should still exist but with user_id = null
    const eventsAfter = await authEvents.list(10);
    const eventAfter = eventsAfter.find(e => e.email === user.email);
    expect(eventAfter).toBeDefined();
    expect(eventAfter!.kind).toBe('login-success');
    expect(eventAfter!.email).toBe(user.email);
    expect(eventAfter!.userId).toBeNull();
  });

});

// Type-level check: bad kind should be rejected at compile time.
// If this @ts-expect-error line becomes an error itself, it means the union
// type enforcement has regressed. This code is never executed — it only
// exists for TypeScript to type-check.
if (false as unknown as true) {
  const _typeCheckBadKind = null as any as IAuthEventStore;
  void _typeCheckBadKind.write({
    // @ts-expect-error 'login-succes' (typo) is not a valid AuthEventKind
    kind: 'login-succes',
    email: 'test@example.com',
    ip: '127.0.0.1',
    userId: null,
  });
}
