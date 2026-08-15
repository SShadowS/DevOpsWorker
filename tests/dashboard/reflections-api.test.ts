import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type postgres from 'postgres';
import { startDashboard, type DashboardHandle } from '../../src/dashboard/server.ts';
import { hashPassword } from '../../src/auth/local-provider.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { FakeUserStore, FakeSessionStore, FakeAuthEventStore } from '../auth/fakes.ts';
import { FakeRegistryStore } from '../config/fixtures/fake-registry-store.ts';
import { FakeReflectionStore } from '../pipeline/reflection-store.test.ts';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { _resetHydrationState } from '../../src/config/hydrate.ts';
import type { IStateStore } from '../../src/pipeline/state-store.interface.ts';
import type { IActionStore, ActionRecord } from '../../src/pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../../src/pipeline/runner-status.interface.ts';
import type { ILogSink } from '../../src/pipeline/log-sink.interface.ts';
import type { IPRReviewStore, PRReviewRow } from '../../src/pipeline/pr-review-store.interface.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';
import type { IAuditStore, AuditRow } from '../../src/config/audit-store.interface.ts';
import type { IReflectionStore } from '../../src/pipeline/reflection-store.interface.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';

// ---------------------------------------------------------------------------
// Task 6: /api/reflections (list) and /api/reflections/:id/decision
// (approve/reject). Reuses auth-gate.test.ts's harness: a real Bun.serve
// instance on an ephemeral port, thin stub stores for everything this suite
// doesn't exercise, and login through the real /api/auth/login endpoint
// rather than a hand-built cookie. The reflection store is the in-memory
// FakeReflectionStore already proven against the IReflectionStore contract
// in tests/pipeline/reflection-store.test.ts (Task 2) — reused here rather
// than reinvented. The audit store is a small recording fake so the
// decision route's audit_log write can be asserted on shape, not just "did
// not throw".
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

/** Records every write so a test can assert on its shape, rather than a
 *  StubAuditStore that silently discards it (as auth-gate.test.ts's does —
 *  fine there, since that suite never exercises a route that writes one). */
class RecordingAuditStore implements IAuditStore {
  written: Array<Omit<AuditRow, 'id' | 'at'>> = [];
  async list(): Promise<AuditRow[]> { return []; }
  async write(entry: Omit<AuditRow, 'id' | 'at'>): Promise<void> {
    this.written.push(entry);
  }
}

/** A `decide()` that always throws — stands in for a genuine store/DB
 *  failure (a dropped connection, a constraint violation, whatever). Used to
 *  prove the decision route's second try/catch (the one wrapping the store
 *  work) reports this as a 500, distinct from the first try/catch (the JSON
 *  parse), which must never see it. */
class ThrowingDecideStore extends FakeReflectionStore {
  override async decide(_id: number, _decision: 'approved' | 'rejected', _decidedBy: string): Promise<boolean> {
    throw new Error('simulated store failure');
  }
}

type SaveInput = Parameters<IReflectionStore['save']>[0];

const minimalProposal: SaveInput = {
  cycleDate: '2026-08-01', windowDays: 35, coverage: null,
  adjudications: [], clusters: [], proposedChanges: [],
  watchLedger: null, classifierNotes: null, expectedEffects: null,
  logEntryDraft: null, costUsd: null, sessionId: null, error: null,
};

