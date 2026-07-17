import { describe, test, expect, mock } from 'bun:test';
import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PipelineLogger } from '../../src/sdk/pipeline-logger.ts';
import {
  parseAgentOutput,
  consumeAgentStream,
  resolveActiveAgent,
} from '../../src/sdk/agent-stream.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal fake logger — casts to PipelineLogger (a class w/ private fields,
 *  so structural typing can't match a plain object without the cast). */
function fakeLogger() {
  return {
    log: mock(() => {}),
    logJson: mock(() => {}),
    logPrompt: mock(() => {}),
    stageComplete: mock(() => {}),
    stageError: mock(() => {}),
    onAgentName: mock(() => {}),
    setAgentName: mock(() => {}),
  };
}

function asLogger(fake: ReturnType<typeof fakeLogger>): PipelineLogger {
  return fake as unknown as PipelineLogger;
}

async function* fakeMessages(...messages: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>, void> {
  for (const msg of messages) yield msg;
}

function asStream(gen: AsyncGenerator<Record<string, unknown>, void>): AsyncIterable<SDKMessage> {
  return gen as unknown as AsyncIterable<SDKMessage>;
}

function initMessage(sessionId = 'sess-1'): Record<string, unknown> {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

function assistantText(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function assistantToolUse(toolName: string, opts?: { id?: string; input?: unknown; parentToolUseId?: string }): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: opts?.parentToolUseId ?? null,
    message: { content: [{ type: 'tool_use', name: toolName, id: opts?.id, input: opts?.input }] },
  };
}

function resultSuccess(opts?: {
  structuredOutput?: unknown;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: opts?.structuredOutput,
    result: opts?.result ?? 'Done',
    total_cost_usd: opts?.costUsd ?? 0.05,
    duration_ms: opts?.durationMs ?? 1000,
    num_turns: opts?.numTurns ?? 3,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  };
}

function resultError(subtype: string, errors: string[] = ['boom']): Record<string, unknown> {
  return {
    type: 'result',
    subtype,
    errors,
    total_cost_usd: 0.01,
    duration_ms: 200,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// parseAgentOutput
// ---------------------------------------------------------------------------

const OutputSchema = z.object({ summary: z.string(), score: z.number() });

describe('parseAgentOutput', () => {
  test('prefers structured_output when present', () => {
    const data = { summary: 'ok', score: 1 };
    const result = parseAgentOutput({ structured_output: data, result: '{"summary":"wrong","score":2}' }, '', OutputSchema);

    expect(result).toEqual({ status: 'success', data });
  });

  test('falls back to parsing result as JSON when structured_output is absent', () => {
    const data = { summary: 'from result', score: 7 };
    const result = parseAgentOutput({ result: JSON.stringify(data) }, '', OutputSchema);

    expect(result).toEqual({ status: 'success', data });
  });

  test('falls back to a fenced ```json block in the last assistant text', () => {
    const data = { summary: 'from fence', score: 9 };
    const text = `Here is my answer:\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`;
    const result = parseAgentOutput({}, text, OutputSchema);

    expect(result).toEqual({ status: 'success', data });
  });

  test('falls back to a trailing {...} blob in the last assistant text when no fence is present', () => {
    const data = { summary: 'trailing', score: 3 };
    const text = `Some reasoning first.\n${JSON.stringify(data)}`;
    const result = parseAgentOutput({}, text, OutputSchema);

    expect(result).toEqual({ status: 'success', data });
  });

  test('falls through to assistant-text regex when result is not valid JSON', () => {
    const data = { summary: 'recovered', score: 4 };
    const text = `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
    const result = parseAgentOutput({ result: 'not json at all' }, text, OutputSchema);

    expect(result).toEqual({ status: 'success', data });
  });

  test('returns status "invalid" with the Zod error when data fails schema validation', () => {
    const result = parseAgentOutput({ structured_output: { summary: 123, score: 'nope' } }, '', OutputSchema);

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  test('returns status "none" when no output can be found anywhere', () => {
    const result = parseAgentOutput({}, '', OutputSchema);
    expect(result).toEqual({ status: 'none' });
  });

  test('returns status "none" when result is unparseable and assistant text has no JSON', () => {
    const result = parseAgentOutput({ result: 'nope' }, 'just some prose, no JSON here', OutputSchema);
    expect(result).toEqual({ status: 'none' });
  });

  test('logs diagnostics through the optional logger without throwing when omitted', () => {
    const logger = fakeLogger();
    const data = { summary: 'ok', score: 1 };
    parseAgentOutput({ structured_output: data }, '', OutputSchema, asLogger(logger));

    expect(logger.logJson).toHaveBeenCalledWith('STRUCTURED OUTPUT', data);
  });
});

// ---------------------------------------------------------------------------
// consumeAgentStream
// ---------------------------------------------------------------------------

describe('consumeAgentStream', () => {
  test('captures sessionId from the init message', async () => {
    const stream = asStream(fakeMessages(initMessage('sess-42'), resultSuccess()));
    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.sessionId).toBe('sess-42');
  });

  test('counts tool_use blocks per tool name across turns', async () => {
    const stream = asStream(fakeMessages(
      initMessage(),
      assistantToolUse('Read'),
      assistantToolUse('Grep'),
      assistantToolUse('Read'),
      resultSuccess(),
    ));

    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.toolCalls).toEqual({ Read: 2, Grep: 1 });
  });

  test('captures the last assistant text seen across multiple turns', async () => {
    const stream = asStream(fakeMessages(
      initMessage(),
      assistantText('first thought'),
      assistantText('final thought'),
      resultSuccess(),
    ));

    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.lastAssistantText).toBe('final thought');
  });

  test('detects a rate_limit_event message', async () => {
    const stream = asStream(fakeMessages(
      initMessage(),
      { type: 'rate_limit_event' },
      resultSuccess(),
    ));

    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.rateLimitHit).toBe(true);
  });

  test('does not flag rate limit when no rate_limit_event message occurs', async () => {
    const stream = asStream(fakeMessages(initMessage(), resultSuccess()));
    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.rateLimitHit).toBe(false);
  });

  test('captures telemetry and the terminal result message on success', async () => {
    const resultMsg = resultSuccess({ costUsd: 0.42, durationMs: 5000, numTurns: 9 });
    const stream = asStream(fakeMessages(initMessage(), resultMsg));

    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.costUsd).toBe(0.42);
    expect(result.durationMs).toBe(5000);
    expect(result.turns).toBe(9);
    expect(result.tokens).toEqual({ input: 10, output: 5, cacheRead: 1, cacheCreation: 2 });
    expect(result.resultMessage).toMatchObject({ type: 'result', subtype: 'success' });
  });

  test('captures an error result message as the terminal result', async () => {
    const stream = asStream(fakeMessages(initMessage(), resultError('error_during_execution', ['crash'])));
    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.resultMessage).toMatchObject({ type: 'result', subtype: 'error_during_execution', errors: ['crash'] });
  });

  test('returns resultMessage undefined when the stream ends without a result message', async () => {
    const stream = asStream(fakeMessages(initMessage(), assistantText('thinking...')));
    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.resultMessage).toBeUndefined();
  });

  test('stops consuming after the first result message', async () => {
    // A second message after `result` should never be observed — the loop
    // must treat `result` as terminal, matching the pre-extraction behavior
    // where every branch under `message.type === 'result'` either returned
    // or threw out of runAgent.
    const stream = asStream(fakeMessages(
      initMessage(),
      resultSuccess({ numTurns: 1 }),
      assistantText('should never be read'),
    ));

    const result = await consumeAgentStream(stream, { agentName: 'test-agent' });

    expect(result.lastAssistantText).toBe('');
  });

  test('attributes sub-agent tool calls via the logger when a Task dispatch precedes them', async () => {
    const logger = fakeLogger();
    const stream = asStream(fakeMessages(
      initMessage(),
      assistantToolUse('Task', { id: 'tool-1', input: { subagent_type: 'security-reviewer' } }),
      assistantToolUse('Read', { parentToolUseId: 'tool-1' }),
      resultSuccess(),
    ));

    await consumeAgentStream(stream, { agentName: 'pr-reviewer', logger: asLogger(logger) });

    expect(logger.setAgentName).toHaveBeenCalledWith('security-reviewer');
  });
});

// ---------------------------------------------------------------------------
// resolveActiveAgent (moved here from run-agent.ts; re-exported there too)
// ---------------------------------------------------------------------------

describe('resolveActiveAgent (re-export sanity)', () => {
  test('returns default when no parent id', () => {
    expect(resolveActiveAgent(undefined, new Map(), 'pr-reviewer')).toBe('pr-reviewer');
  });
});
