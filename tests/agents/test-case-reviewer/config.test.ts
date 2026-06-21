import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { createTestCaseReviewerConfig, testCaseReviewerStage } from '../../../src/agents/test-case-reviewer/config.ts';

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'test-case-reviewer',
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
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

function minimalContext(): PipelineContext {
  const config = minimalConfig();
  const workItem: WorkItem = {
    id: 12345,
    title: 'Fix posting error on sales credit memo',
    type: 'Bug',
    state: 'Active',
    areaPath: 'Test\\Area',
    iterationPath: 'Test\\Iteration',
    fields: {},
  };
  return { workItemId: 12345, workItem, workItemType: 'Bug', config };
}

describe('test-case-reviewer buildPrompt', () => {
  const config = minimalConfig();
  const agentConfig = createTestCaseReviewerConfig(config);
  const ctx = minimalContext();

  test('includes test case IDs and titles', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic',
        objects: [{ action: 'modify', objectType: 'codeunit', objectName: 'PostingMgmt', description: 'Fix VAT' }],
        testScenarios: ['Verify VAT is zero for reverse charge', 'Verify error on invalid customer'],
        risks: [],
      } as any,
      changeset: {
        branchName: 'bug/#12345-fix-posting',
        filesCreated: ['Cloud/AL/src/Codeunit.Post.al'],
        filesModified: [],
      } as any,
      testCases: {
        testCases: [
          { id: 100, title: 'Verify happy path posting', stepCount: 4, derivedFrom: 'Scenario 1' },
          { id: 101, title: 'Verify error on invalid input', stepCount: 3, derivedFrom: 'Scenario 2' },
        ],
        summary: 'Created 2 test cases',
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('#12345');
    expect(prompt).toContain('#100');
    expect(prompt).toContain('#101');
    expect(prompt).toContain('Verify happy path posting');
    expect(prompt).toContain('Verify error on invalid input');
  });

  test('includes dev plan test scenarios for coverage comparison', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic',
        objects: [],
        testScenarios: ['Scenario A', 'Scenario B'],
        risks: [],
      } as any,
      changeset: { branchName: 'b', filesCreated: [], filesModified: [] } as any,
      testCases: {
        testCases: [{ id: 200, title: 'Test A', stepCount: 3, derivedFrom: 'Scenario A' }],
        summary: 'One test case',
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('Scenario A');
    expect(prompt).toContain('Scenario B');
  });

  test('includes file changes for context', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: {
        branchName: 'b',
        filesCreated: ['Cloud/AL/src/New.al'],
        filesModified: ['Cloud/AL/src/Old.al'],
      } as any,
      testCases: {
        testCases: [{ id: 300, title: 'Test', stepCount: 2, derivedFrom: 'S1' }],
        summary: 'One test',
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('Cloud/AL/src/New.al');
    expect(prompt).toContain('Cloud/AL/src/Old.al');
  });
});

describe('testCaseReviewerStage', () => {
  const config = minimalConfig();

  test('canRun returns true when testCases exist', () => {
    const stage = testCaseReviewerStage(config);
    const state = freshState({
      testCases: {
        testCases: [{ id: 100, title: 'T', stepCount: 2, derivedFrom: 'S1' }],
        summary: 'ok',
      },
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when no testCases', () => {
    const stage = testCaseReviewerStage(config);
    expect(stage.canRun(freshState())).toBe(false);
  });
});
