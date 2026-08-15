import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startDashboard, type DashboardHandle } from '../../src/dashboard/server.ts';
import { hashPassword } from '../../src/auth/local-provider.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { FakeUserStore, FakeSessionStore, FakeAuthEventStore } from '../auth/fakes.ts';
import type { IStateStore } from '../../src/pipeline/state-store.interface.ts';
import type { IActionStore, ActionRecord } from '../../src/pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../../src/pipeline/runner-status.interface.ts';
import type { ILogSink } from '../../src/pipeline/log-sink.interface.ts';
import type { IPRReviewStore, PRReviewRow } from '../../src/pipeline/pr-review-store.interface.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';
import type { IAuditStore, AuditRow } from '../../src/config/audit-store.interface.ts';
import { FakeRegistryStore } from '../config/fixtures/fake-registry-store.ts';
import { FakeReflectionStore } from '../pipeline/reflection-store.test.ts';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { _resetHydrationState } from '../../src/config/hydrate.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// This suite proves the thing Task 8 actually added: the gate in
// startDashboard's fetch handler sits above every route, in the right order
// (auth -> role -> origin), and stays there. Everything below is a real HTTP
// round trip against a real `Bun.serve` instance on an ephemeral port — not a
// call into an exported helper — because a future change that slips a new
// route in ABOVE the gate, or drops the `!user` check, would still pass every
// existing unit test (they don't touch server.ts at all) but must fail here.
//
// The non-auth stores below are thin stand-ins. The unauthenticated-path
// assertions never reach any of them (the gate returns before dispatch); the
// one authenticated case that does — POST /api/runners as admin — only needs
// StubSettingsStore.set to not throw.
//
// server.ts's fetch handler now calls refreshRegistry() before the gate runs
// (registry hydration), which reads/replaces the real, process-global
// `repos` / `companionRegistry` singletons and the module-level hydration
// clock in src/config/hydrate.ts — every fetch() call in this file exercises
// that, using an unseeded FakeRegistryStore. Snapshot/restore + resetting the
// clock (same pattern as tests/config/hydrate.test.ts) keeps that side
// effect from leaking into whichever test file bun runs next, and keeps this
// suite's own pass/fail about authentication, never about registry state.
// ---------------------------------------------------------------------------

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

class StubSettingsStore implements ISettingsStore {
  async getAll(): Promise<Record<string, unknown>> { return {}; }
  async get<T>(): Promise<T | null> { return null; }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

class StubAuditStore implements IAuditStore {
  async list(): Promise<AuditRow[]> { return []; }
  async write(): Promise<void> {}
}

describe('dashboard auth gate (real HTTP round trip)', () => {
  let handle: DashboardHandle;
  let base: string;
  let operatorCookie: string;
  let adminCookie: string;
  let repoSnapshot: RepoRegistry;
  let companionSnapshot: CompanionRegistry;

  beforeAll(async () => {
    // Snapshot before startDashboard/loginAs make their first request — the
    // very first fetch() below already runs refreshRegistry() on the way in.
    repoSnapshot = { ...repos };
    companionSnapshot = { ...companionRegistry };
    _resetHydrationState();

    const userStore = new FakeUserStore();
    const sessionStore = new FakeSessionStore();
    await userStore.create({ email: 'op@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('op-password-1') });
    await userStore.create({ email: 'admin@x.y', displayName: 'Admin', role: 'admin', passwordHash: await hashPassword('admin-password-1') });

    handle = startDashboard({
      port: 0, // ephemeral — Bun assigns a free port, read back below
      stateStore: new StubStateStore(),
      actionStore: new StubActionStore(),
      runnerStatus: new StubRunnerStatus(),
      logSink: () => stubLogSink(),
      prReviewStore: new StubPRReviewStore(),
      prReviewLogSink: () => stubLogSink(),
      sql: {} as postgres.Sql,
      userStore,
      sessionStore,
      authEventStore: new FakeAuthEventStore(),
      registryStore: new FakeRegistryStore(),
      settingsStore: new StubSettingsStore(),
      auditStore: new StubAuditStore(),
      reflectionStore: new FakeReflectionStore(),
    });
    base = `http://localhost:${handle.server.port}`;

    // Log in through the REAL endpoint rather than seeding the session store
    // directly — this exercises the exact cookie a real browser would present
    // (handleLogin's hashing + Set-Cookie shape), not just a hand-built token.
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
    operatorCookie = await loginAs('op@x.y', 'op-password-1');
    adminCookie = await loginAs('admin@x.y', 'admin-password-1');
  });

  afterAll(() => {
    handle.stop();
    replaceRepos(repoSnapshot);
    replaceCompanions(companionSnapshot);
  });

  test('public shell is reachable without a cookie', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });

  test('a representative sample of the default-deny surface requires a session', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/actions`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });

  test('POST /api/runners is admin-gated: 401 unauthenticated, 403 for an operator, allowed for admin', async () => {
    expect((await fetch(`${base}/api/runners`, { method: 'POST' })).status).toBe(401);

    const asOperator = await fetch(`${base}/api/runners`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${operatorCookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 3 }),
    });
    expect(asOperator.status).toBe(403);

    const asAdmin = await fetch(`${base}/api/runners`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${adminCookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 3 }),
    });
    expect(asAdmin.status).not.toBe(401);
    expect(asAdmin.status).not.toBe(403);
  });

  test('the two pre-gate routes stay reachable without a cookie', async () => {
    expect((await fetch(`${base}/api/auth/status`)).status).toBe(200);

    // Reachable (not blocked by the gate) — the credentials are wrong, so 401
    // is handleLogin's own answer, not a gate rejection.
    const loginProbe = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@x.y', password: 'wrong' }),
    });
    expect(loginProbe.status).toBe(401);
  });

  test('an authenticated non-GET request with a mismatched Origin is rejected', async () => {
    const res = await fetch(`${base}/api/actions`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${operatorCookie}`,
        'Content-Type': 'application/json',
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ workItemId: 1, type: 'continue' }),
    });
    expect(res.status).toBe(403);
  });

  test('a foreign Origin on login is rejected before credentials are even checked', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ email: 'op@x.y', password: 'op-password-1' }),
    });
    expect(res.status).toBe(403);
  });
});
