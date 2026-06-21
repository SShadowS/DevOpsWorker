import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { documenterStage, createDocumenterConfig } from '../../../src/agents/documenter/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'documenter',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: { organization: 'org', orgUrl: 'https://dev.azure.com/org', project: 'Proj', repositoryId: 'repo-id', repositoryName: 'Repo', ciPipelineId: 1, cdPipelineId: 2, areaPath: 'Cont\\Area', iterationPath: 'Cont\\Iter', pat: 'pat' },
    paths: { sessionRoot: '/session', targetRepo: '/session/doc', stateDir: '/state' },
    checkpoints: { planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 }, prPublished: { fixCommand: '/fix', timeoutHours: 48 }, pollIntervalMinutes: 5 },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al/Src', testAppRoot: 'Test', test: 'Test/Src' },
  } as PipelineConfig;
}

function mockContext(): PipelineContext {
  const config = mockConfig();
  const workItem: WorkItem = {
    id: 123,
    title: 'Fix VAT rounding on sales credit memo',
    type: 'Bug',
    state: 'Active',
    areaPath: 'Cont\\Area',
    iterationPath: 'Cont\\Iter',
    fields: {},
  };
  return {
    workItemId: 123,
    workItem,
    workItemType: 'Bug',
    config,
  };
}

/** Representative state with the upstream fields buildPrompt reads. */
function implementedState(overrides?: Partial<PipelineState>): PipelineState {
  return freshState({
    devPlan: {
      summary: 'Correct the VAT rounding routine in the posting codeunit',
      objects: [
        {
          objectType: 'codeunit',
          objectName: 'Sales Post',
          action: 'modify',
          description: 'Fix CalcVATAmount rounding direction',
          filePath: 'Cloud/Al/Src/SalesPost.Codeunit.al',
        },
      ],
      testScenarios: [],
      riskAssessment: { level: 'high', factors: [], mitigations: [] },
      estimatedComplexity: 'simple',
      dependencies: [],
    } as any,
    changeset: {
      branchName: 'bug/#123-vat-rounding',
      branchUrl: 'https://example/branch',
      filesCreated: [],
      filesModified: ['Cloud/Al/Src/SalesPost.Codeunit.al'],
      commitMessage: 'Fix VAT rounding',
      summary: 'Fixed rounding',
    } as any,
    draftPR: {
      id: 42,
      url: 'https://dev.azure.com/org/Proj/_git/Repo/pullrequest/42',
      isDraft: true,
      sourceBranch: 'bug/#123-vat-rounding',
      targetBranch: 'master',
      title: '#123: Fix VAT rounding',
      description: 'Description',
      linkedWorkItemId: 123,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Stage wiring
// ---------------------------------------------------------------------------

describe('documenterStage', () => {
  const stage = documenterStage(mockConfig());

  test('stage name is documenter', () => {
    expect(stage.name).toBe('documenter');
  });

  test('canRun returns true when state.draftPR exists', () => {
    const state = freshState({
      draftPR: {
        id: 42,
        url: 'https://dev.azure.com/org/Proj/_git/Repo/pullrequest/42',
        isDraft: true,
        sourceBranch: 'bug/#123-fix',
        targetBranch: 'master',
        title: '#123: Fix',
        description: 'Description',
        linkedWorkItemId: 123,
      },
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when state.draftPR is missing', () => {
    const state = freshState();
    expect(stage.canRun(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent config (allowedTools, schema, cwd, mcp)
// ---------------------------------------------------------------------------

describe('createDocumenterConfig', () => {
  const agent = createDocumenterConfig(mockConfig());

  test('agent is named documenter and uses the Claude Code preset', () => {
    expect(agent.name).toBe('documenter');
    expect(agent.useClaudeCodePreset).toBe(true);
  });

  test('cwd is the session root', () => {
    expect(agent.cwd).toBe('/session');
  });

  test('shared prompt fragments include project context and work-item fields', () => {
    expect(agent.sharedPromptFragments).toContain('project-context.md');
    expect(agent.sharedPromptFragments).toContain('work-item-fields.md');
    expect(agent.sharedPromptFragments).toContain('dependencies-folder.md');
  });

  test('allowedTools include read-only Zendesk MCP tools (for ticket context)', () => {
    expect(agent.allowedTools.some(t => t.includes('zendesk'))).toBe(true);
  });

  test('registers the azureDevOps MCP server', () => {
    expect(agent.mcpServers).toBeDefined();
    expect((agent.mcpServers as Record<string, unknown>).azureDevOps).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe('documenter buildPrompt', () => {
  const config = mockConfig();
  const agent = createDocumenterConfig(config);
  const ctx = mockContext();

  test('includes the task framing referencing the work item id', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('Update work item #123');
    expect(prompt).toContain('## Work Item');
    expect(prompt).toContain('**ID:** 123');
    expect(prompt).toContain('Fix VAT rounding on sales credit memo');
    expect(prompt).toContain('**Type:** Bug');
  });

  test('includes the dev plan summary and each modified object', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('**Plan summary:** Correct the VAT rounding routine in the posting codeunit');
    expect(prompt).toContain('- modify codeunit "Sales Post": Fix CalcVATAmount rounding direction');
  });

  test('lists created and modified files from the changeset', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('- Created: (none)');
    expect(prompt).toContain('- Modified: Cloud/Al/Src/SalesPost.Codeunit.al');
  });

  test('renders "(none)" for an empty modified list too', () => {
    const state = implementedState({
      changeset: {
        branchName: 'bug/#123-vat-rounding',
        branchUrl: 'https://example/branch',
        filesCreated: ['Cloud/Al/Src/NewThing.al'],
        filesModified: [],
        commitMessage: 'add',
        summary: 'added',
      } as any,
    });
    const prompt = agent.buildPrompt(state, ctx);

    expect(prompt).toContain('- Created: Cloud/Al/Src/NewThing.al');
    expect(prompt).toContain('- Modified: (none)');
  });

  test('surfaces the required-field paths from config', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('## Required Fields');
    expect(prompt).toContain('`Area Path`: Cont\\Area');
    expect(prompt).toContain('`Iteration Path`: Cont\\Iter');
    expect(prompt).toContain('`Custom.ReleaseNotes`');
  });

  test('includes the instructions block with customer-facing guidance', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain("customer's perspective");
    expect(prompt).toContain('Error Details, Root Cause, Solution, Impact');
    expect(prompt).toContain('update_work_item');
  });

  test('returns a single joined string with one line per object', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);
    expect(typeof prompt).toBe('string');
    const objectLines = prompt.split('\n').filter(l => l.startsWith('- modify ') || l.startsWith('- create '));
    expect(objectLines.length).toBe(1);
  });
});