describe('reflections API (real server, fake reflection + audit stores)', () => {
  let handle: DashboardHandle;
  let base: string;
  let operatorCookie: string;
  let reflectionStore: FakeReflectionStore;
  let auditStore: RecordingAuditStore;
  let repoSnapshot: RepoRegistry;
  let companionSnapshot: CompanionRegistry;

  beforeAll(async () => {
    // Same snapshot/reset dance as auth-gate.test.ts — every fetch() below
    // runs refreshRegistry() on the way in, against the process-global
    // repos/companionRegistry singletons.
    repoSnapshot = { ...repos };
    companionSnapshot = { ...companionRegistry };
    _resetHydrationState();

    const userStore = new FakeUserStore();
    const sessionStore = new FakeSessionStore();
    await userStore.create({ email: 'op@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('op-password-1') });

    reflectionStore = new FakeReflectionStore();
    auditStore = new RecordingAuditStore();

    handle = startDashboard({
      port: 0,
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
      auditStore,
      reflectionStore,
    });
    base = `http://localhost:${handle.server.port}`;

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'op@x.y', password: 'op-password-1' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie')!;
    operatorCookie = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;
  });

  afterAll(() => {
    handle.stop();
    replaceRepos(repoSnapshot);
    replaceCompanions(companionSnapshot);
  });

  function withCookie(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...(init.headers ?? {}), Cookie: `${SESSION_COOKIE}=${operatorCookie}` } };
  }

  function postDecision(id: number, body: unknown, init: RequestInit = {}): Promise<Response> {
    return fetch(`${base}/api/reflections/${id}/decision`, withCookie({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    }));
  }

  test('GET /api/reflections returns the mapped proposal rows', async () => {
    const a = await reflectionStore.save(minimalProposal);
    const b = await reflectionStore.save({ ...minimalProposal, cycleDate: '2026-08-08' });

    const res = await fetch(`${base}/api/reflections`, withCookie());
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<{ id: number; cycleDate: string; status: string | null }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    const row = rows.find((r) => r.id === b)!;
    expect(row.cycleDate).toBe('2026-08-08');
    expect(row.status).toBe('pending');
  });

  test('GET /api/reflections respects ?limit=', async () => {
    const res = await fetch(`${base}/api/reflections?limit=1`, withCookie());
    expect(res.status).toBe(200);
    const rows = await res.json() as unknown[];
    expect(rows.length).toBe(1);
  });

  test('POST decision approves a pending row and writes an audit entry', async () => {
    const id = await reflectionStore.save(minimalProposal);

    const res = await postDecision(id, { decision: 'approved' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await reflectionStore.findById(id);
    expect(row!.status).toBe('approved');
    expect(row!.decidedBy).toBe('op@x.y');

    const entry = auditStore.written.find((w) => w.entityKey === String(id));
    expect(entry).toBeDefined();
    expect(entry!.actorEmail).toBe('op@x.y');
    expect(entry!.entityType).toBe('reflection');
    expect(JSON.stringify(entry!.afterValue)).toContain('approved');
  });

  test('a second decision on the same row is rejected with a plain-English 409', async () => {
    const id = await reflectionStore.save(minimalProposal);
    expect((await postDecision(id, { decision: 'approved' })).status).toBe(200);

    const writesBefore = auditStore.written.length;
    const res = await postDecision(id, { decision: 'rejected' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('This proposal was already decided.');

    // No second audit row for the rejected write that never happened.
    expect(auditStore.written.length).toBe(writesBefore);
    expect((await reflectionStore.findById(id))!.status).toBe('approved');
  });

  test('deciding an unknown id returns 404', async () => {
    const res = await postDecision(999999, { decision: 'approved' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
  });

  test('a missing or invalid decision value returns 400', async () => {
    const id = await reflectionStore.save(minimalProposal);

    const missing = await postDecision(id, {});
    expect(missing.status).toBe(400);

    const invalid = await postDecision(id, { decision: 'maybe' });
    expect(invalid.status).toBe(400);

    // Neither malformed request reached the store.
    expect((await reflectionStore.findById(id))!.status).toBe('pending');
  });

  test('unauthenticated requests are rejected the same way as the rest of the API', async () => {
    const id = await reflectionStore.save(minimalProposal);
    expect((await fetch(`${base}/api/reflections`)).status).toBe(401);
    expect((await fetch(`${base}/api/reflections/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    })).status).toBe(401);
  });
});

describe('reflections API — a genuine store failure is a 500, not a 400', () => {
  let handle: DashboardHandle;
  let base: string;
  let operatorCookie: string;
  let reflectionStore: ThrowingDecideStore;
  let auditStore: RecordingAuditStore;
  let repoSnapshot: RepoRegistry;
  let companionSnapshot: CompanionRegistry;

  beforeAll(async () => {
    repoSnapshot = { ...repos };
    companionSnapshot = { ...companionRegistry };
    _resetHydrationState();

    const userStore = new FakeUserStore();
    const sessionStore = new FakeSessionStore();
    await userStore.create({ email: 'op-fail@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('op-password-1') });

    reflectionStore = new ThrowingDecideStore();
    auditStore = new RecordingAuditStore();

    handle = startDashboard({
      port: 0,
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
      auditStore,
      reflectionStore,
    });
    base = `http://localhost:${handle.server.port}`;

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'op-fail@x.y', password: 'op-password-1' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie')!;
    operatorCookie = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;
  });

  afterAll(() => {
    handle.stop();
    replaceRepos(repoSnapshot);
    replaceCompanions(companionSnapshot);
  });

  test('decide() throwing surfaces as 500 with a plain-English message, and writes no audit row', async () => {
    const id = await reflectionStore.save(minimalProposal);

    const res = await fetch(`${base}/api/reflections/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${operatorCookie}` },
      body: JSON.stringify({ decision: 'approved' }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Saving the decision failed');
    expect(auditStore.written.length).toBe(0);
  });
});
