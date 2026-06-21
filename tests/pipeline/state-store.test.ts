import { describe, test, expect, afterEach } from 'bun:test';
import { StateStore } from '../../src/pipeline/state-store.ts';
import type { PipelineState, PipelineConfig } from '../../src/types/pipeline.types.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function setup(): StateStore {
  tempDir = mkdtempSync(join(tmpdir(), 'state-store-test-'));
  return new StateStore(tempDir);
}

function cleanup(): void {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function freshState(): PipelineState {
  return {
    currentStage: 'analyzer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2024-01-01T00:00:00.000Z',
  };
}

function freshConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test', orgUrl: 'https://test', project: 'Test',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'T', iterationPath: 'T', pat: 'secret',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: tempDir },
    checkpoints: {
      planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
      prPublished: { fixCommand: '/f', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateStore', () => {
  afterEach(cleanup);

  test('save/load roundtrip preserves state', () => {
    const store = setup();
    const state = freshState();
    state.readiness = { verdict: 'proceed', enrichedContext: {} as any, gaps: [], summary: 'ok' };

    store.save(42, state);
    const loaded = store.load(42);

    expect(loaded).not.toBeNull();
    expect(loaded!.currentStage).toBe('analyzer');
    expect(loaded!.readiness?.verdict).toBe('proceed');
    expect(loaded!.startedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  test('load missing file returns null', () => {
    const store = setup();
    expect(store.load(999)).toBeNull();
  });

  test('config save/load roundtrip preserves non-secret fields', () => {
    const store = setup();
    const config = freshConfig();

    store.saveConfig(42, config);
    const loaded = store.loadConfig(42);

    expect(loaded).not.toBeNull();
    expect(loaded!.azureDevOps.organization).toBe('test');
  });

  test('saveConfig strips PAT from persisted config', () => {
    const store = setup();
    const config = freshConfig(); // pat: 'secret'

    store.saveConfig(42, config);
    const loaded = store.loadConfig(42);

    expect(loaded).not.toBeNull();
    expect(loaded!.azureDevOps.pat).toBe('');
  });

  test('config load missing returns null', () => {
    const store = setup();
    expect(store.loadConfig(999)).toBeNull();
  });

  test('exists returns true for saved state', () => {
    const store = setup();
    store.save(42, freshState());
    expect(store.exists(42)).toBe(true);
  });

  test('exists returns false for missing state', () => {
    const store = setup();
    expect(store.exists(42)).toBe(false);
  });

  test('createInitial creates valid fresh state', () => {
    const state = StateStore.createInitial('analyzer');
    expect(state.currentStage).toBe('analyzer');
    expect(state.telemetry.totalCostUsd).toBe(0);
    expect(state.startedAt).toBeDefined();
  });

  test('listAll returns work item IDs from state files', () => {
    const store = setup();
    store.save(42, freshState());
    store.save(100, freshState());
    store.saveConfig(42, freshConfig());

    const ids = store.listAll();
    expect(ids.sort((a, b) => a - b)).toEqual([42, 100]);
  });

  test('listAll excludes config files', () => {
    const store = setup();
    // Only save a config, no state
    store.saveConfig(42, freshConfig());

    const ids = store.listAll();
    expect(ids).toEqual([]);
  });

  test('listAll returns empty array for nonexistent dir', () => {
    const store = new StateStore(join(tempDir ?? tmpdir(), 'nonexistent-dir'));
    expect(store.listAll()).toEqual([]);
  });

  test('listAll ignores non-numeric filenames', () => {
    const store = setup();
    store.save(7, freshState());
    // Write a non-numeric json file directly
    writeFileSync(join(tempDir, 'notes.json'), '{}');

    const ids = store.listAll();
    expect(ids).toEqual([7]);
  });
});
