import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig } from '../../../src/types/pipeline.types.ts';
import { codeReviewerStage } from '../../../src/agents/code-reviewer/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'code-reviewer',
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

describe('codeReviewerStage', () => {
  const stage = codeReviewerStage(mockConfig());

  test('stage name is code-reviewer', () => {
    expect(stage.name).toBe('code-reviewer');
  });

  test('exposes canRun and execute', () => {
    expect(typeof stage.canRun).toBe('function');
    expect(typeof stage.execute).toBe('function');
  });

  test('canRun returns true when state.changeset exists', () => {
    const state = freshState({
      changeset: {
        branchName: 'bug/#123-fix',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/File.al'],
      } as any,
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns true even for a minimal changeset object', () => {
    // canRun only checks `changeset != null` — any object satisfies it.
    const state = freshState({ changeset: {} as any });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when state.changeset is missing', () => {
    const state = freshState();
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns false when state.changeset is explicitly null', () => {
    const state = freshState({ changeset: null as any });
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns false when state.changeset is undefined', () => {
    const state = freshState({ changeset: undefined });
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun ignores unrelated populated state fields', () => {
    // Having devPlan / codeReviews but no changeset must still gate the stage off.
    const state = freshState({
      devPlan: { summary: 'plan' } as any,
      codeReviews: [{ verdict: 'approve' }] as any,
    });
    expect(stage.canRun(state)).toBe(false);
  });
});
