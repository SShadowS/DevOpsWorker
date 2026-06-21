import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { createTestCasesConfig } from '../../../src/agents/test-cases/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'test-cases',
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
  return {
    workItemId: 12345,
    workItem,
    workItemType: 'Bug',
    config,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('test-cases buildPrompt', () => {
  const config = minimalConfig();
  const agentConfig = createTestCasesConfig(config);
  const ctx = minimalContext();

  test('returns create-mode prompt when no testCases in state', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic',
        objects: [
          { action: 'modify', objectType: 'codeunit', objectName: 'PostingMgmt', description: 'Fix VAT calc' },
        ],
        testScenarios: ['Verify VAT is zero for reverse charge'],
        risks: [],
      } as any,
      changeset: {
        branchName: 'bug/#12345-fix-posting',
        filesCreated: ['Cloud/AL/src/Codeunit.Post.al'],
        filesModified: [],
      } as any,
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('Create manual Test Case work items');
    expect(prompt).toContain('#12345');
    expect(prompt).toContain('Verify VAT is zero for reverse charge');
    expect(prompt).not.toContain('/fix request');
  });

  test('returns revise-mode prompt when testCases already exist', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic',
        objects: [],
        testScenarios: [],
        risks: [],
      } as any,
      changeset: {
        branchName: 'bug/#12345-fix-posting',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/Codeunit.Post.al'],
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

    // Should be in revise mode
    expect(prompt).toContain('Review and revise the existing test cases');
    expect(prompt).toContain('/fix request');
    expect(prompt).toContain('#12345');

    // Should list existing test cases by ID and title
    expect(prompt).toContain('#100 — Verify happy path posting');
    expect(prompt).toContain('#101 — Verify error on invalid input');

    // Should include file changes
    expect(prompt).toContain('Cloud/AL/src/Codeunit.Post.al');

    // Should NOT contain create-mode instructions
    expect(prompt).not.toContain('Create manual Test Case work items');

    // Should instruct not to duplicate
    expect(prompt).toContain('Do NOT create duplicate test cases');
  });

  test('revise-mode prompt shows files created and modified', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: {
        branchName: 'bug/#12345-fix',
        filesCreated: ['Cloud/AL/src/NewFile.al'],
        filesModified: ['Cloud/AL/src/Existing.al'],
      } as any,
      testCases: {
        testCases: [{ id: 200, title: 'Test case A', stepCount: 2, derivedFrom: 'S1' }],
        summary: 'One test case',
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('**Created:** Cloud/AL/src/NewFile.al');
    expect(prompt).toContain('**Modified:** Cloud/AL/src/Existing.al');
  });

  test('revise-mode prompt shows (none) when no files created', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: {
        branchName: 'bug/#12345-fix',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/Changed.al'],
      } as any,
      testCases: {
        testCases: [{ id: 300, title: 'Test B', stepCount: 1, derivedFrom: 'S2' }],
        summary: 'One test case',
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('**Created:** (none)');
    expect(prompt).toContain('**Modified:** Cloud/AL/src/Changed.al');
  });

  test('revise-mode prompt includes reviewer feedback when testCaseReviews exist', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: { branchName: 'b', filesCreated: [], filesModified: [] } as any,
      testCases: {
        testCases: [{ id: 100, title: 'Test A', stepCount: 3, derivedFrom: 'S1' }],
        summary: 'One test case',
      },
      testCaseReviews: [{
        verdict: 'revise',
        feedback: 'Missing negative tests',
        revisionInstructions: 'Add error scenario test cases for invalid customer input',
      }] as any,
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('test case reviewer requested changes');
    expect(prompt).toContain('Add error scenario test cases for invalid customer input');
  });
});
