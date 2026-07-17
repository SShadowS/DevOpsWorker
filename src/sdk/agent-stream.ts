import { z } from 'zod';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PipelineLogger } from './pipeline-logger.ts';
import type { StageTokenUsage } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// agent-stream — extracted from runAgent's `for await (const message of
// query(...))` loop (src/sdk/run-agent.ts). Splits the message-consumption
// concerns (session/telemetry/tool-call accumulation, sub-agent attribution)
// from the output-extraction ladder (structured_output → result-JSON →
// regex), so both are independently unit-testable without mocking the SDK's
// `query()` at the module boundary.
// ---------------------------------------------------------------------------

/** Max chars to log for tool results (prevents huge log files from file reads). */
const TOOL_RESULT_LOG_LIMIT = 2000;

// ---------------------------------------------------------------------------
// resolveActiveAgent — sub-agent attribution
// ---------------------------------------------------------------------------

/**
 * Resolve which agent a tool call belongs to. Nested sub-agent tool calls carry
 * a parent_tool_use_id matching the Task/Agent dispatch that spawned them; we map
 * that back to the sub-agent's name. Falls back to the default (orchestrator) name.
 */
export function resolveActiveAgent(
  parentToolUseId: string | undefined,
  subAgentByToolUseId: Map<string, string>,
  defaultName: string,
): string {
  if (parentToolUseId && subAgentByToolUseId.has(parentToolUseId)) {
    return subAgentByToolUseId.get(parentToolUseId)!;
  }
  return defaultName;
}

// ---------------------------------------------------------------------------
// consumeAgentStream — drains the SDK message stream into a normalized result
// ---------------------------------------------------------------------------

export interface ConsumeStreamContext {
  /** Name of the top-level agent (used for console/log prefixes and as the
   *  attribution fallback when no sub-agent dispatch is in scope). */
  agentName: string;
  logger?: PipelineLogger;
}

export interface ConsumedAgentStream {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Text of the most recent assistant turn. Feeds the output-extraction
   *  fallback ladder (parseAgentOutput) and API-error detection in runAgent. */
  lastAssistantText: string;
  /** Whether the SDK emitted a `rate_limit_event` message during this run. */
  rateLimitHit: boolean;
  tokens: StageTokenUsage;
  toolCalls: Record<string, number>;
  /** The terminal SDK `result` message, or undefined if the stream ended
   *  without ever producing one (caller treats this as a transient failure). */
  resultMessage?: SDKResultMessage;
}

/**
 * Drain an SDK message stream (`query(...)`), accumulating telemetry and
 * returning a normalized snapshot once the terminal `result` message arrives
 * (or the stream ends without one). Every branch of the original loop that
 * touched a `result` message either `return`ed from `runAgent` or `throw`;
 * this function never does either — it stops at the first `result` message
 * (`break`) and hands the raw message back for the caller (runAgent) to
 * interpret via `parseAgentOutput` + the existing retry/error machinery.
 */
export async function consumeAgentStream(
  stream: AsyncIterable<SDKMessage>,
  ctx: ConsumeStreamContext,
): Promise<ConsumedAgentStream> {
  const { agentName, logger } = ctx;

  let sessionId = '';
  let costUsd = 0;
  let durationMs = 0;
  let turns = 0;
  let turnCounter = 0;
  let lastAssistantText = '';
  let rateLimitHit = false;
  const tokens: StageTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const toolCalls: Record<string, number> = {};
  const subAgentByToolUseId = new Map<string, string>();
  let resultMessage: SDKResultMessage | undefined;

  for await (const message of stream) {
    // Log all message types for diagnostics
    logger?.log(`  [msg] type=${message.type}${'subtype' in message ? ` subtype=${(message as any).subtype}` : ''}`);

    // Capture session ID from init message
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }

    // Detect rate limit events (Claude MAX subscription or API quota).
    // Cast needed: SDK types may not include 'rate_limit_event' in the message type union.
    if ((message as any).type === 'rate_limit_event') {
      rateLimitHit = true;
      logger?.log('RATE LIMIT EVENT detected');
    }

    // --- Real-time progress: assistant messages (new turn + tool calls) ---
    if (message.type === 'assistant') {
      turnCounter++;
      process.stderr.write(`[${agentName}] Turn ${turnCounter}\n`);
      logger?.log(`Turn ${turnCounter}`);

      // Log assistant message content (text + tool calls)
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          // Log assistant text (reasoning between tool calls)
          if (block.type === 'text' && block.text) {
            lastAssistantText = block.text;
            logger?.logPrompt(`ASSISTANT TEXT (turn ${turnCounter})`, block.text);
          }
          if (block.type === 'tool_use') {
            const toolName = block.name ?? 'unknown';
            toolCalls[toolName] = (toolCalls[toolName] ?? 0) + 1;
            // Map a Task/Agent dispatch tool_use id → the sub-agent it spawns.
            if ((toolName === 'Task' || toolName === 'Agent') && block.input && block.id) {
              const sub = (block.input as any).subagent_type
                ?? (block.input as any).agent
                ?? (block.input as any).description
                ?? 'subagent';
              subAgentByToolUseId.set(block.id, String(sub));
            }
            // Attribute this tool call to its sub-agent (no-op if the logger has no setter).
            const parentToolUseId = (message as any).parent_tool_use_id ?? undefined;
            logger?.setAgentName(resolveActiveAgent(parentToolUseId, subAgentByToolUseId, agentName));
            process.stderr.write(`[${agentName}]   ↳ tool: ${toolName}\n`);
            logger?.log(`  tool: ${toolName}`);
            // Log tool input to file (not console — too verbose)
            if (block.input != null) {
              try {
                logger?.logJson(`TOOL INPUT: ${toolName}`, block.input);
              } catch {
                // Best-effort
              }
            }
          }
        }
      }
    }

    // --- Real-time progress: tool results (log to file only) ---
    // SDK streaming types don't expose user message content structure; use any for tool_result extraction
    if (message.type === 'user') {
      const userContent = (message as any).message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent as any[]) {
          if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            const truncated = resultText.length > TOOL_RESULT_LOG_LIMIT
              ? resultText.slice(0, TOOL_RESULT_LOG_LIMIT) + `\n... (truncated, ${resultText.length} chars total)`
              : resultText;
            logger?.logPrompt(`TOOL RESULT (${block.tool_use_id ?? 'unknown'})`, truncated);
          }
        }
      }
    }

    // --- Real-time progress: tool progress (log to file only, too noisy for console) ---
    if (message.type === 'tool_progress') {
      logger?.log(`  tool progress: ${(message as any).tool_name} (${(message as any).elapsed_time_seconds}s)`);
    }

    // Terminal message — capture telemetry and stop consuming. Every branch
    // that used to live here either returned from runAgent or threw; now the
    // interpretation of `resultMessage` (structured output, error subtypes,
    // API-error detection) happens in runAgent after this function returns.
    if (message.type === 'result') {
      costUsd = message.total_cost_usd;
      durationMs = message.duration_ms;
      turns = message.num_turns;
      const usage = message.usage;
      if (usage) {
        tokens.input = usage.input_tokens ?? 0;
        tokens.output = usage.output_tokens ?? 0;
        tokens.cacheRead = usage.cache_read_input_tokens ?? 0;
        tokens.cacheCreation = usage.cache_creation_input_tokens ?? 0;
      }

      // Print completion summary to console
      const summary = `[${agentName}] Complete — $${costUsd.toFixed(2)} | ${(durationMs / 1000).toFixed(0)}s | ${turns} turns`;
      process.stderr.write(`${summary}\n`);

      resultMessage = message;
      break;
    }
  }

  return { sessionId, costUsd, durationMs, turns, lastAssistantText, rateLimitHit, tokens, toolCalls, resultMessage };
}

