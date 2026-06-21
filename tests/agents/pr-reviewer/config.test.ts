import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  detectCherryPick,
  createPRReviewConfig,
  type PRReviewParams,
} from '../../../src/agents/pr-reviewer/config.ts';
import { createInitialState } from '../../../src/pipeline/initial-state.ts';
import type {
  PipelineConfig,
  PipelineContext,
  PipelineState,
} from '../../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'org',
      orgUrl: 'https://dev.azure.com/org',
      project: 'Example Software',
      repositoryId: 'repo-guid-123',
      repositoryName: 'Document Output - Extensions',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Area',
      iterationPath: 'Iter',
      pat: 'pat',
    },
    paths: { sessionRoot: '/session', targetRepo: '/session/doc', stateDir: '/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 },
      prPublished: { fixCommand: '/fix', timeoutHours: 48 },
      pollIntervalMinutes: 5,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al/Src', testAppRoot: 'Test', test: 'Test/Src' },
    ...overrides,
  } as PipelineConfig;
}

function mockParams(overrides?: Partial<PRReviewParams>): PRReviewParams {
  return {
    prId: 4242,
    repoKey: 'DocumentOutput',
    repoUrl: 'https://dev.azure.com/org/_git/repo',
    repositoryId: 'repo-guid-123',
    project: 'Example Software',
    sourceBranch: 'feature/fix-posting',
    targetBranch: 'master',
    ...overrides,
  };
}

function mockContext(config: PipelineConfig): PipelineContext {
  return {
    workItemId: 0,
    workItem: {
      id: 0,
      title: 'PR review',
      type: 'Task',
      state: 'Active',
      areaPath: config.azureDevOps.areaPath,
      iterationPath: config.azureDevOps.iterationPath,
      fields: {},
    },
    workItemType: 'Bug',
    config,
  };
}

function buildPromptFor(
  params?: Partial<PRReviewParams>,
  config?: Partial<PipelineConfig>,
  state?: PipelineState,
): string {
  const cfg = mockConfig(config);
  const agentConfig = createPRReviewConfig(cfg, mockParams(params));
  const s = state ?? createInitialState('pr-reviewer');
  return agentConfig.buildPrompt(s, mockContext(cfg));
}

