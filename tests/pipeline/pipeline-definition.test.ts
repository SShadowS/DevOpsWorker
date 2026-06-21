import { describe, test, expect } from 'bun:test';
import type { PipelineConfig, PipelineState, Stage } from '../../src/types/pipeline.types.ts';
import { buildDefaultPipeline, planningResetState, buildPipeline, codingIsApproved } from '../../src/pipeline/pipeline-definition.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test', orgUrl: 'https://test', project: 'Test',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'T', iterationPath: 'T', pat: 'p',
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

// Minimal config stubs for buildPipeline tests
const baseConfig: PipelineConfig = {
  checkpoints: {
    planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 168 },
    prPublished: { fixCommand: '/fix', timeoutHours: 168 },
    pollIntervalMinutes: 60,
  },
  revisionLoops: { maxAttempts: 3 },
  models: { default: 'claude-sonnet-4-6' },
  costs: {},
  azureDevOps: { pat: 'test', organization: 'test', orgUrl: '', project: '', repositoryId: '', repositoryName: '', ciPipelineId: 0, cdPipelineId: 0, areaPath: '', iterationPath: '' },
  paths: { sessionRoot: '/tmp', targetRepo: '/tmp/repo', stateDir: '/tmp/state' },
  repoKey: 'DocumentOutput',
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

