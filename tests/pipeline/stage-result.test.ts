import { describe, test, expect } from 'bun:test';
import { runPipeline } from '../../src/pipeline/orchestrator.ts';
import { StateStore } from '../../src/pipeline/state-store.ts';
import type { Stage, StageResult, PipelineState, PipelineContext, PipelineConfig } from '../../src/types/pipeline.types.ts';
import { AgentExecutionError } from '../../src/sdk/errors.ts';

// ---------------------------------------------------------------------------
// These tests pin the NEW contract: the orchestrator's in-loop control-flow
// decision (pause / rewind) comes from the typed `StageResult.signal`, NOT
// from sniffing `state.checkpoint` / `state.revisionFeedback`. The persisted
// state fields remain the external observers' channel and are asserted here
// too, but they are deliberately NOT what makes the orchestrator halt/rewind.
// ---------------------------------------------------------------------------

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org', orgUrl: 'https://dev.azure.com/test-org', project: 'Test Project',
      repositoryId: 'test-repo-id', repositoryName: 'Test Repo', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'Test', iterationPath: 'Test', pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp/test', targetRepo: '/tmp/test/doc', stateDir: '/tmp/test/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test-model' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

function mockContext(): PipelineContext {
  return {
    workItemId: 1,
    workItem: { id: 1, title: 'Test', type: 'Bug', state: 'Active', areaPath: 'Test', iterationPath: 'Test', fields: {} },
    workItemType: 'Bug',
    config: mockConfig(),
  };
}

/** A Stage returning a typed StageResult. */
function resultStage(
  name: string,
  fn: (s: PipelineState) => StageResult,
): Stage {
  return { name, canRun: () => true, execute: async (state) => fn(state) };
}

/** A plain pass-through Stage (returns `{ state }`, no signal). */
function passStage(name: string, effect?: (s: PipelineState) => PipelineState): Stage {
  return {
    name,
    canRun: () => true,
    execute: async (state) => ({ state: effect ? effect(state) : state }),
  };
}

function mockStateStore(): StateStore {
  const store = new StateStore('/tmp/test-state-' + Math.random().toString(36).slice(2));
  store.load = () => null;
  store.save = () => {};
  store.saveConfig = () => {};
  store.loadConfig = () => null;
  return store;
}

describe('StageResult signal — pause', () => {
  test('orchestrator halts on a pause signal even with NO state.checkpoint sniffable', async () => {
    const executed: string[] = [];
    const stages: Stage[] = [
      passStage('a', (s) => { executed.push('a'); return s; }),
      // Emits ONLY a pause signal — no state.checkpoint set. Under the old
      // field-sniffing orchestrator this would NOT halt; under the signal
      // contract it must.
      resultStage('gate', (s) => { executed.push('gate'); return { state: s, signal: { kind: 'pause' } }; }),
      passStage('c', (s) => { executed.push('c'); return s; }),
    ];

    const result = await runPipeline({ stages, context: mockContext(), stateStore: mockStateStore() });

    expect(executed).toEqual(['a', 'gate']);   // 'c' must NOT run
    expect(result.completedAt).toBeUndefined();
  });

  test('pause signal returns the state with checkpoint still set for external observers', async () => {
    const stages: Stage[] = [
      resultStage('checkpoint', (s) => ({
        state: { ...s, checkpoint: { name: 'plan-approved', enteredAt: new Date().toISOString() } },
        signal: { kind: 'pause' },
      })),
      passStage('after'),
    ];

    const result = await runPipeline({ stages, context: mockContext(), stateStore: mockStateStore() });

    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.name).toBe('plan-approved');
    expect(result.completedAt).toBeUndefined();
  });
});

describe('StageResult signal — rewind', () => {
  test('orchestrator rewinds to targetStage on a rewind signal (no revisionFeedback sniffable)', async () => {
    const executed: string[] = [];
    let gateCalls = 0;
    const stages: Stage[] = [
      passStage('planning', (s) => { executed.push('planning'); return s; }),
      passStage('coding', (s) => { executed.push('coding'); return s; }),
      resultStage('review', (s) => {
        executed.push('review');
        gateCalls++;
        // First pass emits a rewind signal only (no state.revisionFeedback);
        // second pass proceeds.
        return gateCalls === 1
          ? { state: s, signal: { kind: 'rewind', targetStage: 'coding' } }
          : { state: s };
      }),
    ];

    const result = await runPipeline({ stages, context: mockContext(), stateStore: mockStateStore() });

    expect(executed).toEqual(['planning', 'coding', 'review', 'coding', 'review']);
    expect(result.completedAt).toBeDefined();
  });
});

describe('StageResult — partial state via typed error field', () => {
  test('orchestrator recovers PipelineError.partialState (typed, not monkey-patched)', async () => {
    const saved: PipelineState[] = [];
    const store = mockStateStore();
    store.save = (_id: number, s: PipelineState) => { saved.push(structuredClone(s)); };

    const accumulated: PipelineState = {
      currentStage: 'coder',
      telemetry: { totalCostUsd: 1.23, totalDurationMs: 100, stages: [] },
      startedAt: new Date().toISOString(),
      changeset: { files: ['a.al'] } as any,
    };

    const stages: Stage[] = [
      {
        name: 'coder',
        canRun: () => true,
        execute: async () => {
          const err = new AgentExecutionError('coder', 'boom');
          err.partialState = accumulated;   // typed field on the base PipelineError
          throw err;
        },
      },
    ];

    await expect(runPipeline({ stages, context: mockContext(), stateStore: store })).rejects.toThrow();

    const errorState = saved.find(s => s.error);
    expect(errorState).toBeDefined();
    // The accumulated changeset must survive into the persisted error state.
    expect(errorState!.changeset).toEqual({ files: ['a.al'] } as any);
    expect(errorState!.error!.stage).toBe('coder');
  });
});
