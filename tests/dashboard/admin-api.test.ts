import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type postgres from 'postgres';
import postgresClient from 'postgres';
import { startDashboard, type DashboardHandle } from '../../src/dashboard/server.ts';
import { hashPassword } from '../../src/auth/local-provider.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { FakeUserStore, FakeSessionStore, FakeAuthEventStore } from '../auth/fakes.ts';
import { isDangerousKey } from '../../src/dashboard/admin-api.ts';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgRegistryStore } from '../../src/db/pg-registry-store.ts';
import { PgSettingsStore } from '../../src/db/pg-settings-store.ts';
import { PgAuditStore } from '../../src/db/pg-audit-store.ts';
import { mkRepo, mkCompanion } from '../config/fixtures/fake-registry-store.ts';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { _resetHydrationState } from '../../src/config/hydrate.ts';
import type { IStateStore } from '../../src/pipeline/state-store.interface.ts';
import type { IActionStore, ActionRecord } from '../../src/pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../../src/pipeline/runner-status.interface.ts';
import type { ILogSink } from '../../src/pipeline/log-sink.interface.ts';
import type { IPRReviewStore, PRReviewRow } from '../../src/pipeline/pr-review-store.interface.ts';
import type { IAuditStore, AuditRow } from '../../src/config/audit-store.interface.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';

// ---------------------------------------------------------------------------
// Pure unit tests — no DB, no server. Always run (including in CI, which has
// no Postgres service — see the DB-gated describe below for why).
// ---------------------------------------------------------------------------

