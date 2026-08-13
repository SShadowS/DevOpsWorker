import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { startDashboard, type DashboardHandle } from '../../src/dashboard/server.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgUserStore } from '../../src/db/pg-user-store.ts';
import { PgSessionStore } from '../../src/db/pg-session-store.ts';
import { PgAuthEventStore } from '../../src/db/pg-auth-event-store.ts';
import { PgRegistryStore } from '../../src/db/pg-registry-store.ts';
import { PgSettingsStore } from '../../src/db/pg-settings-store.ts';
import { PgAuditStore } from '../../src/db/pg-audit-store.ts';
import type { IStateStore } from '../../src/pipeline/state-store.interface.ts';
import type { IActionStore, ActionRecord } from '../../src/pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../../src/pipeline/runner-status.interface.ts';
import type { ILogSink } from '../../src/pipeline/log-sink.interface.ts';
import type { IPRReviewStore, PRReviewRow } from '../../src/pipeline/pr-review-store.interface.ts';
import type { AuthUser } from '../../src/auth/types.ts';

// ---------------------------------------------------------------------------
// This file exercises the NEW /api/admin/users routes end to end, including
// the three lockout guardrails and the concurrency race guardrail 3 must
// survive. That needs REAL row locking (`SELECT ... FOR UPDATE`) and a REAL
// rollback on a thrown guardrail error — an in-memory fake store cannot
// provide either, so unlike most of this repo's dashboard tests this one
// talks to genuine Postgres for BOTH authentication and the admin API.
//
// Deliberately gated on TEST_DATABASE_URL, never DATABASE_URL: this suite
// creates and disables/demotes admin accounts by design (that's the whole
// point of testing the guardrails), which is exactly the kind of operation
// that must never run against the live, single-admin production database
// (see tests/db/auth-stores.integration.test.ts for the same reasoning).
// Opens its own postgres(url) connection rather than connectDatabase(), for
// the same reason that file gives: connectDatabase() memoises a singleton
// and ignores its url on repeat calls within one process.
//
// Every row this file writes uses the 'admintest-users-' email prefix,
// cleaned up by exact LIKE match in afterAll. baselineUserRows below is a
// snapshot of every OTHER row (there should be none in a fresh TEST_DATABASE_URL,
// but the check is written defensively so it still means something if this
// file is ever pointed at a database that already has rows) — the "cleanup
// proof" test at the bottom compares against it.
const url = process.env.TEST_DATABASE_URL;

// -----------------------------------------------------------------------
// No-op stand-ins for the pipeline-side stores `startDashboard` requires
// but this suite never exercises. Implements the real interfaces so a
// field added to one of them is a compile error here, not a silent gap.
// -----------------------------------------------------------------------

class StubStateStore implements IStateStore {
  async exists(): Promise<boolean> { return false; }
  async load(): Promise<null> { return null; }
  async save(): Promise<void> {}
  async saveConfig(): Promise<void> {}
  async loadConfig(): Promise<null> { return null; }
  async listAll(): Promise<number[]> { return []; }
}

class StubActionStore implements IActionStore {
  async write(): Promise<number> { return 1; }
  async claimNextPending(): Promise<null> { return null; }
  async markCompleted(): Promise<void> {}
  async markFailed(): Promise<void> {}
  async recoverStale(): Promise<number> { return 0; }
  async listPending(): Promise<number[]> { return []; }
  async listRecent(): Promise<ActionRecord[]> { return []; }
}

class StubRunnerStatus implements IRunnerStatus {
  async writeStatus(): Promise<void> {}
  async readStatus(): Promise<null> { return null; }
  async readDynamicConcurrency(): Promise<null> { return null; }
  async writeDynamicConcurrency(): Promise<void> {}
  async clearDynamicConcurrency(): Promise<void> {}
  async writeHeartbeat(): Promise<void> {}
  async readHeartbeats(): Promise<Record<string, never>> { return {}; }
}

function stubLogSink(): ILogSink {
  return {
    write() {},
    readStageLog: async () => [],
    readAllStages: async () => [],
  };
}

class StubPRReviewStore implements IPRReviewStore {
  async save(): Promise<number> { return 1; }
  async listRecent(): Promise<PRReviewRow[]> { return []; }
  async findByActionId(): Promise<null> { return null; }
  async findById(): Promise<null> { return null; }
  async findLatestByPrId(): Promise<null> { return null; }
}

