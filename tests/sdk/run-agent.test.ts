import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import type { PipelineState, PipelineContext, PipelineConfig } from '../../src/types/pipeline.types.ts';
import { AgentExecutionError, AgentValidationError, TransientAgentError, RateLimitError, BudgetExceededError } from '../../src/sdk/errors.ts';
import { buildSharedFragmentContent } from '../../src/sdk/prompt-loader.ts';

// ---------------------------------------------------------------------------
// Mock query() at the module boundary
// ---------------------------------------------------------------------------

let mockQuery: ReturnType<typeof mock>;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Import AFTER mock is set up
const { runAgent, isRetryableError, detectApiError } = await import('../../src/sdk/run-agent.ts');

// Shared temp agent directory for tests using the preset path
const testTempDir = mkdtempSync(join(tmpdir(), 'runagent-test-'));
const testAgentDir = join(testTempDir, 'test-agent');
const testTargetDir = join(testTempDir, 'target');
mkdirSync(testAgentDir, { recursive: true });
mkdirSync(testTargetDir, { recursive: true });
writeFileSync(join(testAgentDir, 'CLAUDE.md'), '# Test Agent');

afterAll(() => {
  rmSync(testTempDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockQuery = mock(() => { throw new Error('mockQuery not configured for this test'); });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
      iterationPath: 'Test',
      pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'claude-sonnet-4-20250514', perAgent: {} },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

function testContext(): PipelineContext {
  return {
    workItemId: 42,
    workItem: {
      id: 42, title: 'Test WI', type: 'Bug', state: 'Active',
      areaPath: 'Test', iterationPath: 'Test', fields: {},
    },
    workItemType: 'Bug',
    config: testConfig(),
  };
}

function testState(): PipelineState {
  return {
    currentStage: 'test-agent',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

const TestOutputSchema = z.object({
  summary: z.string(),
  score: z.number(),
});

function testAgentConfig(overrides?: Partial<AgentConfig<typeof TestOutputSchema>>): AgentConfig<typeof TestOutputSchema> {
  return {
    name: 'test-agent',
    useClaudeCodePreset: true,
    agentSourceDir: testAgentDir,
    cwd: testTargetDir,
    sharedPromptFragments: [],
    outputSchema: TestOutputSchema,
    allowedTools: [],
    buildPrompt: () => 'Test prompt',
    maxRetries: 1,
    retryBaseDelayMs: 0,
    ...overrides,
  };
}

async function* fakeMessages(...messages: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>, void> {
  for (const msg of messages) {
    yield msg;
  }
}

function initMessage(sessionId = 'test-session-123'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: 'test',
    claude_code_version: '1.0.0',
    cwd: '/tmp',
    apiKeySource: 'user',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'text',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-0000-0000-000000000000',
  };
}

function successMessage(structuredOutput: unknown, opts?: {
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: structuredOutput,
    total_cost_usd: opts?.costUsd ?? 0.05,
    duration_ms: opts?.durationMs ?? 1200,
    duration_api_ms: opts?.durationMs ?? 1000,
    num_turns: opts?.numTurns ?? 3,
    result: 'Done',
    stop_reason: 'end_turn',
    is_error: false,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 'test-session-123',
  };
}

function errorMessage(subtype: string, errors: string[] = ['Something went wrong']): Record<string, unknown> {
  return {
    type: 'result',
    subtype,
    errors,
    total_cost_usd: 0.02,
    duration_ms: 500,
    duration_api_ms: 400,
    num_turns: 1,
    result: '',
    is_error: true,
    usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-session-123',
  };
}

/** Get the arguments passed to the last query() call */
function getQueryCallArgs(): { prompt: string; options: Record<string, unknown> } {
  const calls = (mockQuery as ReturnType<typeof mock>).mock.calls;
  return calls[0]![0] as { prompt: string; options: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests: runAgent
// ---------------------------------------------------------------------------

describe('runAgent', () => {
  test('returns typed output and telemetry on success', async () => {
    const output = { summary: 'All good', score: 95 };

    mockQuery = mock(() => fakeMessages(
      initMessage('sess-42'),
      successMessage(output, { costUsd: 0.10, durationMs: 2000, numTurns: 5 }),
    ));

    const result = await runAgent(testAgentConfig(), testState(), testContext());

    expect(result.output).toEqual(output);
    expect(result.costUsd).toBe(0.10);
    expect(result.durationMs).toBe(2000);
    expect(result.turns).toBe(5);
    expect(result.sessionId).toBe('sess-42');
    expect(result.toolCalls).toEqual({});
  });

  test('counts tool_use blocks per tool name', async () => {
    const output = { summary: 'Done', score: 100 };

    const assistantMsg1 = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Grep' },
          { type: 'text', text: 'thinking...' },
        ],
      },
    };
    const assistantMsg2 = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'LSP' },
        ],
      },
    };

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      assistantMsg1,
      assistantMsg2,
      successMessage(output),
    ));

    const result = await runAgent(testAgentConfig(), testState(), testContext());

    expect(result.toolCalls).toEqual({ Read: 3, Grep: 1, LSP: 1 });
  });

  test('throws AgentValidationError when output fails schema validation', async () => {
    const badOutput = { summary: 123, score: 'not-a-number' };

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      successMessage(badOutput),
    ));

    await expect(
      runAgent(testAgentConfig(), testState(), testContext()),
    ).rejects.toBeInstanceOf(AgentValidationError);
  });

  test('wraps retryable AgentExecutionError in TransientAgentError after exhausting retries', async () => {
    mockQuery = mock(() => fakeMessages(
      initMessage(),
      errorMessage('error_during_execution', ['Tool failed', 'Timeout']),
    ));

    const err = await runAgent(testAgentConfig(), testState(), testContext())
      .catch((e: unknown) => e) as TransientAgentError;

    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err.stage).toBe('test-agent');
    expect(err.attempts).toBe(1);
    expect(err.lastError).toBeInstanceOf(AgentExecutionError);
  });

  test('throws AgentExecutionError on error_max_turns', async () => {
    mockQuery = mock(() => fakeMessages(
      initMessage(),
      errorMessage('error_max_turns', ['Exceeded 50 turns']),
    ));

    await expect(
      runAgent(testAgentConfig(), testState(), testContext()),
    ).rejects.toBeInstanceOf(AgentExecutionError);
  });

  test('wraps "no result" error in TransientAgentError after exhausting retries', async () => {
    mockQuery = mock(() => fakeMessages(
      initMessage(),
    ));

    const err = await runAgent(testAgentConfig(), testState(), testContext())
      .catch((e: unknown) => e) as TransientAgentError;

    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err.lastError).toBeInstanceOf(AgentExecutionError);
    expect((err.lastError as AgentExecutionError).details).toBe('No result message received from agent');
  });

  test('wraps missing structured_output in TransientAgentError after exhausting retries', async () => {
    const noOutputMsg = successMessage(undefined);
    delete noOutputMsg.structured_output;

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      noOutputMsg,
    ));

    await expect(
      runAgent(testAgentConfig(), testState(), testContext()),
    ).rejects.toBeInstanceOf(TransientAgentError);
  });

  test('surfaces usage-limit API error as RateLimitError, not schema validation', async () => {
    // The SDK puts the API error into the assistant's final text and returns a
    // success result with no structured_output. Without the guard, the error
    // JSON gets extracted, fails schema validation, and masks the real cause.
    const apiErrorText = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."},"request_id":"req_011CbLtwx5v8DdkKe3xMCWfj"}';
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: apiErrorText }] },
    };
    const noOutputMsg = successMessage(undefined);
    delete noOutputMsg.structured_output;

    mockQuery = mock(() => fakeMessages(initMessage(), assistantMsg, noOutputMsg));

    const err = await runAgent(testAgentConfig(), testState(), testContext())
      .catch((e: unknown) => e) as RateLimitError;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toContain('2026-06-01');
    // Usage limits are non-retryable: query() must be called exactly once.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('surfaces overloaded API error as retryable AgentExecutionError', async () => {
    const apiErrorText = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: apiErrorText }] },
    };
    const noOutputMsg = successMessage(undefined);
    delete noOutputMsg.structured_output;

    mockQuery = mock(() => fakeMessages(initMessage(), assistantMsg, noOutputMsg));

    // Retryable → wrapped in TransientAgentError after exhausting retries.
    const err = await runAgent(testAgentConfig({ maxRetries: 2, retryBaseDelayMs: 0 }), testState(), testContext())
      .catch((e: unknown) => e) as TransientAgentError;

    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err.lastError).toBeInstanceOf(AgentExecutionError);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('does not misclassify valid output when assistant text mentions an error', async () => {
    const output = { summary: 'recovered after a hiccup', score: 7 };
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I hit an API Error: 500 earlier but retried and succeeded.' }] },
    };

    mockQuery = mock(() => fakeMessages(initMessage(), assistantMsg, successMessage(output)));

    const result = await runAgent(testAgentConfig(), testState(), testContext());
    expect(result.output).toEqual(output);
  });

  test('passes correct options to query()', async () => {
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      successMessage(output),
    ));

    const customCwd = join(testTempDir, 'custom-cwd');
    mkdirSync(customCwd, { recursive: true });

    const config = testAgentConfig({
      allowedTools: ['Read', 'Bash'],
      maxTurns: 25,
      maxBudgetUsd: 1.50,
      model: 'claude-opus-4-20250514',
      cwd: customCwd,
      mcpServers: {
        devops: { type: 'stdio', command: 'npx', args: ['mcp-server'] },
      },
      plugins: [{ type: 'local', path: '/path/to/plugin' }],
    });

    await runAgent(config, testState(), testContext());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = getQueryCallArgs();

    expect(callArgs.prompt).toBe('Test prompt');
    expect(callArgs.options.allowedTools).toEqual(['Read', 'Bash']);
    expect(callArgs.options.maxTurns).toBe(25);
    expect(callArgs.options.maxBudgetUsd).toBe(1.50);
    expect(callArgs.options.model).toBe('claude-opus-4-20250514');
    expect(callArgs.options.cwd).toBe(customCwd);
    expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true);
    expect(callArgs.options.mcpServers).toEqual({
      devops: { type: 'stdio', command: 'npx', args: ['mcp-server'] },
    });
    expect(callArgs.options.outputFormat).toEqual({
      type: 'json_schema',
      schema: expect.any(Object),
    });
    expect(callArgs.options.plugins).toEqual([{ type: 'local', path: '/path/to/plugin' }]);
  });

  test('uses default model and maxTurns when not specified', async () => {
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      successMessage(output),
    ));

    await runAgent(testAgentConfig(), testState(), testContext());

    const callArgs = getQueryCallArgs();

    expect(callArgs.options.model).toBe('claude-sonnet-4-20250514');
    expect(callArgs.options.maxTurns).toBe(50);
    expect(callArgs.options.cwd).toBe(testTargetDir);
  });

  test('calls buildPrompt with state and context', async () => {
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      successMessage(output),
    ));

    const buildPrompt = mock((state: PipelineState, ctx: PipelineContext) => {
      return `Work item #${ctx.workItemId}: ${state.currentStage}`;
    });

    const config = testAgentConfig({ buildPrompt });
    const state = testState();
    const context = testContext();

    await runAgent(config, state, context);

    expect(buildPrompt).toHaveBeenCalledTimes(1);
    expect(buildPrompt).toHaveBeenCalledWith(state, context);

    const callArgs = getQueryCallArgs();
    expect(callArgs.prompt).toBe('Work item #42: test-agent');
  });
});