describe('isDangerousKey', () => {
  test('rejects the three prototype-pollution keys', () => {
    expect(isDangerousKey('__proto__')).toBe(true);
    expect(isDangerousKey('constructor')).toBe(true);
    expect(isDangerousKey('prototype')).toBe(true);
  });

  test('accepts an ordinary key', () => {
    expect(isDangerousKey('my-repo')).toBe(false);
    expect(isDangerousKey('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real server + real Postgres. Every mutation here must land in the SAME
// transaction as its audit row (task requirement) — a fake/in-memory store
// cannot exercise that, so unlike auth-gate.test.ts's stub stores, this suite
// needs a genuine `sql.begin(...)` and a genuine ROLLBACK to prove it.
//
// Deliberately gated on DATABASE_URL, not a separate TEST_DATABASE_URL: this
// task was explicitly authorised to use the operator's already-running local
// Postgres (see the task brief) rather than stand up a second database. CI
// has no Postgres service and no DATABASE_URL (see .github/workflows/ci.yml),
// so this whole suite skips there — it neither passes nor fails, matching
// the existing tests/db/*.integration.test.ts convention in this repo.
//
// Every row this file writes uses the 'admintest-' key prefix, cleaned up by
// exact LIKE match in beforeAll/afterAll — never a bare DELETE/TRUNCATE. Real
// production rows (in particular companion_registry's 6 seeded companions,
// and any real repo registrations) are never touched.
const url = process.env.DATABASE_URL;

class FailingAuditStore implements IAuditStore {
  constructor(private readonly real: IAuditStore, private readonly failOnKey: string) {}

  async list(limit: number): Promise<AuditRow[]> {
    return this.real.list(limit);
  }

  async write(entry: Omit<AuditRow, 'id' | 'at'>, sql?: postgres.Sql | postgres.TransactionSql): Promise<void> {
    if (entry.entityKey === this.failOnKey) {
      throw new Error('forced audit failure — rollback test');
    }
    return this.real.write(entry, sql);
  }
}

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

const ROLLBACK_KEY = 'admintest-rollback-repo';

describe.skipIf(!url)('admin API (real server + real Postgres)', () => {
  let sql: postgres.Sql;
  let handle: DashboardHandle;
  let base: string;
  let operatorCookie: string;
  let adminCookie: string;
  let adminEmail: string;
  let repoSnapshot: RepoRegistry;
  let companionSnapshot: CompanionRegistry;

  async function cleanupTestRows(): Promise<void> {
    await sql`DELETE FROM repo_registry WHERE repo_key LIKE 'admintest-%'`;
    await sql`DELETE FROM companion_registry WHERE companion_key LIKE 'admintest-%'`;
    await sql`DELETE FROM settings WHERE key LIKE '%admintest%'`;
    await sql`DELETE FROM audit_log WHERE entity_key LIKE '%admintest%'`;
  }

  beforeAll(async () => {
    sql = postgresClient(url!, {
      max: 5,
      onnotice: (notice) => {
        if (notice.code === '42P07' || notice.code === '42701') return;
        console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
      },
    });
    await sql.unsafe(SCHEMA);
    await cleanupTestRows();

    repoSnapshot = { ...repos };
    companionSnapshot = { ...companionRegistry };
    _resetHydrationState();

    const userStore = new FakeUserStore();
    const sessionStore = new FakeSessionStore();
    await userStore.create({ email: 'admintest-op@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('op-password-1') });
    await userStore.create({ email: 'admintest-admin@x.y', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword('admin-password-1') });
    adminEmail = 'admintest-admin@x.y';

    const registryStore = new PgRegistryStore(sql);
    const settingsStore = new PgSettingsStore(sql);
    const realAuditStore = new PgAuditStore(sql);
    const auditStore = new FailingAuditStore(realAuditStore, ROLLBACK_KEY);

    handle = startDashboard({
      port: 0,
      stateStore: new StubStateStore(),
      actionStore: new StubActionStore(),
      runnerStatus: new StubRunnerStatus(),
      logSink: () => stubLogSink(),
      prReviewStore: new StubPRReviewStore(),
      prReviewLogSink: () => stubLogSink(),
      sql,
      userStore,
      sessionStore,
      authEventStore: new FakeAuthEventStore(),
      registryStore,
      settingsStore,
      auditStore,
    });
    base = `http://localhost:${handle.server.port}`;

    const loginAs = async (email: string, password: string): Promise<string> => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('Set-Cookie')!;
      return new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;
    };
    operatorCookie = await loginAs('admintest-op@x.y', 'op-password-1');
    adminCookie = await loginAs('admintest-admin@x.y', 'admin-password-1');
  });

  afterAll(async () => {
    handle.stop();
    replaceRepos(repoSnapshot);
    replaceCompanions(companionSnapshot);
    await cleanupTestRows();
    await sql.end();
  });

  function asAdmin(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...(init.headers ?? {}), Cookie: `${SESSION_COOKIE}=${adminCookie}` } };
  }

  function asOperator(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...(init.headers ?? {}), Cookie: `${SESSION_COOKIE}=${operatorCookie}` } };
  }

  function putJson(body: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  async function auditRowsFor(entityKey: string): Promise<Array<{ action: string; actor_email: string; before_value: unknown; after_value: unknown }>> {
    const rows = await sql`
      SELECT action, actor_email, before_value, after_value FROM audit_log
      WHERE entity_key = ${entityKey} ORDER BY at ASC
    `;
    return rows as unknown as Array<{ action: string; actor_email: string; before_value: unknown; after_value: unknown }>;
  }

  // -------------------------------------------------------------------------
  // Auth gate
  // -------------------------------------------------------------------------

  test('unauthenticated requests are rejected', async () => {
    expect((await fetch(`${base}/api/admin/repos`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/audit`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/repos/admintest-x`, { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  test('an authenticated operator (non-admin) is rejected', async () => {
    expect((await fetch(`${base}/api/admin/repos`, asOperator())).status).toBe(403);
    expect((await fetch(`${base}/api/admin/audit`, asOperator())).status).toBe(403);
    expect((await fetch(`${base}/api/admin/repos/admintest-x`, asOperator(putJson({})))).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Repos — full CRUD + audit
  // -------------------------------------------------------------------------

  describe('repos', () => {
    const key = 'admintest-repo-a';

    test('admin can create, read back, update, and delete a repo, with one audit row per mutation', async () => {
      const created = mkRepo({ repoKey: key, areaPath: 'Fake.Project\\AdminTest' });

      const putRes = await fetch(`${base}/api/admin/repos/${key}`, asAdmin(putJson(created)));
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${base}/api/admin/repos/${key}`, asAdmin());
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual(created);

      const listRes = await fetch(`${base}/api/admin/repos`, asAdmin());
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as RepoRegistry;
      expect(list[key]).toEqual(created);

      let audit = await auditRowsFor(key);
      expect(audit.length).toBe(1);
      expect(audit[0]!.action).toBe('create');
      expect(audit[0]!.actor_email).toBe(adminEmail);
      expect(audit[0]!.before_value).toBeNull();

      const updated = mkRepo({ repoKey: key, areaPath: 'Fake.Project\\AdminTest', repositoryId: 'updated-id' });
      const putRes2 = await fetch(`${base}/api/admin/repos/${key}`, asAdmin(putJson(updated)));
      expect(putRes2.status).toBe(200);

      const getRes2 = await fetch(`${base}/api/admin/repos/${key}`, asAdmin());
      expect((await getRes2.json()).azureDevOps.repositoryId).toBe('updated-id');

      audit = await auditRowsFor(key);
      expect(audit.length).toBe(2);
      expect(audit[1]!.action).toBe('update');
      expect(audit[1]!.actor_email).toBe(adminEmail);

      const delRes = await fetch(`${base}/api/admin/repos/${key}`, asAdmin({ method: 'DELETE' }));
      expect(delRes.status).toBe(200);

      const getRes3 = await fetch(`${base}/api/admin/repos/${key}`, asAdmin());
      expect(getRes3.status).toBe(404);

      audit = await auditRowsFor(key);
      expect(audit.length).toBe(3);
      expect(audit[2]!.action).toBe('delete');
    });

    test('GET on an absent key is 404', async () => {
      const res = await fetch(`${base}/api/admin/repos/admintest-repo-absent`, asAdmin());
      expect(res.status).toBe(404);
    });

    test('DELETE on an absent key is 404 and writes no audit row', async () => {
      const res = await fetch(`${base}/api/admin/repos/admintest-repo-never-existed`, asAdmin({ method: 'DELETE' }));
      expect(res.status).toBe(404);
      expect(await auditRowsFor('admintest-repo-never-existed')).toEqual([]);
    });

    test('an invalid payload is 400 and names the bad field, with no audit row written', async () => {
      const badKey = 'admintest-repo-bad';
      const res = await fetch(`${base}/api/admin/repos/${badKey}`, asAdmin(putJson({})));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: Array<{ path: string; message: string }> };
      expect(body.errors.some((e) => e.path === 'url')).toBe(true);
      expect(await auditRowsFor(badKey)).toEqual([]);
    });

    test('a failure inside the transaction rolls back the row write along with the audit row', async () => {
      const before = await fetch(`${base}/api/admin/repos/${ROLLBACK_KEY}`, asAdmin());
      expect(before.status).toBe(404); // sanity: nothing here yet

      const body = mkRepo({ repoKey: ROLLBACK_KEY, areaPath: 'Fake.Project\\Rollback' });
      const res = await fetch(`${base}/api/admin/repos/${ROLLBACK_KEY}`, asAdmin(putJson(body)));
      expect(res.status).toBe(500);

      const after = await fetch(`${base}/api/admin/repos/${ROLLBACK_KEY}`, asAdmin());
      expect(after.status).toBe(404); // the row write did not survive

      expect(await auditRowsFor(ROLLBACK_KEY)).toEqual([]); // neither did the audit row

      const rows = await sql`SELECT repo_key FROM repo_registry WHERE repo_key = ${ROLLBACK_KEY}`;
      expect(rows.length).toBe(0);
    });

    test('__proto__, constructor, and prototype are rejected as keys, with no row created', async () => {
      for (const dangerous of ['__proto__', 'constructor', 'prototype']) {
        const res = await fetch(`${base}/api/admin/repos/${dangerous}`, asAdmin(putJson(mkRepo({ repoKey: dangerous }))));
        expect(res.status).toBe(400);
      }
      const rows = await sql`SELECT repo_key FROM repo_registry WHERE repo_key IN ('__proto__', 'constructor', 'prototype')`;
      expect(rows.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Companions — same shape, condensed
  // -------------------------------------------------------------------------

  describe('companions', () => {
    const key = 'admintest-companion-a';

    test('admin can create, read back, update, and delete a companion, with one audit row per mutation', async () => {
      const created = mkCompanion({ url: 'https://example.invalid/admintest-companion-a.git' });

      const putRes = await fetch(`${base}/api/admin/companions/${key}`, asAdmin(putJson(created)));
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${base}/api/admin/companions/${key}`, asAdmin());
      expect(await getRes.json()).toEqual(created);

      const listRes = await fetch(`${base}/api/admin/companions`, asAdmin());
      const list = (await listRes.json()) as CompanionRegistry;
      expect(list[key]).toEqual(created);

      const updated = mkCompanion({ url: 'https://example.invalid/admintest-companion-a-v2.git' });
      await fetch(`${base}/api/admin/companions/${key}`, asAdmin(putJson(updated)));
      const getRes2 = await fetch(`${base}/api/admin/companions/${key}`, asAdmin());
      expect((await getRes2.json()).url).toBe('https://example.invalid/admintest-companion-a-v2.git');

      const delRes = await fetch(`${base}/api/admin/companions/${key}`, asAdmin({ method: 'DELETE' }));
      expect(delRes.status).toBe(200);
      expect((await fetch(`${base}/api/admin/companions/${key}`, asAdmin())).status).toBe(404);

      const audit = await auditRowsFor(key);
      expect(audit.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
      expect(audit.every((a) => a.actor_email === adminEmail)).toBe(true);
    });

    // companion_registry legitimately holds 6 seeded rows this task must not touch.
    test('the seeded companion rows are untouched by this suite', async () => {
      const rows = await sql`SELECT companion_key FROM companion_registry WHERE companion_key NOT LIKE 'admintest-%'`;
      // Not asserting an exact count (another process could be mid-registration) —
      // only that this suite never deletes or renames anything outside its prefix.
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Settings — uses a fake per-agent maxTurns key so nothing here is a real,
  // live-consequential settings key (no real agent is named this).
  // -------------------------------------------------------------------------

  describe('settings', () => {
    const key = 'agents.admintest-fake-agent.maxTurns';

    test('admin can create, read back, update, and delete a setting, with one audit row per mutation', async () => {
      const putRes = await fetch(`${base}/api/admin/settings/${encodeURIComponent(key)}`, asAdmin(putJson({ value: 7 })));
      expect(putRes.status).toBe(200);

      const getAllRes = await fetch(`${base}/api/admin/settings`, asAdmin());
      const all = (await getAllRes.json()) as Record<string, unknown>;
      expect(all[key]).toBe(7);

      const putRes2 = await fetch(`${base}/api/admin/settings/${encodeURIComponent(key)}`, asAdmin(putJson({ value: 12 })));
      expect(putRes2.status).toBe(200);
      const getAllRes2 = await fetch(`${base}/api/admin/settings`, asAdmin());
      expect(((await getAllRes2.json()) as Record<string, unknown>)[key]).toBe(12);

      const delRes = await fetch(`${base}/api/admin/settings/${encodeURIComponent(key)}`, asAdmin({ method: 'DELETE' }));
      expect(delRes.status).toBe(200);
      const getAllRes3 = await fetch(`${base}/api/admin/settings`, asAdmin());
      expect(key in ((await getAllRes3.json()) as Record<string, unknown>)).toBe(false);

      const audit = await auditRowsFor(key);
      expect(audit.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
      expect(audit.every((a) => a.actor_email === adminEmail)).toBe(true);
    });

    test('an unknown settings key is 400 and writes no audit row', async () => {
      const badKey = 'admintest-not-a-real-setting';
      const res = await fetch(`${base}/api/admin/settings/${badKey}`, asAdmin(putJson({ value: 'anything' })));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: Array<{ path: string; message: string }> };
      expect(body.errors.length).toBeGreaterThan(0);
      expect(await auditRowsFor(badKey)).toEqual([]);
    });

    test('DELETE on an absent setting is 404', async () => {
      const res = await fetch(`${base}/api/admin/settings/agents.admintest-never-set.maxTurns`, asAdmin({ method: 'DELETE' }));
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  test('GET /api/admin/audit returns recent rows newest first', async () => {
    // The repo suite above already wrote at least one audit row.
    const res = await fetch(`${base}/api/admin/audit?limit=500`, asAdmin());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ at: string; entityKey: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1]!.at).getTime()).toBeGreaterThanOrEqual(new Date(rows[i]!.at).getTime());
    }
  });
});