describe.skipIf(!url)('admin users API (real server + real Postgres)', () => {
  let sql: postgres.Sql;
  let handle: DashboardHandle;
  let base: string;
  let users: PgUserStore;
  let sessions: PgSessionStore;
  let baselineUserCount: number;

  const ADMIN_A = 'admintest-users-admin-a@example.invalid';
  const ADMIN_B = 'admintest-users-admin-b@example.invalid';
  const ADMIN_C = 'admintest-users-admin-c@example.invalid';
  const OPERATOR = 'admintest-users-op@example.invalid';

  async function cleanupTestRows(): Promise<void> {
    await sql`DELETE FROM users WHERE email LIKE 'admintest-users-%'`; // cascades to sessions
    await sql`DELETE FROM auth_events WHERE email LIKE 'admintest-users-%'`;
    await sql`DELETE FROM audit_log WHERE entity_key LIKE 'admintest-users-%'`;
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie')!;
    return new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;
  }

  function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...(init.headers ?? {}), Cookie: `${SESSION_COOKIE}=${cookie}` } };
  }

  function putJson(body: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  function postJson(body: unknown): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  async function auditRowsFor(entityKey: string): Promise<Array<{ action: string; actor_email: string; before_value: unknown; after_value: unknown }>> {
    const rows = await sql`
      SELECT action, actor_email, before_value, after_value FROM audit_log
      WHERE entity_key = ${entityKey} ORDER BY at ASC
    `;
    return rows as unknown as Array<{ action: string; actor_email: string; before_value: unknown; after_value: unknown }>;
  }

  beforeAll(async () => {
    sql = postgres(url!, {
      max: 10,
      onnotice: (notice) => {
        if (notice.code === '42P07' || notice.code === '42701') return;
        console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
      },
    });
    await sql.unsafe(SCHEMA);
    await cleanupTestRows();

    baselineUserCount = (await sql`SELECT count(*)::int AS n FROM users`)[0]!.n as number;

    users = new PgUserStore(sql);
    sessions = new PgSessionStore(sql);
    const authEventStore = new PgAuthEventStore(sql);
    const registryStore = new PgRegistryStore(sql);
    const settingsStore = new PgSettingsStore(sql);
    const auditStore = new PgAuditStore(sql);

    // Two active admins to start: most tests act as ADMIN_A. ADMIN_B exists
    // so "the last remaining admin" guard has a genuine counter-example
    // (demoting/disabling ONE of two admins must be ALLOWED).
    await users.create({ email: ADMIN_A, displayName: 'Admin A', role: 'admin', passwordHash: await Bun.password.hash('admintest-password-a1') });
    await users.create({ email: ADMIN_B, displayName: 'Admin B', role: 'admin', passwordHash: await Bun.password.hash('admintest-password-b1') });
    await users.create({ email: OPERATOR, displayName: 'Operator', role: 'operator', passwordHash: await Bun.password.hash('admintest-password-o1') });

    handle = startDashboard({
      port: 0,
      stateStore: new StubStateStore(),
      actionStore: new StubActionStore(),
      runnerStatus: new StubRunnerStatus(),
      logSink: () => stubLogSink(),
      prReviewStore: new StubPRReviewStore(),
      prReviewLogSink: () => stubLogSink(),
      sql,
      userStore: users,
      sessionStore: sessions,
      authEventStore,
      registryStore,
      settingsStore,
      auditStore,
    });
    base = `http://localhost:${handle.server.port}`;
  });

  afterAll(async () => {
    handle.stop();
    await cleanupTestRows();
    await sql.end();
  });

  // -------------------------------------------------------------------------
  // Auth gate — the shared `^/api/admin/` rule already covers this path
  // prefix (tested exhaustively in admin-api.test.ts); one check here just
  // confirms /api/admin/users specifically is wired into that same gate.
  // -------------------------------------------------------------------------

  test('unauthenticated and non-admin requests are rejected', async () => {
    expect((await fetch(`${base}/api/admin/users`)).status).toBe(401);
    const opCookie = await loginAs(OPERATOR, 'admintest-password-o1');
    expect((await fetch(`${base}/api/admin/users`, withCookie(opCookie))).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // List, create
  // -------------------------------------------------------------------------

  describe('list and create', () => {
    test('admin can list users; the list is an array and carries no password field', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users`, withCookie(adminCookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      const text = JSON.stringify(body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('password_hash');
      const self = (body as AuthUser[]).find((u) => u.email === ADMIN_A);
      expect(self?.role).toBe('admin');
      expect(self?.disabled).toBe(false);
    });

    test('admin can create a user with a password; the response and audit row never contain it', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const email = 'admintest-users-created@example.invalid';
      const secret = 'admintest-super-secret-1';

      const res = await fetch(`${base}/api/admin/users`, withCookie(adminCookie, postJson({
        email, displayName: 'Created User', role: 'operator', password: secret,
      })));
      expect(res.status).toBe(201);
      const body = await res.json();
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain(secret);
      expect(responseText).not.toContain('password');

      const listRes = await fetch(`${base}/api/admin/users`, withCookie(adminCookie));
      const list = (await listRes.json()) as AuthUser[];
      expect(list.some((u) => u.email === email)).toBe(true);

      const audit = await auditRowsFor(email);
      expect(audit.length).toBe(1);
      expect(audit[0]!.action).toBe('create');
      expect(audit[0]!.actor_email).toBe(ADMIN_A);
      const auditText = JSON.stringify(audit[0]);
      expect(auditText).not.toContain(secret);
      expect(auditText.toLowerCase()).not.toContain('password');

      // Verify directly against the row too: password_hash must be a real
      // hash (bcrypt/argon2-shaped), never the plaintext we sent.
      const rows = await sql`SELECT password_hash FROM users WHERE email = ${email}`;
      expect(rows[0]!.password_hash).not.toBe(secret);
      expect((rows[0]!.password_hash as string).length).toBeGreaterThan(20);
    });

    test('creating a duplicate email is 409, not 500', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users`, withCookie(adminCookie, postJson({
        email: ADMIN_B, displayName: 'Dup', role: 'operator', password: 'admintest-password-dup1',
      })));
      expect(res.status).toBe(409);
    });

    test('a password shorter than 8 characters is rejected with 400, and writes no audit row', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const email = 'admintest-users-shortpw@example.invalid';
      const res = await fetch(`${base}/api/admin/users`, withCookie(adminCookie, postJson({
        email, displayName: 'Short', role: 'operator', password: 'short',
      })));
      expect(res.status).toBe(400);
      expect(await auditRowsFor(email)).toEqual([]);
    });

    test('an invalid role is rejected with 400', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users`, withCookie(adminCookie, postJson({
        email: 'admintest-users-badrole@example.invalid', displayName: 'Bad Role', role: 'superuser', password: 'admintest-password-x1',
      })));
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Role, disabled, password — happy path + audit
  // -------------------------------------------------------------------------

  describe('role, disabled, and password mutations', () => {
    const targetEmail = 'admintest-users-mutable@example.invalid';

    test('admin can promote, disable/re-enable, and reset the password of another user, each with one audit row', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      await users.create({ email: targetEmail, displayName: 'Mutable', role: 'operator', passwordHash: await Bun.password.hash('admintest-password-m1') });

      const roleRes = await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/role`, withCookie(adminCookie, putJson({ role: 'admin' })));
      expect(roleRes.status).toBe(200);
      expect(((await roleRes.json()) as { user: AuthUser }).user.role).toBe('admin');

      const disableRes = await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/disabled`, withCookie(adminCookie, putJson({ disabled: true })));
      expect(disableRes.status).toBe(200);
      const disabledUser = await users.findByEmail(targetEmail);
      expect(disabledUser?.disabled).toBe(true);

      // A disabled admin can no longer authenticate at all — proves this
      // route has a real, immediate effect, not just a flag nobody reads.
      const loginWhileDisabled = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: 'admintest-password-m1' }),
      });
      expect(loginWhileDisabled.status).toBe(401);

      const reenableRes = await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/disabled`, withCookie(adminCookie, putJson({ disabled: false })));
      expect(reenableRes.status).toBe(200);

      const newPassword = 'admintest-new-password-m2';
      const pwRes = await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/password`, withCookie(adminCookie, putJson({ password: newPassword })));
      expect(pwRes.status).toBe(200);
      const pwBodyText = JSON.stringify(await pwRes.json());
      expect(pwBodyText).not.toContain(newPassword);

      const loginWithNewPassword = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: newPassword }),
      });
      expect(loginWithNewPassword.status).toBe(200);

      const audit = await auditRowsFor(targetEmail);
      expect(audit.map((a) => a.action)).toEqual(['update', 'update', 'update', 'update']);
      expect(audit.every((a) => a.actor_email === ADMIN_A)).toBe(true);
      const auditText = JSON.stringify(audit);
      expect(auditText).not.toContain(newPassword);
      expect(auditText.toLowerCase()).not.toContain('hash');
    });

    test('changing a password revokes that user\'s existing sessions', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const email = 'admintest-users-sessionrevoke@example.invalid';
      const oldPassword = 'admintest-password-sr1';
      const created = await users.create({ email, displayName: 'Session Revoke', role: 'operator', passwordHash: await Bun.password.hash(oldPassword) });

      const targetCookie = await loginAs(email, oldPassword);
      const meBefore = await fetch(`${base}/api/auth/me`, withCookie(targetCookie));
      expect(meBefore.status).toBe(200);

      const newPassword = 'admintest-password-sr2';
      const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(email)}/password`, withCookie(adminCookie, putJson({ password: newPassword })));
      expect(res.status).toBe(200);

      const meAfter = await fetch(`${base}/api/auth/me`, withCookie(targetCookie));
      expect(meAfter.status).toBe(401); // the old session no longer resolves

      const remaining = await sql`SELECT 1 FROM sessions WHERE user_id = ${created.id}`;
      expect(remaining.length).toBe(0);
    });

    test('PUT role/disabled/password on an unknown email is 404', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const missing = 'admintest-users-never-existed@example.invalid';
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(missing)}/role`, withCookie(adminCookie, putJson({ role: 'admin' })))).status).toBe(404);
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(missing)}/disabled`, withCookie(adminCookie, putJson({ disabled: true })))).status).toBe(404);
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(missing)}/password`, withCookie(adminCookie, putJson({ password: 'admintest-password-zz1' })))).status).toBe(404);
    });

    test('a malformed body is 400: wrong role value, non-boolean disabled, short password', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/role`, withCookie(adminCookie, putJson({ role: 'superuser' })))).status).toBe(400);
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/disabled`, withCookie(adminCookie, putJson({ disabled: 'yes' })))).status).toBe(400);
      expect((await fetch(`${base}/api/admin/users/${encodeURIComponent(targetEmail)}/password`, withCookie(adminCookie, putJson({ password: 'short' })))).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // THE THREE GUARDRAILS
  // -------------------------------------------------------------------------

  describe('guardrails', () => {
    test('guardrail 1: an admin cannot remove their own admin role', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(ADMIN_A)}/role`, withCookie(adminCookie, putJson({ role: 'operator' })));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
      expect((await users.findByEmail(ADMIN_A))?.role).toBe('admin'); // unchanged
    });

    test('guardrail 1 does not block an admin re-affirming their own admin role (no-op)', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(ADMIN_A)}/role`, withCookie(adminCookie, putJson({ role: 'admin' })));
      expect(res.status).toBe(200);
    });

    test('guardrail 2: an admin cannot disable their own account', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(ADMIN_A)}/disabled`, withCookie(adminCookie, putJson({ disabled: true })));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(typeof body.error).toBe('string');
      expect((await users.findByEmail(ADMIN_A))?.disabled).toBe(false); // unchanged
    });

    test('sanity: an admin CAN disable a different admin when at least one other active admin remains', async () => {
      const adminCookie = await loginAs(ADMIN_A, 'admintest-password-a1');
      // ADMIN_A and ADMIN_B are both active here — disabling B leaves A, which is fine.
      const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(ADMIN_B)}/disabled`, withCookie(adminCookie, putJson({ disabled: true })));
      expect(res.status).toBe(200);
      // restore for the remaining tests in this file
      await fetch(`${base}/api/admin/users/${encodeURIComponent(ADMIN_B)}/disabled`, withCookie(adminCookie, putJson({ disabled: false })));
    });

    // There is deliberately no "a DIFFERENT, currently-active admin demotes
    // the sole remaining admin" test here, synchronous and non-racing: it
    // cannot be constructed. To make an authenticated admin-API call at all,
    // the actor must themselves be an active admin (a disabled account's
    // session is rejected by resolveSession() before it ever reaches this
    // route — see sessions.ts — and an operator is rejected by the
    // route-access gate before admin-api.ts is reached at all). So the
    // instant a *different* active admin is the one making the request,
    // `activeAdminCount` already includes both of them and is at least 2 —
    // demoting/disabling the OTHER one is therefore always safe (one
    // admin — the actor — necessarily remains) and is exactly what "sanity"
    // above confirms. The only way `activeAdminCount` is ever 1 at decision
    // time is when actor and target are the SAME account (guardrails 1/2,
    // above) or when a second transaction is racing the first (the
    // concurrency test right below) — there is no third case to cover here.

    // The race this guards against: two active admins simultaneously demote
    // EACH OTHER. Read independently ("there are 2 admins, safe to demote
    // the other one"), both requests would pass a naive count-then-act check
    // and BOTH commit, leaving zero admins. `lockTargetAndActiveAdmins` locks
    // the whole active-admin set with `FOR UPDATE` before deciding, so the
    // second transaction cannot even read a count until the first has
        // committed or rolled back — see admin-api.ts for the full reasoning.
    test('guardrail 3 survives concurrent demotion of two admins by each other: exactly one succeeds, one admin always remains', async () => {
      const raceA = 'admintest-users-race-a@example.invalid';
      const raceB = 'admintest-users-race-b@example.invalid';
      await users.create({ email: raceA, displayName: 'Race A', role: 'admin', passwordHash: await Bun.password.hash('admintest-password-racea1') });
      await users.create({ email: raceB, displayName: 'Race B', role: 'admin', passwordHash: await Bun.password.hash('admintest-password-raceb1') });

      const cookieA = await loginAs(raceA, 'admintest-password-racea1');
      const cookieB = await loginAs(raceB, 'admintest-password-raceb1');

      // A demotes B; B demotes A — fired concurrently. Whichever transaction
      // wins the row lock first sees 2 active admins (itself + its target)
      // among JUST this race pair... but the guard counts admins GLOBALLY,
      // and ADMIN_A/ADMIN_B (both active for most of this file) are also
      // real active admins in this same table, so demoting either raceA or
      // raceB alone would never trip guardrail 3 on its own. To make this a
      // genuine "down to the wire" race, temporarily disable every OTHER
      // active admin so raceA and raceB are the only two active admins left
      // for the duration of this one test, then restore them.
      const others = await sql`SELECT id, email FROM users WHERE role = 'admin' AND disabled = false AND email NOT IN (${raceA}, ${raceB})`;
      for (const o of others) await users.setDisabled(o.id as number, true);

      try {
        const [resA, resB] = await Promise.all([
          fetch(`${base}/api/admin/users/${encodeURIComponent(raceB)}/role`, withCookie(cookieA, putJson({ role: 'operator' }))),
          fetch(`${base}/api/admin/users/${encodeURIComponent(raceA)}/role`, withCookie(cookieB, putJson({ role: 'operator' }))),
        ]);

        const statuses = [resA.status, resB.status].sort();
        // One of the two demotions must have been rejected — never both 200.
        expect(statuses).toEqual([200, 409]);

        const stillAdmin = await sql`SELECT count(*)::int AS n FROM users WHERE email IN (${raceA}, ${raceB}) AND role = 'admin' AND disabled = false`;
        expect(stillAdmin[0]!.n).toBe(1); // exactly one of the pair remains an active admin — never zero
      } finally {
        for (const o of others) await users.setDisabled(o.id as number, false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup proof
  // -------------------------------------------------------------------------

  test('cleanup: after this suite runs, the only rows this file created are admintest-users-prefixed, and they are removable', async () => {
    const before = await sql`SELECT count(*)::int AS n FROM users WHERE email NOT LIKE 'admintest-users-%'`;
    expect(before[0]!.n).toBe(baselineUserCount);

    await cleanupTestRows();

    const after = await sql`SELECT count(*)::int AS n FROM users`;
    expect(after[0]!.n).toBe(baselineUserCount);
    const afterAudit = await sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_key LIKE 'admintest-users-%'`;
    expect(afterAudit[0]!.n).toBe(0);

    // Re-seed the three fixture accounts other tests in this file's afterAll
    // don't depend on (afterAll calls cleanupTestRows again, which is a
        // no-op on an already-empty set — this just proves the LIKE-scoped
    // delete really does clear everything this suite wrote).
  });
});