// ---------------------------------------------------------------------------
// parseAgentOutput — the structured_output → result-JSON → regex ladder
// ---------------------------------------------------------------------------

/** The subset of an SDK `result` message that the output-extraction ladder reads. */
export interface AgentResultMessageLike {
  structured_output?: unknown;
  result?: unknown;
}

export type ParsedAgentOutput<T> =
  | { status: 'success'; data: T }
  | { status: 'invalid'; error: z.ZodError }
  | { status: 'none' };

/**
 * Extract and validate an agent's structured output from the SDK's result
 * handover, trying three tiers in order:
 *
 * 1. `resultMsg.structured_output` — already parsed by the SDK.
 * 2. `resultMsg.result` — a JSON string, parsed here.
 * 3. The last assistant text — a ```json fenced block or a trailing `{...}`
 *    blob, for when the SDK provides neither of the above (long responses,
 *    context limits).
 *
 * Whatever is found is validated against `schema`. Returns a discriminated
 * result rather than throwing — `runAgent` decides what each status means
 * (success → return; invalid → AgentValidationError; none → check
 * rate-limit / fall through to AgentExecutionError).
 */
export function parseAgentOutput<T extends z.ZodType>(
  resultMsg: AgentResultMessageLike,
  lastAssistantText: string,
  schema: T,
  logger?: PipelineLogger,
): ParsedAgentOutput<z.infer<T>> {
  // The SDK may return structured output in `structured_output` (object)
  // or `result` (JSON string). Try structured_output first since it's
  // already parsed; fall back to parsing result as JSON.
  let outputData: unknown = resultMsg.structured_output ?? null;
  if (!outputData && typeof resultMsg.result === 'string') {
    try {
      outputData = JSON.parse(resultMsg.result);
    } catch {
      logger?.log(`message.result is not valid JSON (${resultMsg.result.length} chars) — not structured output`);
    }
  }

  // Fallback: extract JSON from last assistant text when SDK doesn't
  // provide structured_output (happens with long responses or context limits)
  if (!outputData && lastAssistantText) {
    logger?.log('structured_output missing — attempting JSON extraction from last assistant text');
    logger?.log(`lastAssistantText length: ${lastAssistantText.length}, first 300 chars: ${lastAssistantText.slice(0, 300)}`);
    const jsonMatch = lastAssistantText.match(/```json\s*([\s\S]*?)```/)
      ?? lastAssistantText.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch?.[1]) {
      try {
        outputData = JSON.parse(jsonMatch[1]);
        logger?.log('JSON extracted from assistant text');
      } catch (parseErr) {
        logger?.log(`JSON extraction failed — could not parse: ${parseErr}`);
      }
    } else {
      logger?.log('No JSON block found in assistant text');
    }
  }

  if (!outputData) {
    return { status: 'none' };
  }

  logger?.log(`Attempting Zod parse on outputData (${JSON.stringify(outputData).length} chars)`);
  const parsed = schema.safeParse(outputData);
  if (parsed.success) {
    logger?.logJson('STRUCTURED OUTPUT', parsed.data);
    return { status: 'success', data: parsed.data };
  }
  logger?.log(`Zod parse FAILED: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
  return { status: 'invalid', error: parsed.error };
}
