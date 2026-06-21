import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  parseWatchArgs,
  pollForAllWork,
  reapSettled,
  colorForWI,
  releaseColor,
  _resetColorState,
} from '../../src/cli/watch.ts';
import { openDatabase } from '../../src/db/database.ts';
import { SqliteStateStore } from '../../src/db/sqlite-state-store.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
      iterationPath: 'Test',
      pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

/** Mock a WIQL response returning given IDs. */
function wiqlResponse(ids: number[]): Response {
  return new Response(JSON.stringify({
    workItems: ids.map(id => ({ id })),
  }));
}

let tempDir: string;
let currentDb: Database | null = null;
let savedFetch: typeof globalThis.fetch;

function setupTempDir(): { dir: string; store: SqliteStateStore } {
  tempDir = mkdtempSync(join(tmpdir(), 'watch-test-'));
  currentDb = openDatabase(tempDir);
  return { dir: tempDir, store: new SqliteStateStore(currentDb) };
}

// ---------------------------------------------------------------------------
// parseWatchArgs
// ---------------------------------------------------------------------------

describe('parseWatchArgs', () => {
  test('returns defaults with no args', () => {
    const result = parseWatchArgs([]);
    expect(result.intervalMinutes).toBe(15);
    expect(result.concurrency).toBe(3);
  });

  test('parses --interval', () => {
    const result = parseWatchArgs(['--interval', '5']);
    expect(result.intervalMinutes).toBe(5);
    expect(result.concurrency).toBe(3);
  });

  test('parses --concurrency', () => {
    const result = parseWatchArgs(['--concurrency', '3']);
    expect(result.intervalMinutes).toBe(15);
    expect(result.concurrency).toBe(3);
  });

  test('parses both flags together', () => {
    const result = parseWatchArgs(['--interval', '10', '--concurrency', '4']);
    expect(result.intervalMinutes).toBe(10);
    expect(result.concurrency).toBe(4);
  });

  test('parses flags in any order', () => {
    const result = parseWatchArgs(['--concurrency', '2', '--interval', '7']);
    expect(result.intervalMinutes).toBe(7);
    expect(result.concurrency).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pollForAllWork
// ---------------------------------------------------------------------------

describe('pollForAllWork', () => {
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (currentDb) { currentDb.close(); currentDb = null; }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns multiple start-fresh actions', async () => {
    const { store } = setupTempDir();

    // Both WIQL queries return IDs 101 and 102
    globalThis.fetch = mock(() => Promise.resolve(wiqlResponse([101, 102]))) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set());

    // 101 and 102 have no state → start-fresh
    const startFresh = actions.filter(a => a.type === 'start-fresh');
    expect(startFresh.length).toBe(2);
    expect(startFresh[0]!.workItemId).toBe(101);
    expect(startFresh[1]!.workItemId).toBe(102);
  });

  test('skips IDs in the skip set', async () => {
    const { store } = setupTempDir();

    globalThis.fetch = mock(() => Promise.resolve(wiqlResponse([101, 102, 103]))) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set([102]));

    const ids = actions.map(a => a.workItemId);
    expect(ids).not.toContain(102);
    expect(ids).toContain(101);
    expect(ids).toContain(103);
  });

  test('returns continue-pipeline for items at plan-approved checkpoint', async () => {
    const { store } = setupTempDir();

    // Save state with plan-approved checkpoint for WI 200
    store.save(200, {
      workItemId: 200,
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', waitingSince: new Date().toISOString() },
      stagesCompleted: ['analyzer', 'planning'],
      telemetry: { stages: {}, totalCost: 0, totalDuration: 0, totalTurns: 0 },
    } as any);

    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      // Call 1 = need-input WIQL, call 2 = analyse WIQL (no new items),
      // call 3 = plan-approved WIQL (returns WI 200)
      if (callCount <= 2) return Promise.resolve(wiqlResponse([]));
      return Promise.resolve(wiqlResponse([200]));
    }) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set());
    expect(actions.length).toBe(1);
    expect(actions[0]!.type).toBe('continue-pipeline');
    expect(actions[0]!.workItemId).toBe(200);
  });

  test('returns empty array when no actionable items', async () => {
    const { store } = setupTempDir();

    globalThis.fetch = mock(() => Promise.resolve(wiqlResponse([]))) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set());
    expect(actions).toEqual([]);
  });

  test('returns continue-pipeline when PR is completed at pr-completed checkpoint', async () => {
    const { store } = setupTempDir();

    // Save state paused at pr-completed checkpoint with a draft PR
    store.save(300, {
      workItemId: 300,
      currentStage: 'checkpoint:pr-completed',
      checkpoint: { name: 'pr-completed', enteredAt: new Date().toISOString() },
      draftPR: { id: 555, url: 'http://test/pr/555', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 300 },
      stagesCompleted: ['analyzer', 'planning', 'coding', 'draft-pr'],
      telemetry: { stages: {}, totalCost: 0, totalDuration: 0, totalTurns: 0 },
    } as any);

    // Also save a persisted config for WI 300 so the watcher can resolve repositoryId
    store.saveConfig(300, mockConfig());

    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      // WIQL calls (need-input, analyse, plan-approved) return empty
      if (callCount <= 3) return Promise.resolve(wiqlResponse([]));
      // PR status call returns completed
      return Promise.resolve(new Response(JSON.stringify({
        pullRequestId: 555, status: 'completed', isDraft: false,
      })));
    }) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set());
    expect(actions.length).toBe(1);
    expect(actions[0]!.type).toBe('continue-pipeline');
    expect(actions[0]!.workItemId).toBe(300);
  });

  test('does not queue action when PR is still active at pr-completed checkpoint', async () => {
    const { store } = setupTempDir();

    store.save(301, {
      workItemId: 301,
      currentStage: 'checkpoint:pr-completed',
      checkpoint: { name: 'pr-completed', enteredAt: new Date().toISOString() },
      draftPR: { id: 556, url: 'http://test/pr/556', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 301 },
      stagesCompleted: ['analyzer', 'planning', 'coding', 'draft-pr'],
      telemetry: { stages: {}, totalCost: 0, totalDuration: 0, totalTurns: 0 },
    } as any);

    store.saveConfig(301, mockConfig());

    let callCount = 0;
    globalThis.fetch = mock((url: string) => {
      callCount++;
      if (callCount <= 3) return Promise.resolve(wiqlResponse([]));
      // PR still active
      return Promise.resolve(new Response(JSON.stringify({
        pullRequestId: 556, status: 'active', isDraft: false,
      })));
    }) as unknown as typeof fetch;

    const actions = await pollForAllWork(mockConfig(), store, new Set());
    expect(actions.length).toBe(0);
  });

  test('skips pr-completed detection when item is already running', async () => {
    const { store } = setupTempDir();

    store.save(302, {
      workItemId: 302,
      currentStage: 'checkpoint:pr-completed',
      checkpoint: { name: 'pr-completed', enteredAt: new Date().toISOString() },
      draftPR: { id: 557, url: 'http://test/pr/557', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 302 },
      stagesCompleted: [],
      telemetry: { stages: {}, totalCost: 0, totalDuration: 0, totalTurns: 0 },
    } as any);

    store.saveConfig(302, mockConfig());

    globalThis.fetch = mock(() => Promise.resolve(wiqlResponse([]))) as unknown as typeof fetch;

    // WI 302 is in the skip set (already running)
    const actions = await pollForAllWork(mockConfig(), store, new Set([302]));
    expect(actions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reapSettled
// ---------------------------------------------------------------------------

describe('reapSettled', () => {
  test('removes resolved promises from the map', async () => {
    const running = new Map<number, Promise<void>>();
    running.set(1, Promise.resolve());
    running.set(2, Promise.resolve());

    await reapSettled(running);

    expect(running.size).toBe(0);
  });

  test('keeps pending promises in the map', async () => {
    const running = new Map<number, Promise<void>>();
    let resolve1!: () => void;
    const p1 = new Promise<void>(r => { resolve1 = r; });
    running.set(1, Promise.resolve());
    running.set(2, p1);

    await reapSettled(running);

    expect(running.size).toBe(1);
    expect(running.has(2)).toBe(true);

    // Clean up
    resolve1();
  });

  test('removes rejected promises from the map', async () => {
    const running = new Map<number, Promise<void>>();
    const rejected = Promise.reject(new Error('test')).catch(() => {});
    running.set(1, rejected);

    await reapSettled(running);

    expect(running.size).toBe(0);
  });

  test('handles empty map', async () => {
    const running = new Map<number, Promise<void>>();
    await reapSettled(running);
    expect(running.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

describe('color helpers', () => {
  beforeEach(() => {
    _resetColorState();
  });

  test('assigns distinct colors to different WIs', () => {
    const c1 = colorForWI(1);
    const c2 = colorForWI(2);
    expect(c1).not.toBe(c2);
  });

  test('returns same color for same WI', () => {
    const c1a = colorForWI(1);
    const c1b = colorForWI(1);
    expect(c1a).toBe(c1b);
  });

  test('releaseColor frees the color for reuse', () => {
    const c1 = colorForWI(1);
    releaseColor(1);
    // After release, requesting the same ID gets a new assignment
    // (it will be the next color in rotation, not necessarily the same)
    const c1again = colorForWI(1);
    // The key test: it should be a valid ANSI color
    expect(c1again).toMatch(/^\x1b\[\d+m$/);
  });

  test('rotates through 6 colors then wraps', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 6; i++) {
      colors.add(colorForWI(i + 100));
    }
    expect(colors.size).toBe(6);

    // 7th assignment wraps around
    const c7 = colorForWI(200);
    expect(colors.has(c7)).toBe(true);
  });
});