const minimalRepo: RepoConfig = {
  url: 'https://example.com/repo.git',
  branch: 'main',
  azureDevOps: { project: 'Test', repositoryId: 'id', repositoryName: 'repo', areaPath: 'Test' },
  repoKey: 'TestRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

/** Overlay that injects an env-provision stage when the repo enables it — mirrors
 *  how the private overlay re-adds the externalised BC env stage. The core itself
 *  no longer knows about env-provision. */
function envInjectingOverlay(): PipelineConfig['overlay'] {
  const stage: Stage = { name: 'env-provision', canRun: () => true, execute: async (s: PipelineState) => s };
  return {
    pipeline: ({ repo }) =>
      repo?.envProvision ? [{ op: 'insertAfter', anchor: 'checkpoint:plan-approved', stage }] : [],
  };
}

// ---------------------------------------------------------------------------
// Tests: buildDefaultPipeline (unchanged)
// ---------------------------------------------------------------------------

describe('buildDefaultPipeline', () => {
  test('produces expected stage sequence', () => {
    const stages = buildDefaultPipeline(mockConfig());
    const names = stages.map(s => s.name);

    expect(names).toContain('planning');
    expect(names).toContain('checkpoint:plan-approved');
    expect(names).toContain('coding');
    expect(names).toContain('checkpoint:pr-published');
    expect(names).toContain('checkpoint:pr-completed');
  });
});

describe('overlay pipeline injection', () => {
  const fakeStage = (name: string): Stage => ({
    name,
    canRun: () => true,
    execute: async (s: PipelineState) => s,
  });

  test('empty overlay leaves the pipeline unchanged (identity)', () => {
    const without = buildPipeline(baseConfig, minimalRepo).map((s) => s.name);
    const withEmpty = buildPipeline({ ...baseConfig, overlay: {} }, minimalRepo).map((s) => s.name);
    expect(withEmpty).toEqual(without);
  });

  test('overlay.pipeline injects a name-anchored stage from build context', () => {
    const config: PipelineConfig = {
      ...baseConfig,
      overlay: {
        pipeline: ({ repo }) =>
          repo
            ? [{ op: 'insertAfter', anchor: 'checkpoint:plan-approved', stage: fakeStage('env-provision') }]
            : [],
      },
    };
    const names = buildPipeline(config, minimalRepo).map((s) => s.name);
    const idx = names.indexOf('env-provision');
    expect(idx).toBeGreaterThan(-1);
    expect(names[idx - 1]).toBe('checkpoint:plan-approved');
  });
});

describe('planningResetState', () => {
  test('clears all downstream outputs', () => {
    const state: PipelineState = {
      currentStage: 'planning',
      readiness: { verdict: 'proceed', enrichedContext: {}, metadata: {} } as any,
      devPlan: { summary: 'old plan' } as any,
      planReviews: [{ verdict: 'revise', feedback: 'bad' }],
      changeset: { branch: 'b', files: [] } as any,
      codeReviews: [{ verdict: 'revise', feedback: 'bad code' }],
      draftPR: { id: 1, url: 'u', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 1 },
      testCases: { testCases: [] } as any,
      docsWriterDrafts: { pages: [] } as any,
      workItemUpdate: { title: 'T', tags: [] } as any,
      learnedRules: { rules: ['some rule'] },
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
    };

    const reset = planningResetState(state);

    // Downstream outputs cleared
    expect(reset.planReviews).toEqual([]);
    expect(reset.changeset).toBeUndefined();
    expect(reset.codeReviews).toEqual([]);
    expect(reset.draftPR).toBeUndefined();
    expect(reset.testCases).toBeUndefined();
    expect(reset.docsWriterDrafts).toBeUndefined();
    expect(reset.workItemUpdate).toBeUndefined();
    expect(reset.learnedRules).toBeUndefined();

    // Upstream outputs preserved
    expect(reset.readiness).toBeDefined();
    expect(reset.devPlan).toBeDefined();
    expect(reset.telemetry).toBeDefined();
    expect(reset.currentStage).toBe('planning');
  });

  test('preserves humanFeedback across reset', () => {
    const state: PipelineState = {
      currentStage: 'planning',
      humanFeedback: {
        rerunComment: '/rerun-plan rethink',
        source: 'pr-comment',
        commentSummary: 'Reviewers want a different approach.',
      },
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
    };

    const reset = planningResetState(state);

    expect(reset.humanFeedback).toBeDefined();
    expect(reset.humanFeedback!.rerunComment).toBe('/rerun-plan rethink');
    expect(reset.humanFeedback!.commentSummary).toBe('Reviewers want a different approach.');
  });
});

// ---------------------------------------------------------------------------
// Tests: codingIsApproved
// ---------------------------------------------------------------------------

describe('codingIsApproved', () => {
  test('returns true when verdict is approve AND ciResult is passed', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
      changeset: { ciResult: 'passed' } as any,
    } as PipelineState)).toBe(true);
  });
  test('returns false when verdict is approve but ciResult is failed', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
      changeset: { ciResult: 'failed' } as any,
    } as PipelineState)).toBe(false);
  });
  test('returns false when verdict is approve but ciResult is not-run', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
      changeset: { ciResult: 'not-run' } as any,
    } as PipelineState)).toBe(false);
  });
  test('returns false when verdict is approve but ciResult is undefined', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
      changeset: {} as any,
    } as PipelineState)).toBe(false);
  });
  test('returns false when ciResult is passed but verdict is revise', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'revise' } as any],
      changeset: { ciResult: 'passed' } as any,
    } as PipelineState)).toBe(false);
  });
  test('returns false when changeset is undefined', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
    } as PipelineState)).toBe(false);
  });

  // env-publish + env-tests become approval conditions when a BC env exists.
  const withEnv = (changeset: any): PipelineState => ({
    codeReviews: [{ verdict: 'approve' } as any],
    environment: { envId: 'env-123' } as any,
    changeset,
  } as PipelineState);

  test('env present: true when approve + CI passed + published + tests passed', () => {
    expect(codingIsApproved(withEnv({ ciResult: 'passed', envPublished: true, envTestsPassed: true }))).toBe(true);
  });
  test('env present: false when published but tests not passed', () => {
    expect(codingIsApproved(withEnv({ ciResult: 'passed', envPublished: true, envTestsPassed: false }))).toBe(false);
  });
  test('env present: false when tests pass but not published', () => {
    expect(codingIsApproved(withEnv({ ciResult: 'passed', envPublished: false, envTestsPassed: true }))).toBe(false);
  });
  test('env present: false when publish/test flags are undefined (CI+review alone insufficient)', () => {
    expect(codingIsApproved(withEnv({ ciResult: 'passed' }))).toBe(false);
  });
  test('no env: CI + review alone still approves (env conditions skipped)', () => {
    expect(codingIsApproved({
      codeReviews: [{ verdict: 'approve' } as any],
      changeset: { ciResult: 'passed' } as any,
    } as PipelineState)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildPipeline — dynamic assembly from RepoConfig
// ---------------------------------------------------------------------------

describe('buildPipeline', () => {
  test('core stages always present', () => {
    const stages = buildPipeline(baseConfig, minimalRepo);
    const names = stages.map(s => s.name);

    expect(names).toContain('analyzer');
    expect(names).toContain('planning');
    expect(names).toContain('checkpoint:plan-approved');
    expect(names).toContain('coding');
    expect(names).toContain('checkpoint:pr-published');
    expect(names).toContain('checkpoint:pr-completed');
    expect(names).toContain('documenter');
  });

  test('excludes optional stages when repo config omits them', () => {
    const stages = buildPipeline(baseConfig, minimalRepo);
    const names = stages.map(s => s.name);

    expect(names).not.toContain('env-provision');
    expect(names).not.toContain('test-cases');
    expect(names).not.toContain('test-case-activation');
    expect(names).not.toContain('docs-writer');
  });

  test('includes env-provision when repo config has envProvision (via overlay)', () => {
    const repo: RepoConfig = { ...minimalRepo, envProvision: { profileId: 'pid' } };
    const stages = buildPipeline({ ...baseConfig, overlay: envInjectingOverlay() }, repo);
    const names = stages.map(s => s.name);

    expect(names).toContain('env-provision');
  });

  test('omits env-provision even with envProvision when no overlay is installed', () => {
    const repo: RepoConfig = { ...minimalRepo, envProvision: { profileId: 'pid' } };
    const names = buildPipeline(baseConfig, repo).map(s => s.name);
    expect(names).not.toContain('env-provision');
  });

  test('includes test-cases and test-case-activation when enabled', () => {
    const repo: RepoConfig = { ...minimalRepo, testCases: true };
    const stages = buildPipeline(baseConfig, repo);
    const names = stages.map(s => s.name);

    expect(names).toContain('test-cases');
    expect(names).toContain('test-case-activation');
  });

  test('includes docs-writer when enabled', () => {
    const repo: RepoConfig = { ...minimalRepo, docsWriter: { docsRepoUrl: 'https://docs.git' } };
    const stages = buildPipeline(baseConfig, repo);
    const names = stages.map(s => s.name);

    expect(names).toContain('docs-writer');
  });

  test('stage order: env-provision before coding, test-cases before draft-pr', () => {
    const repo: RepoConfig = {
      ...minimalRepo,
      envProvision: { profileId: 'pid' },
      testCases: true,
      docsWriter: { docsRepoUrl: 'https://docs.git' },
    };
    const stages = buildPipeline({ ...baseConfig, overlay: envInjectingOverlay() }, repo);
    const names = stages.map(s => s.name);

    const indexOf = (name: string) => names.indexOf(name);

    expect(indexOf('env-provision')).toBeLessThan(indexOf('coding'));
    expect(indexOf('test-cases')).toBeLessThan(indexOf('draft-pr'));
    expect(indexOf('checkpoint:pr-published')).toBeLessThan(indexOf('test-case-activation'));
    expect(indexOf('test-case-activation')).toBeLessThan(indexOf('checkpoint:pr-completed'));
    expect(indexOf('checkpoint:pr-completed')).toBeLessThan(indexOf('documenter'));
    expect(indexOf('docs-writer')).toBeGreaterThan(indexOf('documenter'));
  });
});