// ---------------------------------------------------------------------------
// Tests: isRetryableError
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  test('returns false for AgentValidationError', () => {
    expect(isRetryableError(new AgentValidationError('test', {}))).toBe(false);
  });

  test('returns false for AgentExecutionError with error_max_turns subtype', () => {
    const err = new AgentExecutionError('test', { subtype: 'error_max_turns', errors: [], costUsd: 0, durationMs: 0, turns: 0 });
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns false for AgentExecutionError with error_max_budget subtype', () => {
    const err = new AgentExecutionError('test', { subtype: 'error_max_budget', errors: [], costUsd: 0, durationMs: 0, turns: 0 });
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns true for AgentExecutionError with error_during_execution subtype', () => {
    const err = new AgentExecutionError('test', { subtype: 'error_during_execution', errors: ['crash'], costUsd: 0, durationMs: 0, turns: 0 });
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns true for AgentExecutionError with string details', () => {
    const err = new AgentExecutionError('test', 'No result message received from agent');
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns true for plain Error', () => {
    expect(isRetryableError(new Error('Process crashed'))).toBe(true);
  });

  test('returns false for non-Error values', () => {
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });

  test('returns false for RateLimitError', () => {
    const err = new RateLimitError('analyzer', '9pm UTC');
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns false for BudgetExceededError', () => {
    const err = new BudgetExceededError('analyzer', 5.0, 3.0);
    expect(isRetryableError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: detectApiError
// ---------------------------------------------------------------------------

describe('detectApiError', () => {
  test('detects usage-limit error from API Error envelope', () => {
    const text = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."},"request_id":"req_1"}';
    const result = detectApiError(text)!;

    expect(result).not.toBeNull();
    expect(result.status).toBe(400);
    expect(result.errorType).toBe('invalid_request_error');
    expect(result.isUsageLimit).toBe(true);
    expect(result.isOverloaded).toBe(false);
    expect(result.message).toContain('2026-06-01');
  });

  test('detects overloaded error', () => {
    const text = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const result = detectApiError(text)!;

    expect(result.status).toBe(529);
    expect(result.isOverloaded).toBe(true);
    expect(result.isUsageLimit).toBe(false);
  });

  test('detects error envelope without API Error prefix', () => {
    const text = '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}';
    const result = detectApiError(text)!;

    expect(result.errorType).toBe('rate_limit_error');
    expect(result.status).toBeUndefined();
  });

  test('returns null for normal prose mentioning errors', () => {
    expect(detectApiError('The function throws an error when the input is null.')).toBeNull();
    expect(detectApiError('I reviewed the PR and found no issues with error handling.')).toBeNull();
  });

  test('returns null for empty or missing text', () => {
    expect(detectApiError('')).toBeNull();
    expect(detectApiError(undefined)).toBeNull();
    expect(detectApiError(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: runAgent retry behavior
// ---------------------------------------------------------------------------

describe('runAgent (retry)', () => {
  test('retries on plain Error and succeeds on second attempt', async () => {
    const output = { summary: 'recovered', score: 42 };
    let callCount = 0;

    mockQuery = mock(() => {
      callCount++;
      if (callCount === 1) {
        async function* fail(): AsyncGenerator<Record<string, unknown>, void> {
          throw new Error('Process crashed');
        }
        return fail();
      }
      return fakeMessages(initMessage(), successMessage(output));
    });

    const result = await runAgent(
      testAgentConfig({ maxRetries: 2, retryBaseDelayMs: 0 }),
      testState(),
      testContext(),
    );

    expect(result.output).toEqual(output);
    expect(callCount).toBe(2);
  });

  test('does not retry AgentValidationError', async () => {
    const badOutput = { summary: 123, score: 'not-a-number' };
    let callCount = 0;

    mockQuery = mock(() => {
      callCount++;
      return fakeMessages(initMessage(), successMessage(badOutput));
    });

    await expect(
      runAgent(testAgentConfig({ maxRetries: 3, retryBaseDelayMs: 0 }), testState(), testContext()),
    ).rejects.toBeInstanceOf(AgentValidationError);

    expect(callCount).toBe(1);
  });

  test('does not retry AgentExecutionError with error_max_turns', async () => {
    let callCount = 0;

    mockQuery = mock(() => {
      callCount++;
      return fakeMessages(initMessage(), errorMessage('error_max_turns', ['Exceeded 50 turns']));
    });

    await expect(
      runAgent(testAgentConfig({ maxRetries: 3, retryBaseDelayMs: 0 }), testState(), testContext()),
    ).rejects.toBeInstanceOf(AgentExecutionError);

    expect(callCount).toBe(1);
  });

  test('throws TransientAgentError after all retries exhausted', async () => {
    mockQuery = mock(() => {
      async function* fail(): AsyncGenerator<Record<string, unknown>, void> {
        throw new Error('Connection timeout');
      }
      return fail();
    });

    const err = await runAgent(
      testAgentConfig({ maxRetries: 3, retryBaseDelayMs: 0 }),
      testState(),
      testContext(),
    ).catch((e: unknown) => e) as TransientAgentError;

    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err.attempts).toBe(3);
    expect(err.lastError.message).toBe('Connection timeout');
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: runAgent — Claude Code preset path
// ---------------------------------------------------------------------------

describe('runAgent (Claude Code preset path)', () => {
  let tempDir: string;
  let agentDir: string;
  let targetDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'runagent-preset-'));
    agentDir = join(tempDir, 'agent');
    targetDir = join(tempDir, 'cwd');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
  });

  function afterCleanup() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  test('uses claude_code preset when useClaudeCodePreset is true', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
    });

    await runAgent(config, testState(), testContext());

    const callArgs = getQueryCallArgs();
    expect(callArgs.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(callArgs.options.settingSources).toEqual(['project']);

    afterCleanup();
  });

  test('includes shared fragments as append in preset', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
      sharedPromptFragments: ['project-context.md'],
    });

    await runAgent(config, testState(), testContext());

    const callArgs = getQueryCallArgs();
    const sp = callArgs.options.systemPrompt as { type: string; preset: string; append?: string };
    expect(sp.type).toBe('preset');
    expect(sp.preset).toBe('claude_code');
    expect(sp.append).toBeDefined();
    // Public-stable token from src/prompts/project-context.md — proves the fragment
    // was loaded and appended, without depending on private/ overlay content.
    expect(sp.append).toContain('Project Context');

    afterCleanup();
  });

  test('adds Skill tool when agent has .claude/skills/', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
      allowedTools: ['Read', 'Glob'],
    });

    await runAgent(config, testState(), testContext());

    const callArgs = getQueryCallArgs();
    expect(callArgs.options.allowedTools).toEqual(['Read', 'Glob', 'Skill']);

    afterCleanup();
  });

  test('does not add Skill tool when no .claude/skills/', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
      allowedTools: ['Read', 'Glob'],
    });

    await runAgent(config, testState(), testContext());

    const callArgs = getQueryCallArgs();
    expect(callArgs.options.allowedTools).toEqual(['Read', 'Glob']);

    afterCleanup();
  });

  test('cleans up staged workspace after success', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
    });

    await runAgent(config, testState(), testContext());

    // CLAUDE.md should be cleaned up from target
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(false);

    afterCleanup();
  });

  test('cleans up staged workspace on error', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    mockQuery = mock(() => fakeMessages(
      initMessage(),
      errorMessage('error_during_execution'),
    ));

    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
    });

    await runAgent(config, testState(), testContext()).catch(() => {});

    // CLAUDE.md should be cleaned up from target even after error
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(false);

    afterCleanup();
  });

  test('uses preset path by default for migrated agents', async () => {
    const output = { summary: 'ok', score: 1 };

    mockQuery = mock(() => fakeMessages(initMessage(), successMessage(output)));

    // Default testAgentConfig uses useClaudeCodePreset: true
    const config = testAgentConfig({
      useClaudeCodePreset: true,
      agentSourceDir: agentDir,
      cwd: targetDir,
    });
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    await runAgent(config, testState(), testContext());

    const callArgs = getQueryCallArgs();
    // Preset path: systemPrompt is an object, settingSources is set
    expect(typeof callArgs.options.systemPrompt).toBe('object');
    expect(callArgs.options.settingSources).toEqual(['project']);

    afterCleanup();
  });
});

