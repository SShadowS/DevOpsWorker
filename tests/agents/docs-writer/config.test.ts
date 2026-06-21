import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig, PipelineContext, WorkItem } from '../../../src/types/pipeline.types.ts';
import { docsWriterStage, createDocsWriterConfig } from '../../../src/agents/docs-writer/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'docs-writer',
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
    id: 54321,
    title: 'Add batch email sending for Document Output',
    type: 'User Story',
    state: 'Active',
    areaPath: 'Test\\Area',
    iterationPath: 'Test\\Iteration',
    fields: {},
  };
  return {
    workItemId: 54321,
    workItem,
    workItemType: 'User Story',
    config,
  };
}

/** Build a representative state with the upstream fields buildPrompt reads. */
function implementedState(overrides?: Partial<PipelineState>): PipelineState {
  return freshState({
    devPlan: {
      summary: 'Add a batch email codeunit that queues and sends documents',
      objects: [
        {
          objectType: 'codeunit',
          objectName: 'CDO Batch Email Mgt',
          action: 'create',
          description: 'New codeunit to queue and send batch emails',
          filePath: 'Cloud/AL/src/CDOBatchEmailMgt.Codeunit.al',
        },
        {
          objectType: 'page',
          objectName: 'CDO Email Setup',
          action: 'modify',
          description: 'Add a batch toggle field',
          filePath: 'Cloud/AL/src/CDOEmailSetup.Page.al',
        },
      ],
      testScenarios: [],
      riskAssessment: { level: 'low', factors: [], mitigations: [] },
      estimatedComplexity: 'moderate',
      dependencies: [],
    } as any,
    changeset: {
      branchName: 'feature/#54321-batch-email',
      branchUrl: 'https://example/branch',
      filesCreated: ['Cloud/AL/src/CDOBatchEmailMgt.Codeunit.al'],
      filesModified: ['Cloud/AL/src/CDOEmailSetup.Page.al'],
      commitMessage: 'Add batch email support',
      summary: 'Implemented batch email',
    } as any,
    workItemUpdate: {
      releaseNotes: 'Added the ability to send documents in batches',
      description: '<p>Batch email feature</p>',
      fieldUpdates: [],
      summaryComment: 'Implementation complete',
      changesSummary: 'Added batch email codeunit',
      decisionsAndTradeoffs: [],
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Stage wiring
// ---------------------------------------------------------------------------

describe('docsWriterStage', () => {
  const stage = docsWriterStage(minimalConfig());

  test('has correct name', () => {
    expect(stage.name).toBe('docs-writer');
  });

  test('canRun returns false when workItemUpdate is missing', () => {
    const state = freshState();
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns true when workItemUpdate is present', () => {
    const state = freshState({
      workItemUpdate: {
        releaseNotes: 'Added batch email support',
        description: '<p>Batch email feature</p>',
        fieldUpdates: [],
        summaryComment: 'Implementation complete',
        changesSummary: 'Added batch email codeunit',
        decisionsAndTradeoffs: [],
      },
    });
    expect(stage.canRun(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent config (allowedTools, schema, cwd, mcp)
// ---------------------------------------------------------------------------

describe('createDocsWriterConfig', () => {
  const agent = createDocsWriterConfig(minimalConfig());

  test('agent is named docs-writer and uses the Claude Code preset', () => {
    expect(agent.name).toBe('docs-writer');
    expect(agent.useClaudeCodePreset).toBe(true);
  });

  test('cwd is the session root', () => {
    expect(agent.cwd).toBe('/tmp/test-session');
  });

  test('shared prompt fragments include project context and doc style', () => {
    expect(agent.sharedPromptFragments).toContain('project-context.md');
    expect(agent.sharedPromptFragments).toContain('doc-writing-style.md');
  });

  test('allowedTools include filesystem write and work-item read MCP tools', () => {
    // Write capability — drafts are written to docs-drafts/
    expect(agent.allowedTools.some(t => t.toLowerCase().includes('write'))).toBe(true);
    // At least one Azure DevOps MCP tool is present
    expect(agent.allowedTools.some(t => t.includes('azureDevOps'))).toBe(true);
  });

  test('registers the azureDevOps MCP server', () => {
    expect(agent.mcpServers).toBeDefined();
    expect((agent.mcpServers as Record<string, unknown>).azureDevOps).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe('docs-writer buildPrompt', () => {
  const agent = createDocsWriterConfig(minimalConfig());
  const ctx = minimalContext();

  test('includes the task framing and work item header', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('warrants documentation changes');
    expect(prompt).toContain('## Work Item');
    expect(prompt).toContain('**ID:** 54321');
    expect(prompt).toContain('Add batch email sending for Document Output');
    expect(prompt).toContain('**Type:** User Story');
  });

  test('includes the dev plan summary and each modified object', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('**Plan summary:** Add a batch email codeunit that queues and sends documents');
    expect(prompt).toContain('- create codeunit "CDO Batch Email Mgt": New codeunit to queue and send batch emails');
    expect(prompt).toContain('- modify page "CDO Email Setup": Add a batch toggle field');
  });

  test('lists created and modified files from the changeset', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('- Created: Cloud/AL/src/CDOBatchEmailMgt.Codeunit.al');
    expect(prompt).toContain('- Modified: Cloud/AL/src/CDOEmailSetup.Page.al');
  });

  test('renders release notes from workItemUpdate when present', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);
    expect(prompt).toContain('**Release notes:** Added the ability to send documents in batches');
  });

  test('falls back to "(not available)" when workItemUpdate is absent', () => {
    const state = implementedState({ workItemUpdate: undefined });
    const prompt = agent.buildPrompt(state, ctx);
    expect(prompt).toContain('**Release notes:** (not available)');
  });

  test('renders "(none)" for empty created/modified file lists', () => {
    const state = implementedState({
      changeset: {
        branchName: 'feature/#54321-batch-email',
        branchUrl: 'https://example/branch',
        filesCreated: [],
        filesModified: [],
        commitMessage: 'noop',
        summary: 'no file changes',
      } as any,
    });
    const prompt = agent.buildPrompt(state, ctx);

    expect(prompt).toContain('- Created: (none)');
    expect(prompt).toContain('- Modified: (none)');
  });

  test('includes the docs repo section when DOCS_REPO_PATH is set', () => {
    const prev = process.env['DOCS_REPO_PATH'];
    process.env['DOCS_REPO_PATH'] = '/srv/docs/my-product';
    try {
      const prompt = agent.buildPrompt(implementedState(), ctx);
      expect(prompt).toContain('## Docs Repo');
      expect(prompt).toContain('/srv/docs/my-product');
    } finally {
      if (prev === undefined) delete process.env['DOCS_REPO_PATH'];
      else process.env['DOCS_REPO_PATH'] = prev;
    }
  });

  test('omits the docs repo section when DOCS_REPO_PATH is unset', () => {
    const prev = process.env['DOCS_REPO_PATH'];
    delete process.env['DOCS_REPO_PATH'];
    try {
      const prompt = agent.buildPrompt(implementedState(), ctx);
      expect(prompt).not.toContain('## Docs Repo');
    } finally {
      if (prev !== undefined) process.env['DOCS_REPO_PATH'] = prev;
    }
  });

  test('always includes output directory and decision guidelines', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);

    expect(prompt).toContain('## Output Directory');
    expect(prompt).toContain('docs-drafts/');
    expect(prompt).toContain('DO-DRAFT-1');
    expect(prompt).toContain('## Decision Guidelines');
    expect(prompt).toContain('NO docs needed');
  });

  test('joins to a single string (no array leakage)', () => {
    const prompt = agent.buildPrompt(implementedState(), ctx);
    expect(typeof prompt).toBe('string');
    // Each object renders on its own line
    const lines = prompt.split('\n');
    expect(lines.filter(l => l.startsWith('- create ') || l.startsWith('- modify ')).length).toBe(2);
  });
});
