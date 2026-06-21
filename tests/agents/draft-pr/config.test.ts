import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { createDraftPRConfig } from '../../../src/agents/draft-pr/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'draft-pr',
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

describe('draft-pr buildPrompt', () => {
  const config = minimalConfig();
  const agentConfig = createDraftPRConfig(config);
  const ctx = minimalContext();

  test('returns create-mode prompt when no draftPR in state', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic for credit memos',
        objects: [],
        testScenarios: [],
        risks: [],
      } as any,
      changeset: {
        branchName: 'bug/#12345-fix-posting',
        filesCreated: ['Cloud/AL/src/Codeunit.Post.al'],
        filesModified: [],
        ciRunId: 100,
        ciResult: 'succeeded',
      } as any,
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('Create a draft pull request');
    expect(prompt).toContain('#12345');
    expect(prompt).toContain('create_pull_request');
    expect(prompt).not.toContain('Update the existing draft pull request');
  });

  test('returns update-mode prompt when draftPR already exists', () => {
    const state = freshState({
      devPlan: {
        summary: 'Fix posting logic for credit memos',
        objects: [],
        testScenarios: [],
        risks: [],
      } as any,
      changeset: {
        branchName: 'bug/#12345-fix-posting',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/Codeunit.Post.al'],
      } as any,
      draftPR: {
        id: 999,
        url: 'https://dev.azure.com/test-org/Test%20Project/_git/Test%20Repo/pullrequest/999',
        isDraft: true,
        sourceBranch: 'bug/#12345-fix-posting',
        targetBranch: 'master',
        title: '#12345: Fix posting error',
        description: 'Original PR description',
        linkedWorkItemId: 12345,
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    // Should be in update mode
    expect(prompt).toContain('Update the existing draft pull request');
    expect(prompt).toContain('#12345');
    expect(prompt).toContain('new commits from a fix');

    // Should reference existing PR details
    expect(prompt).toContain('**PR ID:** 999');
    expect(prompt).toContain('pullrequest/999');
    expect(prompt).toContain('bug/#12345-fix-posting');

    // Should include dev plan summary
    expect(prompt).toContain('Fix posting logic for credit memos');

    // Should NOT contain create-mode instructions
    expect(prompt).not.toContain('Create a draft pull request');
    expect(prompt).not.toContain('create_pull_request');
    expect(prompt).not.toContain('isDraft');

    // Should instruct not to create a new PR
    expect(prompt).toContain('Do NOT create a new PR');

    // Should mention update_pull_request
    expect(prompt).toContain('update_pull_request');
  });

  test('update-mode prompt shows files created and modified', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: {
        branchName: 'bug/#12345-fix',
        filesCreated: ['Cloud/AL/src/NewFile.al'],
        filesModified: ['Cloud/AL/src/Existing.al'],
      } as any,
      draftPR: {
        id: 999,
        url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/999',
        isDraft: true,
        sourceBranch: 'bug/#12345-fix',
        targetBranch: 'master',
        title: '#12345: Fix',
        description: 'Desc',
        linkedWorkItemId: 12345,
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('**Created:** Cloud/AL/src/NewFile.al');
    expect(prompt).toContain('**Modified:** Cloud/AL/src/Existing.al');
  });

  test('update-mode prompt shows (none) when no files created', () => {
    const state = freshState({
      devPlan: { summary: 'Fix', objects: [], testScenarios: [], risks: [] } as any,
      changeset: {
        branchName: 'bug/#12345-fix',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/Changed.al'],
      } as any,
      draftPR: {
        id: 888,
        url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/888',
        isDraft: true,
        sourceBranch: 'bug/#12345-fix',
        targetBranch: 'master',
        title: '#12345: Fix',
        description: 'Desc',
        linkedWorkItemId: 12345,
      },
    });

    const prompt = agentConfig.buildPrompt(state, ctx);

    expect(prompt).toContain('**Created:** (none)');
    expect(prompt).toContain('**Modified:** Cloud/AL/src/Changed.al');
  });
});
