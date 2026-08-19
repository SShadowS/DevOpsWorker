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

// ---------------------------------------------------------------------------
// modelUsage — per-model cost split
//
// An orchestrator's total_cost_usd covers itself AND every sub-agent it
// dispatches, while `usage` reports only its own tokens — so neither answers
// "was the spend in the orchestrator or the fan-out?". modelUsage is keyed by
// model, which separates them whenever they run on different models.
// ---------------------------------------------------------------------------

describe('consumeAgentStream modelUsage', () => {
  test('splits orchestrator and sub-agent spend by model', async () => {
    async function* stream() {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 13.12,
        duration_ms: 1000,
        num_turns: 18,
        usage: {
          input_tokens: 13, output_tokens: 49862,
          cache_read_input_tokens: 478034, cache_creation_input_tokens: 217769,
        },
        modelUsage: {
          'claude-opus-5': {
            inputTokens: 13, outputTokens: 49862,
            cacheReadInputTokens: 478034, cacheCreationInputTokens: 217769,
            costUSD: 2.85,
          },
          'claude-sonnet-5': {
            inputTokens: 900, outputTokens: 120000,
            cacheReadInputTokens: 50000, cacheCreationInputTokens: 30000,
            costUSD: 10.27,
          },
        },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });

    expect(out.costUsd).toBe(13.12);
    expect(Object.keys(out.modelUsage).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(out.modelUsage['claude-opus-5']!.costUsd).toBe(2.85);
    expect(out.modelUsage['claude-sonnet-5']!.costUsd).toBe(10.27);
    // the split accounts for the total the single costUsd figure could not explain
    const summed = Object.values(out.modelUsage).reduce((a, m) => a + m.costUsd, 0);
    expect(summed).toBeCloseTo(out.costUsd, 2);
  });

  test('is an empty object when the SDK reports no modelUsage', async () => {
    async function* stream() {
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 1, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    }
    const out = await consumeAgentStream(stream(), { agentName: 'coder' });
    expect(out.modelUsage).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// subAgents — per-named-sub-agent attribution
//
// modelUsage answers "which model", not "which reviewer". Eight sub-agents
// sharing claude-sonnet-5 collapse into one modelUsage entry, so the only way
// to tell an expensive reviewer from a cheap one is to attribute each assistant
// turn to the subagent_type that produced it.
// ---------------------------------------------------------------------------

function assistantTurn(
  subagentType: string | undefined,
  usage: { input: number; output: number; cacheRead?: number; cacheCreation?: number },
  content: unknown[] = [],
  model = 'claude-sonnet-5',
) {
  return {
    type: 'assistant',
    ...(subagentType ? { subagent_type: subagentType } : {}),
    message: {
      model,
      content,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  } as never;
}

describe('consumeAgentStream subAgents', () => {
  test('separates two named sub-agents sharing one model', async () => {
    async function* stream() {
      yield assistantTurn(undefined, { input: 5, output: 5 }, [], 'claude-opus-5');
      yield assistantTurn('security-reviewer', { input: 100, output: 200, cacheRead: 1000 }, [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Grep' },
      ]);
      yield assistantTurn('security-reviewer', { input: 50, output: 100 }, [
        { type: 'tool_use', name: 'Read' },
      ]);
      yield assistantTurn('performance-reviewer', { input: 10, output: 20 }, [
        { type: 'tool_use', name: 'LSP' },
      ]);
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 3, duration_ms: 1, num_turns: 4,
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 160, outputTokens: 320, cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 0, costUSD: 2.0,
          },
        },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });

    expect(Object.keys(out.subAgents).sort()).toEqual(['performance-reviewer', 'security-reviewer']);

    const sec = out.subAgents['security-reviewer']!;
    expect(sec.turns).toBe(2);
    expect(sec.tokens).toEqual({ input: 150, output: 300, cacheRead: 1000, cacheCreation: 0 });
    expect(sec.toolCalls).toEqual({ Read: 2, Grep: 1 });
    expect(sec.model).toBe('claude-sonnet-5');

    const perf = out.subAgents['performance-reviewer']!;
    expect(perf.turns).toBe(1);
    expect(perf.toolCalls).toEqual({ LSP: 1 });

    // aggregate toolCalls still counts every call, sub-agent or not
    expect(out.toolCalls).toEqual({ Read: 2, Grep: 1, LSP: 1 });
  });

  test('apportions each sub-agent a share of its model cost by tokens', async () => {
    async function* stream() {
      yield assistantTurn('a-reviewer', { input: 750, output: 0 });
      yield assistantTurn('b-reviewer', { input: 250, output: 0 });
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 5, duration_ms: 1, num_turns: 2,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 2000, outputTokens: 0, cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0, costUSD: 4.0,
          },
        },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });

    // 750/2000 and 250/2000 of $4.00
    expect(out.subAgents['a-reviewer']!.apportionedCostUsd).toBeCloseTo(1.5, 5);
    expect(out.subAgents['b-reviewer']!.apportionedCostUsd).toBeCloseTo(0.5, 5);
    // the unapportioned $2.00 is the orchestrator's own share, not redistributed
    const attributed = Object.values(out.subAgents)
      .reduce((a, s) => a + (s.apportionedCostUsd ?? 0), 0);
    expect(attributed).toBeCloseTo(2.0, 5);
  });

  test('falls back to parent_tool_use_id when subagent_type is absent', async () => {
    async function* stream() {
      // dispatch: the Task tool_use whose id later identifies the sub-agent
      yield {
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Task', input: { subagent_type: 'al-idiom-reviewer' } }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      } as never;
      yield {
        type: 'assistant',
        parent_tool_use_id: 'tu_1',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'tool_use', name: 'Read' }],
          usage: { input_tokens: 40, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      } as never;
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 1, duration_ms: 1, num_turns: 2,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });

    expect(Object.keys(out.subAgents)).toEqual(['al-idiom-reviewer']);
    expect(out.subAgents['al-idiom-reviewer']!.tokens.output).toBe(60);
    expect(out.subAgents['al-idiom-reviewer']!.toolCalls).toEqual({ Read: 1 });
  });

  test('is an empty object for an agent that dispatches nothing', async () => {
    async function* stream() {
      yield assistantTurn(undefined, { input: 1, output: 1 }, [{ type: 'tool_use', name: 'Bash' }], 'claude-sonnet-5');
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 1, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    }
    const out = await consumeAgentStream(stream(), { agentName: 'coder' });
    expect(out.subAgents).toEqual({});
  });
});

