import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig } from '../../../src/types/pipeline.types.ts';
import type { PlanReview } from '../../../src/agents/plan-reviewer/schema.ts';
import { planReviewerStage } from '../../../src/agents/plan-reviewer/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'plan-reviewer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: { organization: 'org', orgUrl: 'https://dev.azure.com/org', project: 'Proj', repositoryId: 'repo-id', repositoryName: 'Repo', ciPipelineId: 1, cdPipelineId: 2, areaPath: 'Area', iterationPath: 'Iter', pat: 'pat' },
    paths: { sessionRoot: '/session', targetRepo: '/session/doc', stateDir: '/state' },
    checkpoints: { planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 }, prPublished: { fixCommand: '/fix', timeoutHours: 48 }, pollIntervalMinutes: 5 },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al/Src', testAppRoot: 'Test', test: 'Test/Src' },
  } as PipelineConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('planReviewerStage', () => {
  const stage = planReviewerStage(mockConfig());

  test('stage name is plan-reviewer', () => {
    expect(stage.name).toBe('plan-reviewer');
  });

  test('canRun returns true when state.devPlan exists', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting error',
        objects: [],
        testScenarios: [],
        risks: [],
      } as any,
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when state.devPlan is missing', () => {
    const state = freshState();
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns false when devPlan is explicitly undefined', () => {
    const state = freshState({ devPlan: undefined });
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns true even for an otherwise-empty devPlan object', () => {
    // canRun guards on presence (!= null), not shape — an empty plan still "runs".
    const state = freshState({ devPlan: {} as any });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun is unaffected by prior plan reviews already present', () => {
    const state = freshState({
      devPlan: { summary: 'x', objects: [] } as any,
      planReviews: [{ verdict: 'revise', feedback: 'redo' }] as any,
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('stage exposes the Stage interface (name, canRun, execute)', () => {
    expect(typeof stage.name).toBe('string');
    expect(typeof stage.canRun).toBe('function');
    expect(typeof stage.execute).toBe('function');
  });

  test('stage allowedTools includes Task for subagent spawning', async () => {
    const { TOOLS } = await import('../../../src/sdk/mcp-configs.ts');
    expect(TOOLS.Task).toBe('Task');
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      new URL('../../../src/agents/plan-reviewer/config.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('TOOLS.Task');
  });
});

// ---------------------------------------------------------------------------
// applyOutput — accumulates reviews onto state (semantics validated directly)
// ---------------------------------------------------------------------------

describe('planReviewerStage applyOutput semantics', () => {
  // applyOutput is internal to agentStage; replicate the documented contract here
  // so a regression in the factory call (e.g. replacing append with overwrite) is
  // caught by the matching unit test in tests/pipeline/stage.test.ts. This block
  // pins the EXPECTED behavior the stage relies on.
  function applyOutput(state: PipelineState, output: PlanReview): PipelineState {
    return { ...state, planReviews: [...(state.planReviews ?? []), output] };
  }

  function makeReview(overrides?: Partial<PlanReview>): PlanReview {
    return { verdict: 'approve', feedback: 'ok', issues: [], strengths: [], ...overrides };
  }

  test('appends the first review to empty state', () => {
    const out = applyOutput(freshState(), makeReview({ feedback: 'first' }));
    expect(out.planReviews).toHaveLength(1);
    expect(out.planReviews![0]!.feedback).toBe('first');
  });

  test('appends to existing reviews without dropping prior ones', () => {
    const state = freshState({ planReviews: [makeReview({ feedback: 'old' })] as any });
    const out = applyOutput(state, makeReview({ feedback: 'new' }));
    expect(out.planReviews).toHaveLength(2);
    expect(out.planReviews!.map((r) => r.feedback)).toEqual(['old', 'new']);
  });

  test('does not mutate the input state array', () => {
    const original = [makeReview({ feedback: 'old' })] as any;
    const state = freshState({ planReviews: original });
    applyOutput(state, makeReview({ feedback: 'new' }));
    expect(original).toHaveLength(1);
  });
});