// ---------------------------------------------------------------------------
// Tests: agentStage (integration via mocked SDK query)
// ---------------------------------------------------------------------------

// agentStage wraps runAgent → query(). Since we mock query() above, we can
// test agentStage as an integration test here without a second mock.module
// (which would contaminate other test files in Bun's single-process runner).

import { agentStage } from '../../src/pipeline/stage.ts';
import type { AgentResult } from '../../src/types/agent.types.ts';

const StageTestSchema = z.object({ value: z.string() });

function stageAgentConfig(name: string, overrides?: Record<string, unknown>) {
  return {
    name,
    useClaudeCodePreset: true,
    agentSourceDir: testAgentDir,
    cwd: testTargetDir,
    sharedPromptFragments: [] as string[],
    outputSchema: StageTestSchema,
    allowedTools: [] as string[],
    buildPrompt: () => 'stage test prompt',
    maxRetries: 1,
    retryBaseDelayMs: 0,
    ...overrides,
  };
}

function freshState(): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

/** Build a success message with StageTestSchema output */
function stageSuccessMessage(output: { value: string }, opts?: {
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}): Record<string, unknown> {
  return successMessage(output, opts);
}

describe('agentStage (integration)', () => {
  test('execute calls runAgent, applies output, and records telemetry', async () => {
    mockQuery = mock(() => fakeMessages(
      initMessage('stage-sess-1'),
      stageSuccessMessage({ value: 'hello' }, { costUsd: 0.15, durationMs: 3000, numTurns: 7 }),
    ));

    let captured: { value: string } | undefined;
    const stage = agentStage({
      agent: stageAgentConfig('analyzer'),
      canRun: () => true,
      applyOutput: (s, output) => { captured = output; return s; },
    });

    const result = await stage.execute(freshState(), testContext());

    expect(captured).toEqual({ value: 'hello' });
    expect(result.telemetry.totalCostUsd).toBe(0.15);
    expect(result.telemetry.totalDurationMs).toBe(3000);
    expect(result.telemetry.stages).toHaveLength(1);
    expect(result.telemetry.stages[0]!.name).toBe('analyzer');
    expect(result.telemetry.stages[0]!.costUsd).toBe(0.15);
    expect(result.telemetry.stages[0]!.turns).toBe(7);
    expect(result.telemetry.stages[0]!.toolCalls).toEqual({});
  });

  test('execute propagates toolCalls into telemetry', async () => {
    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    };

    mockQuery = mock(() => fakeMessages(
      initMessage('stage-sess-tc'),
      assistantMsg,
      stageSuccessMessage({ value: 'tools' }, { costUsd: 0.08, durationMs: 1500, numTurns: 4 }),
    ));

    const stage = agentStage({
      agent: stageAgentConfig('analyzer'),
      canRun: () => true,
      applyOutput: (s, _output) => s,
    });

    const result = await stage.execute(freshState(), testContext());

    expect(result.telemetry.stages[0]!.toolCalls).toEqual({ Read: 2, Bash: 1 });
  });

  test('execute accumulates telemetry from previous stages', async () => {
    mockQuery = mock(() => fakeMessages(
      initMessage('stage-sess-2'),
      stageSuccessMessage({ value: 'world' }, { costUsd: 0.05, durationMs: 1000, numTurns: 2 }),
    ));

    const stage = agentStage({
      agent: stageAgentConfig('analyzer'),
      canRun: () => true,
      applyOutput: (s, _output) => s,
    });

    const state: PipelineState = {
      ...freshState(),
      telemetry: {
        totalCostUsd: 0.10,
        totalDurationMs: 2000,
        stages: [{ name: 'first-agent', costUsd: 0.10, durationMs: 2000, turns: 3, model: 'test', timestamp: 'T' }],
      },
    };

    const result = await stage.execute(state, testContext());

    expect(result.telemetry.totalCostUsd).toBeCloseTo(0.15);
    expect(result.telemetry.totalDurationMs).toBe(3000);
    expect(result.telemetry.stages).toHaveLength(2);
    expect(result.telemetry.stages[1]!.name).toBe('analyzer');
  });

  test('execute propagates runAgent errors', async () => {
    // query() throws immediately — plain Error is retryable, so after
    // exhausting retries (maxRetries: 1) it becomes TransientAgentError
    mockQuery = mock(() => {
      async function* fail(): AsyncGenerator<Record<string, unknown>, void> {
        throw new Error('Agent failed');
      }
      return fail();
    });

    const stage = agentStage({
      agent: stageAgentConfig('analyzer'),
      canRun: () => true,
      applyOutput: (s, _output) => s,
    });

    await expect(stage.execute(freshState(), testContext())).rejects.toBeInstanceOf(TransientAgentError);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSharedFragmentContent integration
// ---------------------------------------------------------------------------

describe('buildSharedFragmentContent integration', () => {
  test('assembles content from shared fragments', () => {
    const content = buildSharedFragmentContent(['project-context.md']);

    // Public-stable token (overlay-independent): the public project-context.md
    // fragment is neutralized, so assert on its heading, not proprietary content.
    expect(content).toContain('Project Context');
  });

  test('joins multiple fragments with separator', () => {
    const content = buildSharedFragmentContent(['project-context.md', 'repo-structure.md']);

    expect(content).toContain('---');
    // Content from BOTH fragments, using public-stable tokens.
    expect(content).toContain('Project Context');
    expect(content).toContain('Repository Structure');
  });

  test('returns empty string for no fragments', () => {
    const content = buildSharedFragmentContent([]);

    expect(content).toBe('');
  });

  test('throws for non-existent fragment', () => {
    expect(() => buildSharedFragmentContent(['non-existent.md'])).toThrow('Failed to read prompt file');
  });
});