describe('detectCherryPick', () => {
  test('detects Azure DevOps cherry-pick from PR title', () => {
    const result = detectCherryPick({ title: 'Cherry-pick Fix posting date calculation' });
    expect(result.isCherryPick).toBe(true);
  });

  test('extracts original PR ID from description with PR link', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick Fix posting date calculation',
      description: 'Cherry-picked from pull request !456 into hotfix/2026-Q2',
    });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBe(456);
  });

  test('extracts original PR ID from markdown link format', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick Fix posting date calculation',
      description: 'Cherry-picked from [pull request !789](https://dev.azure.com/org/proj/_git/repo/pullrequest/789)',
    });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBe(789);
  });

  test('returns no original PR ID when description has no PR reference', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick Fix posting date calculation',
      description: 'Some other description',
    });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBeUndefined();
  });

  test('non-cherry-pick PR returns false', () => {
    const result = detectCherryPick({ title: 'Fix posting date calculation' });
    expect(result.isCherryPick).toBe(false);
    expect(result.originalPrId).toBeUndefined();
  });

  test('case-insensitive title detection', () => {
    const result = detectCherryPick({ title: 'cherry-pick Fix posting date' });
    expect(result.isCherryPick).toBe(true);
  });

  test('handles undefined description gracefully', () => {
    const result = detectCherryPick({ title: 'Cherry-pick Fix posting' });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBeUndefined();
  });

  test('detects "Cherry-pick:" title format (colon, real Azure DevOps format)', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick: Fix XML not attached to email when fallback occurs',
    });
    expect(result.isCherryPick).toBe(true);
  });

  test('extracts original PR ID from real Azure DevOps cherry-pick description', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick: Fix XML not attached to email when fallback occurs',
      description: 'Cherry-pick of <strong><a href="https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo/pullrequest/45146">PR #45146</a></strong> to development/28.x.',
    });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBe(45146);
  });

  test('prefers URL match over ! reference for PR ID', () => {
    const result = detectCherryPick({
      title: 'Cherry-pick Fix something',
      description: 'Cherry-picked !99999 from https://dev.azure.com/org/proj/_git/repo/pullrequest/456',
    });
    expect(result.originalPrId).toBe(456);
  });

  test('detects cherry-pick from description when title is normal', () => {
    const result = detectCherryPick({
      title: 'Fix stale statement merge fields in PDF filename (#66858)',
      description: 'Cherry picked from !45682\n\nCherry-picked from commit `65159779`.',
    });
    expect(result.isCherryPick).toBe(true);
    expect(result.originalPrId).toBe(45682);
  });

  test('detects "cherry-picked from commit" in description', () => {
    const result = detectCherryPick({
      title: 'Fix something unrelated',
      description: 'Cherry-picked from commit abc123.',
    });
    expect(result.isCherryPick).toBe(true);
  });

  test('does not false-positive on "cherry" in unrelated context', () => {
    const result = detectCherryPick({
      title: 'Fix cherry blossom rendering',
      description: 'The cherry blossom animation was broken.',
    });
    expect(result.isCherryPick).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createPRReviewConfig — static config shape & tool scoping
// ---------------------------------------------------------------------------

describe('createPRReviewConfig — config shape', () => {
  const savedMechanism = process.env['CALLEE_MECHANISM'];
  afterEach(() => {
    if (savedMechanism === undefined) delete process.env['CALLEE_MECHANISM'];
    else process.env['CALLEE_MECHANISM'] = savedMechanism;
  });

  test('has correct agent name and core settings', () => {
    delete process.env['CALLEE_MECHANISM'];
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.name).toBe('pr-reviewer');
    expect(config.useClaudeCodePreset).toBe(true);
    expect(config.maxTurns).toBe(100);
    // No retries — comment posting is a non-idempotent side effect
    expect(config.maxRetries).toBe(1);
  });

  test('cwd is the session root (repo cloned there in container)', () => {
    delete process.env['CALLEE_MECHANISM'];
    const cfg = mockConfig();
    const config = createPRReviewConfig(cfg, mockParams());
    expect(config.cwd).toBe(cfg.paths.sessionRoot);
  });

  test('wires the azureDevOps MCP server', () => {
    delete process.env['CALLEE_MECHANISM'];
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.mcpServers).toBeDefined();
    const servers = typeof config.mcpServers === 'function'
      ? config.mcpServers(createInitialState('pr-reviewer'))
      : config.mcpServers!;
    expect(servers.azureDevOps).toBeDefined();
  });

  test('allowedTools includes both comment-posting MCP tools', () => {
    delete process.env['CALLEE_MECHANISM'];
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.allowedTools).toContain('mcp__azureDevOps__add_pull_request_comment');
    expect(config.allowedTools).toContain('mcp__azureDevOps__update_pull_request_comment');
    expect(config.allowedTools).toContain('mcp__azureDevOps__get_pull_request_changes');
    expect(config.allowedTools).toContain('Agent');
    expect(config.allowedTools).toContain('Bash');
  });

  test('mechanism "none" adds no LSP tool and no plugins', () => {
    process.env['CALLEE_MECHANISM'] = 'none';
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.allowedTools).not.toContain('LSP');
    expect(config.plugins ?? []).toHaveLength(0);
  });

  test('unset mechanism defaults to "none" (no LSP tool)', () => {
    delete process.env['CALLEE_MECHANISM'];
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.allowedTools).not.toContain('LSP');
  });

  test('mechanism "treesitter" adds no LSP tool (uses Bash helper instead)', () => {
    process.env['CALLEE_MECHANISM'] = 'treesitter';
    const config = createPRReviewConfig(mockConfig(), mockParams());
    expect(config.allowedTools).not.toContain('LSP');
    expect(config.plugins ?? []).toHaveLength(0);
  });

  test('mechanism is case-insensitive (LSP uppercase resolves to lsp)', () => {
    process.env['CALLEE_MECHANISM'] = 'LSP';
    const config = createPRReviewConfig(mockConfig(), mockParams());
    // LSP tool is added regardless of whether the plugin resolves on this host
    expect(config.allowedTools).toContain('LSP');
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — content assembled from params + config
// ---------------------------------------------------------------------------

describe('createPRReviewConfig — buildPrompt', () => {
  const savedMechanism = process.env['CALLEE_MECHANISM'];
  beforeEach(() => {
    process.env['CALLEE_MECHANISM'] = 'none';
  });
  afterEach(() => {
    if (savedMechanism === undefined) delete process.env['CALLEE_MECHANISM'];
    else process.env['CALLEE_MECHANISM'] = savedMechanism;
  });

  test('includes the PR id and repository name in the task line', () => {
    const prompt = buildPromptFor({ prId: 4242 });
    expect(prompt).toContain('Review Pull Request #4242');
    expect(prompt).toContain('Document Output - Extensions');
  });

  test('renders PR details block with branches, project, and repo id', () => {
    const prompt = buildPromptFor({
      prId: 777,
      sourceBranch: 'feature/x',
      targetBranch: 'development/28.x',
    });
    expect(prompt).toContain('**PR ID:** 777');
    expect(prompt).toContain('**Source branch:** feature/x');
    expect(prompt).toContain('**Target branch:** development/28.x');
    expect(prompt).toContain('**Project:** Example Software');
    expect(prompt).toContain('(ID: repo-guid-123)');
  });

  test('includes the URL line only when prUrl is provided', () => {
    const withUrl = buildPromptFor({ prUrl: 'https://dev.azure.com/org/_git/repo/pullrequest/4242' });
    expect(withUrl).toContain('**URL:** https://dev.azure.com/org/_git/repo/pullrequest/4242');

    const withoutUrl = buildPromptFor({ prUrl: undefined });
    expect(withoutUrl).not.toContain('**URL:**');
  });

  test('lists the 6 workflow phases', () => {
    const prompt = buildPromptFor();
    expect(prompt).toContain('1. Post an in-progress comment');
    expect(prompt).toContain('4. Dispatch the 7 analysis agents in parallel');
    expect(prompt).toContain('6. Update the PR comment with the full review');
  });

  test('omits REPLAY MODE when noPost is falsy', () => {
    const prompt = buildPromptFor({ noPost: false });
    expect(prompt).not.toContain('REPLAY MODE');
  });

  test('includes REPLAY MODE instructions when noPost is true', () => {
    const prompt = buildPromptFor({ noPost: true });
    expect(prompt).toContain('REPLAY MODE');
    expect(prompt).toContain('DO NOT post or update any PR comment');
    expect(prompt).toContain('commentId set to 0');
  });

  test('no empty lines survive the filter(Boolean) — no double-blank artifacts from omitted optionals', () => {
    const prompt = buildPromptFor({ prUrl: undefined, noPost: false });
    // The filter(Boolean) drops empty strings produced by omitted optional lines.
    // The blank separators that remain are intentional (literal '' joined by \n).
    expect(prompt).not.toContain('undefined');
    expect(prompt.startsWith('## Task')).toBe(true);
  });

  // --- Cherry-pick injection -------------------------------------------------

  test('does not inject cherry-pick section for a normal PR', () => {
    const prompt = buildPromptFor({ prTitle: 'Fix posting date', prDescription: 'Normal change' });
    expect(prompt).not.toContain('Cherry-Pick Detected');
  });

  test('does not inject cherry-pick section when prTitle is absent', () => {
    const prompt = buildPromptFor({ prTitle: undefined, prDescription: 'Cherry-picked from !99' });
    // Detection only runs when prTitle is present (see buildPrompt guard)
    expect(prompt).not.toContain('Cherry-Pick Detected');
  });

  test('injects cherry-pick section with known original PR id', () => {
    const prompt = buildPromptFor({
      prTitle: 'Cherry-pick: Fix XML attach',
      prDescription: 'Cherry-pick of PR via /pullrequest/45146 to development/28.x',
    });
    expect(prompt).toContain('## Cherry-Pick Detected');
    expect(prompt).toContain('Original PR: #45146');
    expect(prompt).toContain('Cherry-Pick Verification workflow in CLAUDE.md Phase 2');
  });

  test('injects cherry-pick section with unresolved original PR id', () => {
    const prompt = buildPromptFor({
      prTitle: 'Cherry-pick: Fix XML attach',
      prDescription: 'No traceable source here',
    });
    expect(prompt).toContain('## Cherry-Pick Detected');
    expect(prompt).toContain('could not be determined from description');
  });

  // --- Callee guide (mechanism-dependent) ------------------------------------

  test('mechanism "none" emits no callee guide', () => {
    process.env['CALLEE_MECHANISM'] = 'none';
    const prompt = buildPromptFor();
    expect(prompt).not.toContain('Resolving Called Procedures');
  });

  test('mechanism "lsp" injects the LSP callee guide', () => {
    process.env['CALLEE_MECHANISM'] = 'lsp';
    const prompt = buildPromptFor();
    expect(prompt).toContain('## Resolving Called Procedures (AL LSP)');
    expect(prompt).toContain('LSP goToDefinition');
    expect(prompt).toContain('LSP outgoingCalls');
    expect(prompt).toContain('LSP incomingCalls');
    expect(prompt).toContain('Pass this instruction to every analysis sub-agent.');
  });

  test('mechanism "treesitter" injects the al-symbol callee guide', () => {
    process.env['CALLEE_MECHANISM'] = 'treesitter';
    const prompt = buildPromptFor();
    expect(prompt).toContain('## Resolving Called Procedures (al-symbol)');
    expect(prompt).toContain('bun /app/scripts/al-symbol.ts def');
    expect(prompt).toContain('callees');
    expect(prompt).toContain('callers');
  });

  test('lsp guide and cherry-pick section coexist in one prompt', () => {
    process.env['CALLEE_MECHANISM'] = 'lsp';
    const prompt = buildPromptFor({
      prTitle: 'Cherry-pick: Fix bug',
      prDescription: 'Cherry-pick of /pullrequest/123',
    });
    expect(prompt).toContain('Resolving Called Procedures (AL LSP)');
    expect(prompt).toContain('## Cherry-Pick Detected');
    expect(prompt).toContain('Original PR: #123');
  });
});
