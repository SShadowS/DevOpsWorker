import { describe, test, expect } from 'bun:test';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import { RevisionExhaustedError } from '../../src/sdk/errors.ts';
import type { Stage, PipelineState, PipelineContext, PipelineConfig } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(): PipelineContext {
  return {
    workItemId: 1,
    workItem: {
      id: 1, title: 'Test', type: 'Bug', state: 'Active',
      areaPath: 'Test', iterationPath: 'Test', fields: {},
    },
    workItemType: 'Bug',
    config: {
      azureDevOps: {
        organization: 'test', orgUrl: 'https://test', project: 'Test',
        repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
        areaPath: 'T', iterationPath: 'T', pat: 'p',
      },
      paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
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
    },
  };
}

function freshState(): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('revisionLoop', () => {
  test('approve on first attempt (1 producer + 1 reviewer call)', async () => {
    let producerCalls = 0;
    let reviewerCalls = 0;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => { producerCalls++; return { ...s, devPlan: {} as any }; },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => {
        reviewerCalls++;
        return { ...s, planReviews: [{ verdict: 'approve' as const, feedback: 'good' }] };
      },
    };

    const loop = revisionLoop({
      name: 'planning',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
    });

    const result = await loop.execute(freshState(), mockContext());

    expect(producerCalls).toBe(1);
    expect(reviewerCalls).toBe(1);
    expect(result.planReviews?.at(-1)?.verdict).toBe('approve');
  });

  test('revise then approve (2 producer + 2 reviewer calls)', async () => {
    let producerCalls = 0;
    let reviewerCalls = 0;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => { producerCalls++; return { ...s, devPlan: {} as any }; },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => {
        reviewerCalls++;
        const verdict = reviewerCalls === 1 ? 'revise' as const : 'approve' as const;
        return {
          ...s,
          planReviews: [...(s.planReviews ?? []), { verdict, feedback: verdict === 'revise' ? 'fix it' : 'good' }],
        };
      },
    };

    const loop = revisionLoop({
      name: 'planning',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
    });

    const result = await loop.execute(freshState(), mockContext());

    expect(producerCalls).toBe(2);
    expect(reviewerCalls).toBe(2);
    expect(result.planReviews?.at(-1)?.verdict).toBe('approve');
  });

  test('circuit breaker: max attempts exhausted throws RevisionExhaustedError', async () => {
    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => s,
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        planReviews: [...(s.planReviews ?? []), { verdict: 'revise' as const, feedback: 'not good' }],
      }),
    };

    const loop = revisionLoop({
      name: 'planning',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
    });

    await expect(loop.execute(freshState(), mockContext())).rejects.toBeInstanceOf(RevisionExhaustedError);
  });

  test('resetState clears stale reviews before running loop', async () => {
    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => ({ ...s, devPlan: {} as any }),
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        planReviews: [...(s.planReviews ?? []), { verdict: 'approve' as const, feedback: 'looks good' }],
      }),
    };

    // Simulate state left over from a previous pass (stale reviews)
    const staleState: PipelineState = {
      ...freshState(),
      planReviews: [
        { verdict: 'revise' as const, feedback: 'old feedback' },
        { verdict: 'approve' as const, feedback: 'old approve' },
      ],
    };

    const loop = revisionLoop({
      name: 'planning',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
      resetState: (state) => ({ ...state, planReviews: [] }),
    });

    const result = await loop.execute(staleState, mockContext());

    // Should only contain the single review from this pass, not the stale ones
    expect(result.planReviews).toHaveLength(1);
    expect(result.planReviews![0]!.verdict).toBe('approve');
    expect(result.planReviews![0]!.feedback).toBe('looks good');
  });

  test('resetState is skipped when state.rerunMode is set', async () => {
    let producerReceivedReviews: unknown[] | undefined;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => {
        producerReceivedReviews = s.codeReviews as unknown[];
        return { ...s, changeset: {} as any };
      },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        codeReviews: [...(s.codeReviews ?? []), { verdict: 'approve' as const, feedback: 'good' }],
      }),
    };

    const stateWithFixMode: PipelineState = {
      ...freshState(),
      rerunMode: 'fix',
      codeReviews: [
        { verdict: 'approve', feedback: 'previous review' } as any,
      ],
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
      resetState: (state) => ({ ...state, codeReviews: [] }),
    });

    await loop.execute(stateWithFixMode, mockContext());

    // Producer should have seen the preserved reviews (resetState was skipped)
    expect(producerReceivedReviews).toHaveLength(1);
    expect((producerReceivedReviews![0] as any).feedback).toBe('previous review');
  });

  test('resetState is skipped when state.skipResetState is true, then flag is cleared', async () => {
    let producerReceivedReviews: unknown[] | undefined;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => {
        producerReceivedReviews = s.codeReviews as unknown[];
        return { ...s, changeset: {} as any };
      },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        codeReviews: [...(s.codeReviews ?? []), { verdict: 'approve' as const, feedback: 'good' }],
      }),
    };

    const stateWithSkipFlag: PipelineState = {
      ...freshState(),
      skipResetState: true,
      codeReviews: [
        { verdict: 'revise', feedback: 'previous review' } as any,
      ],
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
      resetState: (state) => ({ ...state, codeReviews: [] }),
    });

    const result = await loop.execute(stateWithSkipFlag, mockContext());

    // Producer should have seen the preserved reviews (resetState was skipped)
    expect(producerReceivedReviews).toHaveLength(1);
    expect((producerReceivedReviews![0] as any).feedback).toBe('previous review');
    // Flag should be cleared after use
    expect(result.skipResetState).toBeUndefined();
  });

  test('postProducer hook runs between producer and reviewer, can modify state', async () => {
    const callOrder: string[] = [];

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => {
        callOrder.push('producer');
        return { ...s, changeset: { ciResult: 'passed', ciRunId: 100 } as any };
      },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => {
        callOrder.push('reviewer');
        // Reviewer should see the modified ciResult from postProducer
        expect((s.changeset as any)?.ciResult).toBe('failed');
        return {
          ...s,
          codeReviews: [{ verdict: 'approve' as const, feedback: 'good' }],
        };
      },
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => {
        const lastReview = s.codeReviews?.at(-1);
        const ciPassed = (s.changeset as any)?.ciResult === 'passed';
        return lastReview?.verdict === 'approve' && ciPassed;
      },
      postProducer: async (s) => {
        callOrder.push('postProducer');
        return {
          ...s,
          changeset: { ...s.changeset!, ciResult: 'failed', compilationErrors: ['some error'] } as any,
        };
      },
    });

    // Loop exhausts because isApproved requires ciResult='passed', which postProducer overrides to 'failed' on every iteration
    await expect(loop.execute(freshState(), mockContext())).rejects.toBeInstanceOf(RevisionExhaustedError);

    // Verify call order: producer → postProducer → reviewer (repeated for each attempt)
    expect(callOrder.slice(0, 3)).toEqual(['producer', 'postProducer', 'reviewer']);
  });

  test('mid-loop error attaches accumulated state to the error', async () => {
    let producerCalls = 0;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => {
        producerCalls++;
        if (producerCalls === 2) throw new Error('coder crashed');
        return { ...s, changeset: { files: ['a.al'] } as any };
      },
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        codeReviews: [...(s.codeReviews ?? []), { verdict: 'revise' as const, feedback: 'fix it' }],
      }),
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
    });

    try {
      await loop.execute(freshState(), mockContext());
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.message).toBe('coder crashed');
      // The accumulated state from iteration 1 should be attached
      expect(err.lastState).toBeDefined();
      expect(err.lastState.changeset).toBeDefined();
      expect(err.lastState.codeReviews).toHaveLength(1);
      expect(err.lastState.codeReviews[0].verdict).toBe('revise');
    }
  });

  test('reports producer then reviewer markers per attempt, with correct loop/role/iteration', async () => {
    const markers: Array<{ role: string; loop: string; iteration: number; hasPlan: boolean }> = [];

    const producer: Stage = {
      name: 'planner', canRun: () => true,
      execute: async (s) => ({ ...s, devPlan: {} as any }),
    };
    const reviewer: Stage = {
      name: 'plan-reviewer', canRun: () => true,
      execute: async (s) => {
        const verdict = (s.planReviews?.length ?? 0) === 0 ? 'revise' as const : 'approve' as const;
        return { ...s, planReviews: [...(s.planReviews ?? []), { verdict, feedback: 'f' }] };
      },
    };

    const ctx = mockContext();
    ctx.reportActiveAgent = async (s, marker) => {
      if (marker) markers.push({ role: marker.role, loop: marker.loop, iteration: marker.iteration, hasPlan: s.devPlan !== undefined });
    };

    const loop = revisionLoop({
      name: 'planning', producer, reviewer, maxAttempts: 3,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
    });

    await loop.execute(freshState(), ctx);

    expect(markers).toEqual([
      { role: 'producer', loop: 'planning', iteration: 1, hasPlan: false },
      { role: 'reviewer', loop: 'planning', iteration: 1, hasPlan: true },
      { role: 'producer', loop: 'planning', iteration: 2, hasPlan: true },
      { role: 'reviewer', loop: 'planning', iteration: 2, hasPlan: true },
    ]);
  });

  test('persisted attempt budget caps total attempts across crash-resumes', async () => {
    let producerCalls = 0;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async () => { producerCalls++; throw new Error('Container exited with code 137'); },
    };
    const reviewer: Stage = { name: 'reviewer', canRun: () => true, execute: async (s) => s };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
      // resetState clears reviews each resume but must NOT clear the attempt budget
      resetState: (s) => ({ ...s, codeReviews: [] }),
    });

    // Simulate crash-and-auto-resume cycles (no skipResetState / rerunMode).
    let state: PipelineState = freshState();
    for (let i = 0; i < 3; i++) {
      try {
        await loop.execute(state, mockContext());
      } catch (err: any) {
        state = err.lastState ?? state;
      }
    }
    expect(producerCalls).toBe(3); // budget spent across the three crashes

    // 4th resume must fail fast WITHOUT running the producer again.
    await expect(loop.execute(state, mockContext())).rejects.toBeInstanceOf(RevisionExhaustedError);
    expect(producerCalls).toBe(3);
  });

  test('skipResetState refills the attempt budget after exhaustion', async () => {
    let producerCalls = 0;

    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => { producerCalls++; return { ...s, changeset: {} as any }; },
    };
    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        codeReviews: [...(s.codeReviews ?? []), { verdict: 'revise' as const, feedback: 'no' }],
      }),
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
      resetState: (s) => ({ ...s, codeReviews: [] }),
    });

    let exhausted: any;
    try {
      await loop.execute(freshState(), mockContext());
    } catch (err) {
      exhausted = err;
    }
    expect(exhausted).toBeInstanceOf(RevisionExhaustedError);
    expect(producerCalls).toBe(2);

    // Human resumes the exhausted loop — skipResetState grants a fresh budget.
    const resumeState = { ...exhausted.lastState, skipResetState: true };
    await expect(loop.execute(resumeState, mockContext())).rejects.toBeInstanceOf(RevisionExhaustedError);
    expect(producerCalls).toBe(4); // two more attempts ran
  });

  test('approval clears the persisted attempt budget', async () => {
    const producer: Stage = { name: 'producer', canRun: () => true, execute: async (s) => s };
    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({ ...s, codeReviews: [{ verdict: 'approve' as const, feedback: 'ok' }] }),
    };

    const loop = revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.codeReviews?.at(-1)?.verdict === 'approve',
    });

    // Pretend a prior resume left the counter at 2.
    const result = await loop.execute(
      { ...freshState(), revisionAttempts: { coding: 2 } },
      mockContext(),
    );
    expect(result.revisionAttempts?.coding).toBe(0);
  });

  test('postProducer hook is optional — loop works without it', async () => {
    const producer: Stage = {
      name: 'producer',
      canRun: () => true,
      execute: async (s) => ({ ...s, devPlan: {} as any }),
    };

    const reviewer: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (s) => ({
        ...s,
        planReviews: [{ verdict: 'approve' as const, feedback: 'good' }],
      }),
    };

    const loop = revisionLoop({
      name: 'planning',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) => s.planReviews?.at(-1)?.verdict === 'approve',
      // No postProducer — should work fine
    });

    const result = await loop.execute(freshState(), mockContext());
    expect(result.planReviews?.at(-1)?.verdict).toBe('approve');
  });
});