describe('consumeAgentStream subAgents — split assistant turns', () => {
  test('one API turn split across messages counts once, but every tool call counts', async () => {
    // The SDK may emit several assistant messages for a single API turn; they
    // share message.id and repeat the turn's usage. Summing them naively would
    // double-count both turns and tokens.
    const fragment = (blocks: unknown[]) => ({
      type: 'assistant',
      subagent_type: 'security-reviewer',
      message: {
        id: 'msg_same',
        model: 'claude-sonnet-5',
        content: blocks,
        usage: {
          input_tokens: 100, output_tokens: 200,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        },
      },
    }) as never;

    async function* stream() {
      yield fragment([{ type: 'tool_use', name: 'Read' }]);
      yield fragment([{ type: 'tool_use', name: 'Grep' }]);
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 1, duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });
    const sec = out.subAgents['security-reviewer']!;

    expect(sec.turns).toBe(1);
    expect(sec.tokens.input).toBe(100);
    expect(sec.tokens.output).toBe(200);
    // tool calls are per-block, so both fragments' calls count
    expect(sec.toolCalls).toEqual({ Read: 1, Grep: 1 });
  });

  test('distinct message ids still count as distinct turns', async () => {
    const turn = (id: string) => ({
      type: 'assistant',
      subagent_type: 'security-reviewer',
      message: {
        id,
        model: 'claude-sonnet-5',
        content: [],
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) as never;

    async function* stream() {
      yield turn('msg_a');
      yield turn('msg_b');
      yield {
        type: 'result', subtype: 'success', total_cost_usd: 1, duration_ms: 1, num_turns: 2,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });
    expect(out.subAgents['security-reviewer']!.turns).toBe(2);
    expect(out.subAgents['security-reviewer']!.tokens.input).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// subAgents — sub-agents that run as BACKGROUND TASKS
//
// The roster undercounts, and it undercounts silently. Every entry above is
// reconstructed from the sub-agent's own assistant messages, which reach the
// parent stream only for sub-agents running in the FOREGROUND. A sub-agent the
// SDK runs as a background task never streams into the parent at all, so it
// produced no entry — while `toolCalls.Agent` counted the dispatch.
//
// Measured on WI 76447 (2026-08-03): both plan-reviewer rounds recorded
// `Agent: 4` while the roster held 1 and 2. Five of eight dispatches were
// invisible, model included. The same defect is documented on the PR-review path
// in scripts/pr-review-eval/compliance.ts — it lives HERE, in shared code, so it
// was never PR-reviewer-specific; nobody had checked the pipeline because the
// pipeline had no roster data at all until 2026-08-03.
//
// The SDK does announce these, on message types this parser ignored:
//   task_started      — task_id, tool_use_id?, subagent_type?
//   task_progress     — task_id, subagent_type?, usage{total_tokens,tool_uses,duration_ms}
//   task_notification — task_id, status, usage?  (no subagent_type — join on task_id)
// Shapes taken from the SDK's own sdk.d.ts, not guessed from observed traffic.
// ---------------------------------------------------------------------------

function taskStarted(taskId: string, subagentType?: string, toolUseId?: string): Record<string, unknown> {
  return {
    type: 'system', subtype: 'task_started',
    task_id: taskId,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(subagentType ? { subagent_type: subagentType } : {}),
    description: 'doing work',
    uuid: '00000000-0000-0000-0000-0000000000aa', session_id: 'sess-1',
  };
}

function taskNotification(
  taskId: string,
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number },
): Record<string, unknown> {
  return {
    type: 'system', subtype: 'task_notification',
    task_id: taskId, status: 'completed', output_file: '/tmp/out', summary: 'done',
    ...(usage ? { usage } : {}),
    uuid: '00000000-0000-0000-0000-0000000000bb', session_id: 'sess-1',
  };
}

describe('consumeAgentStream subAgents — background tasks', () => {
  test('a background sub-agent gets a roster entry, so the count matches the dispatches', async () => {
    // THE bug. Nothing here streams an assistant message carrying subagent_type,
    // which is exactly the situation that produced 4 dispatches and 1 entry.
    async function* stream() {
      yield initMessage() as never;
      yield assistantToolUse('Agent', { id: 'tu-1', input: { subagent_type: 'feasibility-reviewer' } }) as never;
      yield assistantToolUse('Agent', { id: 'tu-2', input: { subagent_type: 'scope-creep-reviewer' } }) as never;
      yield taskStarted('task-1', 'feasibility-reviewer', 'tu-1') as never;
      yield taskStarted('task-2', 'scope-creep-reviewer', 'tu-2') as never;
      yield taskNotification('task-1', { total_tokens: 4200, tool_uses: 7, duration_ms: 31000 }) as never;
      yield taskNotification('task-2', { total_tokens: 1100, tool_uses: 2, duration_ms: 9000 }) as never;
      yield resultSuccess() as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'plan-reviewer' });

    expect(Object.keys(out.subAgents).sort()).toEqual(['feasibility-reviewer', 'scope-creep-reviewer']);
    // the invariant the undercount broke: roster size == dispatch count
    expect(Object.keys(out.subAgents)).toHaveLength(out.toolCalls['Agent']!);
  });

  test('a background entry is marked as such, so zero tokens does not read as "did nothing"', async () => {
    // Fixing the COUNT without this swaps one lie for another: a background entry
    // has no input/output/cache split, so it would look like a sub-agent that was
    // dispatched and produced nothing.
    async function* stream() {
      yield initMessage() as never;
      yield taskStarted('task-1', 'feasibility-reviewer', 'tu-1') as never;
      yield taskNotification('task-1', { total_tokens: 4200, tool_uses: 7, duration_ms: 31000 }) as never;
      yield resultSuccess() as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'plan-reviewer' });
    const entry = out.subAgents['feasibility-reviewer']!;

    expect(entry.source).toBe('background_task');
    expect(entry.totalTokens).toBe(4200);
    expect(entry.toolUseCount).toBe(7);
    expect(entry.durationMs).toBe(31000);
    // the detailed fields stay honestly empty rather than being faked from a total
    expect(entry.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(entry.model).toBeUndefined();
  });

  test('a streamed sub-agent keeps its full detail and is marked stream, not background', async () => {
    async function* stream() {
      yield initMessage() as never;
      yield {
        type: 'assistant', subagent_type: 'security-reviewer',
        message: {
          id: 'm1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
        },
      } as never;
      yield resultSuccess() as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'code-reviewer' });
    const entry = out.subAgents['security-reviewer']!;

    expect(entry.source).toBe('stream');
    expect(entry.tokens.input).toBe(10);
    expect(entry.model).toBe('claude-sonnet-5');
    expect(entry.totalTokens).toBeUndefined();
  });

  test('a sub-agent that starts as a task AND streams keeps the streamed detail', async () => {
    // The SDK can background an in-flight foreground task, so both paths can fire
    // for one dispatch. Streamed detail is strictly richer — a later task_started
    // must not downgrade it to a background entry.
    async function* stream() {
      yield initMessage() as never;
      yield {
        type: 'assistant', subagent_type: 'feasibility-reviewer',
        message: {
          id: 'm1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      } as never;
      yield taskStarted('task-1', 'feasibility-reviewer', 'tu-1') as never;
      yield taskNotification('task-1', { total_tokens: 4200, tool_uses: 7, duration_ms: 31000 }) as never;
      yield resultSuccess() as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'plan-reviewer' });
    const entry = out.subAgents['feasibility-reviewer']!;

    expect(entry.source).toBe('stream');
    expect(entry.tokens.input).toBe(10);
    expect(entry.model).toBe('claude-sonnet-5');
    expect(Object.keys(out.subAgents)).toHaveLength(1);
  });

  test('non-subagent background tasks (shell, monitor, workflow) never enter the roster', async () => {
    // `subagent_type` is present only for subagent tasks. A backgrounded Bash
    // command must not surface as a sub-agent.
    async function* stream() {
      yield initMessage() as never;
      yield taskStarted('task-shell', undefined, 'tu-9') as never;
      yield taskNotification('task-shell', { total_tokens: 10, tool_uses: 1, duration_ms: 500 }) as never;
      yield resultSuccess() as never;
    }

    const out = await consumeAgentStream(stream(), { agentName: 'coder' });

    expect(out.subAgents).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Pairing a tool call with its result.
//
// Both halves are logged, but until now they shared no identifier: the input
// block carried the tool name and no id, the result block carried the id and no
// name. Reading a log back, you could see that an LSP call happened and,
// separately, that some result arrived — and could only guess which belonged to
// which by their order in time. Anything concurrent (the seven sub-agents run in
// parallel) made even that unreliable.
//
// The id is the SDK's own `tool_use_id`, already present on both messages.
// ---------------------------------------------------------------------------
describe('consumeAgentStream — tool call and result share an id', () => {
  test('the input label carries the tool_use_id', async () => {
    const logger = fakeLogger();
    await consumeAgentStream(
      asStream(fakeMessages(
        initMessage(),
        assistantToolUse('LSP', { id: 'toolu_abc123', input: { operation: 'hover', line: 65 } }),
        resultSuccess(),
      )),
      { logger: asLogger(logger), agentName: 'pr-reviewer' },
    );
    expect(logger.logJson).toHaveBeenCalledWith(
      'TOOL INPUT: LSP (toolu_abc123)',
      { operation: 'hover', line: 65 },
    );
  });

  test('the tool name still leads the label, so filtering by tool keeps working', async () => {
    // Existing queries do `content LIKE '%TOOL INPUT: LSP%'`; the id is appended
    // rather than inserted so none of them have to change.
    const logger = fakeLogger();
    await consumeAgentStream(
      asStream(fakeMessages(
        initMessage(),
        assistantToolUse('LSP', { id: 'toolu_abc123', input: { operation: 'hover' } }),
        resultSuccess(),
      )),
      { logger: asLogger(logger), agentName: 'pr-reviewer' },
    );
    const labels = logger.logJson.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(labels.some((l) => l.startsWith('TOOL INPUT: LSP'))).toBe(true);
  });

  test('a call with no id still logs, without an empty bracket', async () => {
    const logger = fakeLogger();
    await consumeAgentStream(
      asStream(fakeMessages(
        initMessage(),
        assistantToolUse('Bash', { input: { command: 'git status' } }),
        resultSuccess(),
      )),
      { logger: asLogger(logger), agentName: 'pr-reviewer' },
    );
    expect(logger.logJson).toHaveBeenCalledWith('TOOL INPUT: Bash', { command: 'git status' });
  });
});

// ---------------------------------------------------------------------------
// Sub-agent reports are logged whole
//
// Tool results were capped at 2,000 chars to stop a `grep -rn` dump filling the
// log. That cap also fell on the one tool result that IS the product: what a
// sub-agent hands back to the orchestrator. Measured over three days, 110 of
// 129 sub-agent returns were cut, average true length 4,245 chars — so the
// stored record of a review held roughly half the evidence its findings were
// written from, and could not be replayed against a different prompt.
// ---------------------------------------------------------------------------

describe('tool result logging', () => {
  const LIMIT = 2000;

  /** A dispatch to a sub-agent, then that sub-agent's reply. */
  function dispatchAndReply(toolName: string, toolUseId: string, reply: string) {
    return [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: toolUseId, name: toolName, input: { subagent_type: 'code-review-validator' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: reply }] },
      },
    ];
  }

  function loggedResult(fake: ReturnType<typeof fakeLogger>): string {
    const calls = fake.logPrompt.mock.calls as unknown as unknown[][];
    const call = calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('TOOL RESULT'),
    );
    return typeof call?.[1] === 'string' ? call[1] : '';
  }

  test('keeps a sub-agent report in full', async () => {
    const report = 'FINDING: '.repeat(900); // ~8k chars, past the old cap
    const fake = fakeLogger();

    await consumeAgentStream(
      asStream(fakeMessages(...dispatchAndReply('Agent', 'toolu_sub1', report))),
      { agentName: 'pr-reviewer', logger: asLogger(fake) } as never,
    );

    const logged = loggedResult(fake);
    expect(logged).toBe(report);
    expect(logged).not.toContain('truncated');
  });

  test('keeps a report from the Task tool too', async () => {
    // Both spellings dispatch a sub-agent; the id map already treats them alike.
    const report = 'x'.repeat(LIMIT + 500);
    const fake = fakeLogger();

    await consumeAgentStream(
      asStream(fakeMessages(...dispatchAndReply('Task', 'toolu_sub2', report))),
      { agentName: 'pr-reviewer', logger: asLogger(fake) } as never,
    );

    expect(loggedResult(fake)).toBe(report);
  });

  test('still caps an ordinary tool result', async () => {
    // The cap exists for a reason: one `grep -rn` over a repo is worth more
    // log volume than every sub-agent report in the run put together.
    const dump = 'y'.repeat(LIMIT + 500);
    const fake = fakeLogger();

    await consumeAgentStream(
      asStream(fakeMessages(
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'grep -rn x .' } }] },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: dump }] } },
      )),
      { agentName: 'pr-reviewer', logger: asLogger(fake) } as never,
    );

    const logged = loggedResult(fake);
    expect(logged.length).toBeLessThan(dump.length);
    expect(logged).toContain(`truncated, ${dump.length} chars total`);
  });

  test('caps a result whose dispatch was never seen', async () => {
    // No matching tool_use means we cannot tell what this is, and an unbounded
    // default would put the cap back at the mercy of a dropped message.
    const dump = 'z'.repeat(LIMIT + 500);
    const fake = fakeLogger();

    await consumeAgentStream(
      asStream(fakeMessages(
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: dump }] } },
      )),
      { agentName: 'pr-reviewer', logger: asLogger(fake) } as never,
    );

    expect(loggedResult(fake)).toContain('truncated');
  });

  test('leaves a short result untouched either way', async () => {
    const fake = fakeLogger();

    await consumeAgentStream(
      asStream(fakeMessages(...dispatchAndReply('Agent', 'toolu_sub3', 'no findings'))),
      { agentName: 'pr-reviewer', logger: asLogger(fake) } as never,
    );

    expect(loggedResult(fake)).toBe('no findings');
  });
});
