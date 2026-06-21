import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { createAnalyzerConfig, analyzerStage } from '../../../src/agents/analyzer/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'analyzer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function minimalConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test\\Area',
      iterationPath: 'Test\\Iteration',
      pat: 'fake-pat',
    },
    paths: {
      sessionRoot: '/tmp/test-session',
      targetRepo: '/tmp/test-session/DocumentOutput',
      stateDir: '/tmp/test-session/.pipeline/state',
    },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 72 },
      prPublished: { fixCommand: '/fix', timeoutHours: 72 },
      pollIntervalMinutes: 5,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'claude-sonnet-4-20250514' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al/Src', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

function makeContext(workItemOverrides?: Partial<WorkItem>): PipelineContext {
  const config = minimalConfig();
  const workItem: WorkItem = {
    id: 54321,
    title: 'Add validation to Purchase Header posting',
    type: 'User Story',
    state: 'Active',
    description: 'When posting a purchase header the validation is skipped.',
    acceptanceCriteria: 'Validation runs before posting and blocks invalid documents.',
    tags: ['analyse', 'banking'],
    areaPath: 'Test\\Area',
    iterationPath: 'Test\\Iteration',
    fields: {},
    ...workItemOverrides,
  };
  return {
    workItemId: workItem.id,
    workItem,
    workItemType: 'User Story',
    config,
  };
}

// ---------------------------------------------------------------------------
// Tests — buildPrompt
// ---------------------------------------------------------------------------

describe('analyzer buildPrompt', () => {
  const agentConfig = createAnalyzerConfig(minimalConfig());

  test('includes the work item id, title, type, and state', () => {
    const state = freshState();
    const ctx = makeContext();
    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('work item #54321');
    expect(prompt).toContain('**ID:** 54321');
    expect(prompt).toContain('**Title:** Add validation to Purchase Header posting');
    expect(prompt).toContain('**Type:** User Story');
    expect(prompt).toContain('**State:** Active');
  });

  test('includes description, acceptance criteria, and tags', () => {
    const prompt = createAnalyzerConfig(minimalConfig()).buildPrompt(freshState(), makeContext());

    expect(prompt).toContain('**Description:** When posting a purchase header the validation is skipped.');
    expect(prompt).toContain('**Acceptance Criteria:** Validation runs before posting and blocks invalid documents.');
    expect(prompt).toContain('**Tags:** analyse, banking');
  });

  test('renders (none) placeholders when optional work item fields are absent', () => {
    const ctx = makeContext({
      description: undefined,
      acceptanceCriteria: undefined,
      tags: undefined,
    });
    const prompt = createAnalyzerConfig(minimalConfig()).buildPrompt(freshState(), ctx);

    expect(prompt).toContain('**Description:** (none)');
    expect(prompt).toContain('**Acceptance Criteria:** (none)');
    expect(prompt).toContain('**Tags:** (none)');
  });

  test('embeds the LSP warm-up Glob pattern built from repoKey and layout.source', () => {
    const prompt = createAnalyzerConfig(minimalConfig()).buildPrompt(freshState(), makeContext());

    // repoKey=DocumentOutput, layout.source=Cloud/Al/Src
    expect(prompt).toContain('DocumentOutput/Cloud/Al/Src/**/*.al');
    expect(prompt).toContain('LSP Warm-Up (MANDATORY FIRST ACTION)');
    expect(prompt).toContain('documentSymbol');
  });

  test('includes the task header and instruction checklist', () => {
    const prompt = createAnalyzerConfig(minimalConfig()).buildPrompt(freshState(), makeContext());

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('Analyze work item #54321 for readiness');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('Produce a ReadinessReport');
  });
});

// ---------------------------------------------------------------------------
// Tests — config shape / canRun
// ---------------------------------------------------------------------------

describe('analyzer config', () => {
  const agentConfig = createAnalyzerConfig(minimalConfig());

  test('agent is named analyzer and disallows Bash', () => {
    expect(agentConfig.name).toBe('analyzer');
    expect(agentConfig.disallowedTools).toContain('Bash');
  });

  test('cwd is the session root', () => {
    expect(agentConfig.cwd).toBe('/tmp/test-session');
  });
});

describe('analyzerStage', () => {
  const stage = analyzerStage(minimalConfig());

  test('stage name is analyzer', () => {
    expect(stage.name).toBe('analyzer');
  });

  test('canRun is always true (analyzer is the first stage)', () => {
    expect(stage.canRun(freshState())).toBe(true);
    expect(stage.canRun(freshState({ readiness: { verdict: 'proceed' } as any }))).toBe(true);
  });
});
