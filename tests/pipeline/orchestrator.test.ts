import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { runPipeline } from '../../src/pipeline/orchestrator.ts';
import { StateStore } from '../../src/pipeline/state-store.ts';
import type { Stage, PipelineState, PipelineContext, PipelineConfig } from '../../src/types/pipeline.types.ts';
import { PipelineError, AgentExecutionError } from '../../src/sdk/errors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'test-repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
      iterationPath: 'Test',
      pat: 'test-pat',
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
    workItem: {
      id: 1, title: 'Test', type: 'Bug', state: 'Active',
      areaPath: 'Test', iterationPath: 'Test', fields: {},
    },
    workItemType: 'Bug',
    config: mockConfig(),
  };
}

function mockStage(name: string, effect?: (s: PipelineState) => PipelineState): Stage {
  return {
    name,
    canRun: () => true,
    execute: async (state) => effect ? effect(state) : state,
  };
}

function mockStateStore(): StateStore {
  const store = new StateStore('/tmp/test-state-' + Math.random().toString(36).slice(2));
  // Override load to return null (fresh state) by default
  const origLoad = store.load.bind(store);
  store.load = () => null;
  store.save = () => {};
  store.saveConfig = () => {};
  store.loadConfig = () => null;
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  test('normal progression through 3 mock stages', async () => {
    const stages = [
      mockStage('a', (s) => ({ ...s, readiness: { verdict: 'proceed' } } as PipelineState)),
      mockStage('b'),
      mockStage('c'),
    ];

    const result = await runPipeline({
      stages,
      context: mockContext(),
      stateStore: mockStateStore(),
    });

    expect(result.completedAt).toBeDefined();
  });

  test('resumes from persisted state at stage 2', async () => {
    const executedStages: string[] = [];
    const stages = [
      mockStage('a', (s) => { executedStages.push('a'); return s; }),
      mockStage('b', (s) => { executedStages.push('b'); return s; }),
      mockStage('c', (s) => { executedStages.push('c'); return s; }),
    ];

    const store = mockStateStore();
    store.load = () => ({
      currentStage: 'b',
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
    });

    await runPipeline({ stages, context: mockContext(), stateStore: store });

    expect(executedStages).toEqual(['b', 'c']);
  });

  test('stops at checkpoint, resumes on re-run', async () => {
    const stages = [
      mockStage('a'),
      mockStage('checkpoint', (s) => ({
        ...s,
        checkpoint: { name: 'test-cp', enteredAt: new Date().toISOString() },
      })),
      mockStage('c'),
    ];

    const result = await runPipeline({
      stages,
      context: mockContext(),
      stateStore: mockStateStore(),
    });

    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.name).toBe('test-cp');
    expect(result.completedAt).toBeUndefined();
  });

  test('rewind on revision feedback targets correct stage', async () => {
    const executedStages: string[] = [];
    let callCount = 0;

    const stages = [
      mockStage('planning', (s) => { executedStages.push('planning'); return s; }),
      mockStage('coding', (s) => { executedStages.push('coding'); return s; }),
      mockStage('review', (s) => {
        executedStages.push('review');
        callCount++;
        // First time: request revision; second time: no feedback
        if (callCount === 1) {
          return {
            ...s,
            revisionFeedback: { source: 'work-item-comment' as const, feedback: 'fix it', targetStage: 'coding' },
          };
        }
        return s;
      }),
    ];

    const result = await runPipeline({
      stages,
      context: mockContext(),
      stateStore: mockStateStore(),
    });

    // Should run: planning, coding, review (rewind), coding, review
    expect(executedStages).toEqual(['planning', 'coding', 'review', 'coding', 'review']);
    expect(result.completedAt).toBeDefined();
  });

  test('rewind with invalid stage name logs warning, does not restart from 0', async () => {
    const executedStages: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const stages = [
      mockStage('a', (s) => { executedStages.push('a'); return s; }),
      mockStage('b', (s) => {
        executedStages.push('b');
        return {
          ...s,
          revisionFeedback: { source: 'work-item-comment' as const, feedback: 'fix', targetStage: 'nonexistent' },
        };
      }),
      mockStage('c', (s) => { executedStages.push('c'); return s; }),
    ];

    await runPipeline({ stages, context: mockContext(), stateStore: mockStateStore() });

    // Should NOT re-run 'a' — just log warning and continue
    expect(executedStages).toEqual(['a', 'b', 'c']);
    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.flat().join(' ');
    expect(calls).toContain('nonexistent');

    warnSpy.mockRestore();
  });

  test('error in stage persists error state and rethrows', async () => {
    const savedStates: PipelineState[] = [];
    const store = mockStateStore();
    store.save = (_id: number, s: PipelineState) => { savedStates.push(structuredClone(s)); };

    const stages = [
      mockStage('a'),
      {
        name: 'failing',
        canRun: () => true,
        execute: async () => { throw new PipelineError('test', 'failing', 'boom'); },
      } satisfies Stage,
    ];

    await expect(
      runPipeline({ stages, context: mockContext(), stateStore: store }),
    ).rejects.toThrow('boom');

    const errorState = savedStates.find(s => s.error);
    expect(errorState).toBeDefined();
    expect(errorState!.error!.stage).toBe('failing');
    expect(errorState!.error!.message).toBe('boom');
  });

  test('pipeline completes and sets completedAt', async () => {
    const result = await runPipeline({
      stages: [mockStage('only')],
      context: mockContext(),
      stateStore: mockStateStore(),
    });

    expect(result.completedAt).toBeDefined();
    expect(typeof result.completedAt).toBe('string');
  });

  test('onError callback is called when a stage throws', async () => {
    const onErrorCalls: { stageName: string; message: string }[] = [];

    const stages = [
      mockStage('a'),
      {
        name: 'failing',
        canRun: () => true,
        execute: async () => { throw new PipelineError('test', 'failing', 'boom'); },
      } satisfies Stage,
    ];

    await expect(
      runPipeline({
        stages,
        context: mockContext(),
        stateStore: mockStateStore(),
        onError: async (stage, _state, error) => {
          onErrorCalls.push({ stageName: stage.name, message: error.message });
        },
      }),
    ).rejects.toThrow('boom');

    expect(onErrorCalls).toEqual([{ stageName: 'failing', message: 'boom' }]);
  });

  test('error state includes subtype and cost details from AgentExecutionError', async () => {
    const savedStates: PipelineState[] = [];
    const store = mockStateStore();
    store.save = (_id: number, s: PipelineState) => { savedStates.push(structuredClone(s)); };

    const stages = [
      {
        name: 'coder',
        canRun: () => true,
        execute: async () => {
          throw new AgentExecutionError('coder', {
            subtype: 'error_max_turns',
            errors: ['Reached maximum turns'],
            costUsd: 5.42,
            durationMs: 28800000,
            turns: 150,
          });
        },
      } satisfies Stage,
    ];

    await expect(
      runPipeline({ stages, context: mockContext(), stateStore: store }),
    ).rejects.toThrow();

    const errorState = savedStates.find(s => s.error);
    expect(errorState).toBeDefined();
    expect(errorState!.error!.stage).toBe('coder');
    expect(errorState!.error!.subtype).toBe('error_max_turns');
    expect(errorState!.error!.costUsd).toBe(5.42);
    expect(errorState!.error!.durationMs).toBe(28800000);
    expect(errorState!.error!.turns).toBe(150);
  });

  test('onError failure does not suppress the original error', async () => {
    const stages = [
      {
        name: 'failing',
        canRun: () => true,
        execute: async () => { throw new Error('original'); },
      } satisfies Stage,
    ];

    await expect(
      runPipeline({
        stages,
        context: mockContext(),
        stateStore: mockStateStore(),
        onError: async () => { throw new Error('callback exploded'); },
      }),
    ).rejects.toThrow('original');
  });

  test('humanFeedback survives orchestrator rewind (not cleared with revisionFeedback)', async () => {
    const executedStages: string[] = [];
    let codingCallCount = 0;

    const stages = [
      mockStage('planning', (s) => { executedStages.push('planning'); return s; }),
      mockStage('coding', (s) => {
        executedStages.push('coding');
        codingCallCount++;
        // Verify humanFeedback is present on first coding run after rewind
        if (codingCallCount === 2) {
          // This is the re-run after rewind — humanFeedback should still be there
          expect(s.humanFeedback).toBeDefined();
          expect(s.humanFeedback!.rerunComment).toBe('/fix fix it');
        }
        return s;
      }),
      mockStage('review', (s) => {
        executedStages.push('review');
        // First time: request revision; second time: proceed
        if (executedStages.filter(n => n === 'review').length === 1) {
          return {
            ...s,
            revisionFeedback: { source: 'pr-comment' as const, feedback: '/fix fix it', targetStage: 'coding' },
            humanFeedback: { rerunComment: '/fix fix it', source: 'pr-comment' as const },
          };
        }
        return s;
      }),
    ];

    const result = await runPipeline({
      stages,
      context: mockContext(),
      stateStore: mockStateStore(),
    });

    // Should run: planning, coding, review (rewind), coding (with humanFeedback), review
    expect(executedStages).toEqual(['planning', 'coding', 'review', 'coding', 'review']);
    expect(result.completedAt).toBeDefined();
  });

  test('records partial telemetry from failed agent stage', async () => {
    const savedStates: PipelineState[] = [];
    const store = mockStateStore();
    store.save = (_id: number, s: PipelineState) => { savedStates.push(structuredClone(s)); };

    const stages: Stage[] = [
      {
        name: 'coder',
        canRun: () => true,
        execute: async (state) => {
          const err = new AgentExecutionError('coder', {
            subtype: 'error_max_turns',
            errors: [],
            costUsd: 5.42,
            durationMs: 28800000,
            turns: 150,
          });
          err.partialTelemetry = {
            name: 'coder',
            costUsd: 5.42,
            durationMs: 28800000,
            turns: 150,
            model: 'claude-sonnet-4-6',
            startedAt: state.startedAt,
            timestamp: new Date().toISOString(),
            toolCalls: {},
          };
          throw err;
        },
      },
    ];

    await expect(
      runPipeline({ stages, context: mockContext(), stateStore: store }),
    ).rejects.toThrow();

    const errorState = savedStates.find(s => s.error);
    expect(errorState).toBeDefined();
    expect(errorState!.telemetry.stages).toHaveLength(1);
    expect(errorState!.telemetry.stages[0]!.name).toBe('coder');
    expect(errorState!.telemetry.stages[0]!.costUsd).toBe(5.42);
    expect(errorState!.telemetry.totalCostUsd).toBe(5.42);
  });

  test('strips a stale activeAgent marker left by a crashed run', async () => {
    const saved: PipelineState[] = [];
    const fakeStore = {
      load: () => ({
        currentStage: 'a',
        telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
        startedAt: '2024-01-01T00:00:00.000Z',
        activeAgent: { name: 'plan-reviewer', loop: 'planning', role: 'reviewer', iteration: 2, startedAt: '2024-01-01T00:00:00.000Z' },
      }),
      save: (_id: number, s: PipelineState) => { saved.push(s); },
      saveConfig: () => {},
      loadConfig: () => null,
      exists: () => true,
      listAll: () => [],
    } as unknown as StateStore;

    const stages = [mockStage('a'), mockStage('b')];
    await runPipeline({ stages, context: mockContext(), stateStore: fakeStore });

    // Every persisted state must have the marker stripped.
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((s) => s.activeAgent === undefined)).toBe(true);
  });

  test('reportActiveAgent persists a marker with currentStage = stage name', async () => {
    const saved: PipelineState[] = [];
    const fakeStore = {
      load: () => null,
      save: (_id: number, s: PipelineState) => { saved.push(structuredClone(s)); },
      saveConfig: () => {}, loadConfig: () => null, exists: () => false, listAll: () => [],
    } as unknown as StateStore;

    const reporting = mockStage('planning', (s) => s);
    reporting.execute = async (s, ctx) => {
      await ctx.reportActiveAgent?.(s, { name: 'plan-reviewer', loop: 'planning', role: 'reviewer', iteration: 1, startedAt: '2024-01-01T00:00:00.000Z' });
      return s;
    };

    await runPipeline({ stages: [reporting], context: mockContext(), stateStore: fakeStore });

    const withMarker = saved.find((s) => s.activeAgent?.role === 'reviewer');
    expect(withMarker).toBeDefined();
    expect(withMarker!.currentStage).toBe('planning');
    expect(withMarker!.activeAgent!.loop).toBe('planning');
  });

  test('reportActiveAgent ignores a marker whose loop != current stage name', async () => {
    const saved: PipelineState[] = [];
    const fakeStore = {
      load: () => null,
      save: (_id: number, s: PipelineState) => { saved.push(structuredClone(s)); },
      saveConfig: () => {}, loadConfig: () => null, exists: () => false, listAll: () => [],
    } as unknown as StateStore;

    const stage = mockStage('coding', (s) => s);
    stage.execute = async (s, ctx) => {
      await ctx.reportActiveAgent?.(s, { name: 'x', loop: 'planning', role: 'reviewer', iteration: 1, startedAt: '2024-01-01T00:00:00.000Z' });
      return s;
    };

    await runPipeline({ stages: [stage], context: mockContext(), stateStore: fakeStore });
    expect(saved.some((s) => s.activeAgent !== undefined)).toBe(false);
  });

  test('reportActiveAgent is best-effort: a failing save does not fail the run', async () => {
    let calls = 0;
    const fakeStore = {
      load: () => null,
      save: () => { calls++; if (calls === 2) throw new Error('db down'); },
      saveConfig: () => {}, loadConfig: () => null, exists: () => false, listAll: () => [],
    } as unknown as StateStore;

    let executed = false;
    const stage = mockStage('planning');
    stage.execute = async (s, ctx) => {
      await ctx.reportActiveAgent?.(s, { name: 'p', loop: 'planning', role: 'producer', iteration: 1, startedAt: '2024-01-01T00:00:00.000Z' });
      executed = true;
      return s;
    };

    const result = await runPipeline({ stages: [stage], context: mockContext(), stateStore: fakeStore });
    expect(executed).toBe(true);
    expect(result.completedAt).toBeDefined();
  });

  test('reportActiveAgent captured during a stage is a no-op after the stage returns', async () => {
    const saved: PipelineState[] = [];
    const fakeStore = {
      load: () => null,
      save: (_id: number, s: PipelineState) => { saved.push(structuredClone(s)); },
      saveConfig: () => {}, loadConfig: () => null, exists: () => false, listAll: () => [],
    } as unknown as StateStore;

    let captured: PipelineContext['reportActiveAgent'];
    const stage = mockStage('planning');
    stage.execute = async (s, ctx) => { captured = ctx.reportActiveAgent; return s; };

    await runPipeline({ stages: [stage], context: mockContext(), stateStore: fakeStore });
    const before = saved.length;
    await captured?.({ currentStage: 'planning', telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] }, startedAt: 'x' } as PipelineState,
      { name: 'late', loop: 'planning', role: 'reviewer', iteration: 1, startedAt: '2024-01-01T00:00:00.000Z' });
    expect(saved.length).toBe(before); // stageActive guard rejected the late call
  });

  test('initial revision feedback with invalid target logs warning and skips rewind', async () => {
    const executedStages: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const store = mockStateStore();
    store.load = () => ({
      currentStage: 'b',
      revisionFeedback: { source: 'work-item-comment' as const, feedback: 'fix', targetStage: 'nonexistent' },
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
    });

    const stages = [
      mockStage('a', (s) => { executedStages.push('a'); return s; }),
      mockStage('b', (s) => { executedStages.push('b'); return s; }),
      mockStage('c', (s) => { executedStages.push('c'); return s; }),
    ];

    await runPipeline({ stages, context: mockContext(), stateStore: store });

    // Should resume from 'b' (not rewind since target doesn't exist)
    expect(executedStages).toEqual(['b', 'c']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
