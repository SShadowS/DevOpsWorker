import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { AgentConfig, AgentResult, McpServerConfig } from '../types/agent.types.ts';
import type { PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import { buildSystemPrompt, buildSharedFragmentContent } from './prompt-loader.ts';
import { stageAgentWorkspace, type StagedWorkspace } from './agent-workspace.ts';
import { resolveAgentOverlayDir, loadManifest, resolveAgentKnobs } from '../overlay/index.ts';
import { AgentExecutionError, AgentValidationError, BudgetExceededError, RateLimitError, TransientAgentError } from './errors.ts';

// ---------------------------------------------------------------------------
// runAgent — generic wrapper around the Claude Agent SDK query()
// ---------------------------------------------------------------------------

// Disable Claude Code CLI v2 (SDK 0.3+) auto-backgrounding of long-running bash.
// The spawned CLI inherits this process's env. When unset, the CLI auto-backgrounds
// blocking commands past 120s and exposes `run_in_background` (which the model uses on
// await-pipeline, abandoning the CI wait → ciResult=not-run / error_max_turns). Setting
// this strips `run_in_background` from the tool schema and skips the 120s speculation.
// (Belt-and-suspenders with the Dockerfile ENV; covers local non-container runs too.)
if (process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS == null) {
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
}

/**
 * Execute a pipeline agent via the Claude Agent SDK.
 *
 * Two code paths:
 * - **Legacy**: assembles system prompt from prompt.md + rules.md + shared fragments
 * - **Claude Code preset**: stages CLAUDE.md/.claude/ into cwd, uses the `claude_code`
 *   system prompt preset with shared fragments as `append`, enables settingSources
 */
// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

const NON_RETRYABLE_SUBTYPES = new Set([
  'error_max_turns',
  'error_max_budget',
]);

/** Max chars to log for tool results (prevents huge log files from file reads). */
const TOOL_RESULT_LOG_LIMIT = 2000;

/** Determine if an error is transient and worth retrying. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AgentValidationError) return false;
  if (err instanceof BudgetExceededError) return false;
  if (err instanceof RateLimitError) return false;
  if (err instanceof AgentExecutionError) {
    // SDK result subtypes like max_turns/max_budget are permanent
    if (typeof err.details === 'object' && err.details !== null && 'subtype' in err.details) {
      return !NON_RETRYABLE_SUBTYPES.has((err.details as { subtype: string }).subtype);
    }
    // String details like "No result message" are transient (process crash)
    return typeof err.details === 'string';
  }
  // Plain Error (process crash) → retryable
  return err instanceof Error;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A Claude API error the SDK surfaced as assistant text rather than throwing. */
export interface DetectedApiError {
  status?: number;
  errorType?: string;
  message: string;
  isUsageLimit: boolean;
  isOverloaded: boolean;
}

/**
 * Detect a Claude API error that the SDK surfaced as the assistant's final text
 * instead of throwing. Observed format: `API Error: 400 {"type":"error","error":{...}}`.
 *
 * Without this, the embedded error JSON gets extracted as "output", fails Zod
 * validation, and the true cause (e.g. usage limit reached) is masked as an
 * AgentValidationError. Detection is deliberately narrow — it requires the SDK's
 * `API Error: <status>` prefix or a parseable `{"type":"error",...}` envelope —
 * so agents that merely discuss errors in prose don't trigger a false positive.
 *
 * Returns null when the text is not an API error.
 */
export function detectApiError(text: string | undefined | null): DetectedApiError | null {
  if (!text) return null;

  const statusMatch = text.match(/API Error:\s*(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  let errorType: string | undefined;
  let message = '';
  const envelopeMatch = text.match(/\{[\s\S]*"type"\s*:\s*"error"[\s\S]*\}/);
  if (envelopeMatch) {
    try {
      const parsed = JSON.parse(envelopeMatch[0]) as { error?: { type?: string; message?: string } };
      errorType = parsed.error?.type;
      message = parsed.error?.message ?? '';
    } catch {
      // Not valid JSON — fall back to the prefix signal below.
    }
  }

  // Require a strong signal to avoid false positives on prose about errors.
  if (status === undefined && errorType === undefined) return null;

  if (!message) message = text.slice(0, 300).trim();
  const lower = message.toLowerCase();

  const isUsageLimit = /usage limit|credit balance|exceeded your.*quota|reached your.*limit/.test(lower);
  const isOverloaded = status === 529 || errorType === 'overloaded_error' || lower.includes('overloaded');

  return { status, errorType, message, isUsageLimit, isOverloaded };
}

/**
 * Resolve a function-typed `mcpServers` field on an `AgentConfig` to a static record.
 * If `servers` is a function, invoke it with `state`. If undefined, return `{}`.
 */
export function resolveMcpServers(
  servers: AgentConfig<z.ZodType>['mcpServers'],
  state: PipelineState,
): Record<string, McpServerConfig> {
  return typeof servers === 'function' ? servers(state) : (servers ?? {});
}

/**
 * Validate that a manifest-declared MCP server entry has the shape of an
 * `McpServerConfig` (a stdio server config: a string `command`, optional
 * `args`/`env`/`type`). `OverlayManifest.mcpServers` is typed `Record<string,
 * unknown>` at the contract boundary (kept loose so the overlay contract isn't
 * coupled to the SDK's config shape) — this is where that `unknown` gets
 * checked and narrowed, so it never leaks unvalidated into the resolved map.
 * Throws a clear error naming the offending key rather than letting a
 * malformed overlay entry surface as a cryptic mid-run SDK failure.
 */
function assertMcpServerConfig(name: string, value: unknown): McpServerConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { command?: unknown }).command !== 'string'
  ) {
    throw new Error(
      `Overlay manifest.mcpServers["${name}"] is not a valid McpServerConfig — ` +
        `expected an object with a string "command" field, got ${JSON.stringify(value)}.`,
    );
  }
  return value as McpServerConfig;
}

/**
 * Merge an overlay's `manifest.mcpServers` into an agent's own resolved MCP
 * server map. ADD semantics per the `OverlayManifest` contract (see
 * `src/overlay/types.ts`): overlay entries fill in servers the agent didn't
 * already declare. **Agent-specific entries win on key collision** — an
 * agent's own, carefully scoped server config must never be silently
 * clobbered by an overlay entry that happens to share its name.
 *
 * Pure and independently testable from `runAgent` (see
 * `tests/sdk/run-agent-mcpservers.test.ts`).
 */
export function mergeMcpServers(
  agentServers: Record<string, McpServerConfig>,
  manifestServers: Record<string, unknown> | undefined,
): Record<string, McpServerConfig> {
  const validatedManifestServers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(manifestServers ?? {})) {
    validatedManifestServers[name] = assertMcpServerConfig(name, value);
  }
  return { ...validatedManifestServers, ...agentServers };
}

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

export async function runAgent<T extends z.ZodType>(
  config: AgentConfig<T>,
  state: PipelineState,
  context: PipelineContext,
): Promise<AgentResult<z.infer<T>>> {
  const prompt = config.buildPrompt(state, context);
  const manifest = await loadManifest();
  const knobs = resolveAgentKnobs(config, manifest, context.config.models);
  const model = knobs.model;
  const cwd = config.cwd ?? process.cwd();
  const logger = context.logger;
  const agentName = config.name;

  // --- Determine system prompt strategy ---
  let staged: StagedWorkspace | undefined;
  let systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  let settingSources: SettingSource[] | undefined;
  let effectiveTools = [...knobs.allowedTools];

  if (config.useClaudeCodePreset && config.agentSourceDir) {
    // NEW PATH: native Claude Code features. Merge any private overlay assets
    // (private/agents/<name>/) on top of the public agent.
    const overlayDir = resolveAgentOverlayDir(config.name) ?? undefined;
    staged = await stageAgentWorkspace(config.agentSourceDir, cwd, overlayDir);
    settingSources = config.settingSources ?? ['project'];

    // Shared fragments go into append
    const sharedContent = buildSharedFragmentContent(knobs.sharedPromptFragments);
    systemPrompt = {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      ...(sharedContent ? { append: sharedContent } : {}),
    };

    // Enable Skill tool if agent has skills
    if (existsSync(join(config.agentSourceDir, '.claude', 'skills'))) {
      if (!effectiveTools.includes('Skill')) {
        effectiveTools.push('Skill');
      }
    }
  } else {
    // LEGACY PATH: unchanged behavior
    systemPrompt = buildSystemPrompt(config.name, knobs.sharedPromptFragments);
  }

  // Resolve mcpServers (can be static or function-of-state), then merge in any
  // overlay-declared servers (manifest.mcpServers) — agent-specific entries win.
  const resolvedMcpServers = mergeMcpServers(resolveMcpServers(config.mcpServers, state), manifest.mcpServers);

  // Log agent config and prompts
  logger?.logJson('AGENT CONFIG', {
    name: agentName,
    model,
    maxTurns: knobs.maxTurns,
    allowedTools: effectiveTools,
    mcpServers: Object.keys(resolvedMcpServers),
    cwd,
    useClaudeCodePreset: config.useClaudeCodePreset ?? false,
  });
  logger?.logPrompt('SYSTEM PROMPT', typeof systemPrompt === 'string' ? systemPrompt : JSON.stringify(systemPrompt, null, 2));
  logger?.logPrompt('USER PROMPT', prompt);

  try {
    const maxRetries = config.maxRetries ?? 3;
    const retryBaseDelayMs = config.retryBaseDelayMs ?? 10_000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let sessionId = '';
        let costUsd = 0;
        let durationMs = 0;
        let turns = 0;
        let turnCounter = 0;
        let lastAssistantText = '';
        let rateLimitHit = false;
        let resultSubtype = 'success';
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        const toolCalls: Record<string, number> = {};
        const subAgentByToolUseId = new Map<string, string>();

        for await (const message of query({
          prompt,
          options: {
            systemPrompt,
            settingSources,
            outputFormat: {
              type: 'json_schema',
              schema: (() => {
                const { $schema: _, ...schema } = z.toJSONSchema(config.outputSchema) as Record<string, unknown>;
                return schema;
              })(),
            },
            allowedTools: effectiveTools,
            disallowedTools: config.disallowedTools,
            mcpServers: resolvedMcpServers,
            model,
            cwd,
            maxTurns: knobs.maxTurns,
            maxBudgetUsd: config.maxBudgetUsd,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            plugins: config.plugins,
            agents: config.agents,
            hooks: config.hooks,
          },
        })) {
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
            const content = message.message?.content;
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
                  const parentToolUseId = message.parent_tool_use_id ?? undefined;
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
            logger?.log(`  tool progress: ${message.tool_name} (${message.elapsed_time_seconds}s)`);
          }

          // Process result message
          if (message.type === 'result') {
            costUsd = message.total_cost_usd;
            durationMs = message.duration_ms;
            turns = message.num_turns;
            resultSubtype = message.subtype;
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

            // --- Debug: log everything about the result handover ---
            const resultMsg = message as any;
            logger?.log(`RESULT subtype=${message.subtype} structured_output=${resultMsg.structured_output != null ? typeof resultMsg.structured_output : 'NULL'} result_keys=${Object.keys(message).join(',')}`);
            if (resultMsg.structured_output != null) {
              const soStr = JSON.stringify(resultMsg.structured_output);
              logger?.log(`RESULT structured_output (${soStr.length} chars): ${soStr.slice(0, 500)}${soStr.length > 500 ? '...' : ''}`);
            }
            // Log the JSON schema we sent to the SDK for outputFormat
            try {
              const jsonSchema = z.toJSONSchema(config.outputSchema);
              logger?.log(`OUTPUT_FORMAT schema keys: ${Object.keys(jsonSchema).join(',')}`);
              logger?.log(`OUTPUT_FORMAT schema.type=${(jsonSchema as any).type} required=${JSON.stringify((jsonSchema as any).required?.slice(0, 5))}`);
            } catch (schemaErr) {
              logger?.log(`OUTPUT_FORMAT z.toJSONSchema FAILED: ${schemaErr}`);
            }

            // The SDK sometimes surfaces an API error (e.g. usage limit reached)
            // as the assistant's final text rather than throwing. Catch it before
            // the JSON-extraction fallback below would mis-parse it as output and
            // fail schema validation — masking the real cause. Only check when
            // there is no real structured output, so genuine results are untouched.
            if (resultMsg.structured_output == null) {
              const apiError = detectApiError(lastAssistantText);
              if (apiError) {
                logger?.log(`API error surfaced in agent output: status=${apiError.status ?? '?'} type=${apiError.errorType ?? '?'} — ${apiError.message}`);
                if (apiError.isUsageLimit) {
                  // Non-retryable: waiting won't help until the limit resets.
                  const err = new RateLimitError(agentName, apiError.message);
                  logger?.stageError(err);
                  throw err;
                }
                // Overloaded / transient API errors — retryable execution error.
                const err = new AgentExecutionError(agentName, {
                  subtype: 'api_error',
                  status: apiError.status,
                  errorType: apiError.errorType,
                  message: apiError.message,
                  model,
                });
                logger?.stageError(err);
                throw err;
              }
            }

            if (message.subtype === 'success') {
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

              if (outputData) {
                logger?.log(`Attempting Zod parse on outputData (${JSON.stringify(outputData).length} chars)`);
                const parsed = config.outputSchema.safeParse(outputData);
                if (parsed.success) {
                  logger?.logJson('STRUCTURED OUTPUT', parsed.data);
                  logger?.stageComplete({ costUsd, durationMs, turns, sessionId });

                  return {
                    output: parsed.data,
                    costUsd,
                    durationMs,
                    turns,
                    sessionId,
                    toolCalls,
                    tokens,
                    subtype: resultSubtype,
                    model,
                  };
                }
                logger?.log(`Zod parse FAILED: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
                const err = new AgentValidationError(config.name, parsed.error);
                logger?.stageError(err);
                throw err;
              }

              // Success but no structured output — check if rate limited.
              // Only use the SDK's rate_limit_event flag (not text heuristics which could false-positive).
              if (rateLimitHit) {
                const resetMatch = lastAssistantText.match(/resets?\s+(.+)/i);
                const resetInfo = resetMatch?.[1]?.replace(/[·\-–—].*/, '').trim() ?? 'unknown reset time';
                const err = new RateLimitError(agentName, resetInfo);
                logger?.stageError(err);
                throw err;
              }

              logger?.log(`Agent succeeded but produced no structured output (turns: ${turns}, cost: $${costUsd.toFixed(2)})`);
            }

            // Agent failed or missing structured output
            const errors = 'errors' in message ? message.errors : [];
            const err = new AgentExecutionError(config.name, {
              subtype: message.subtype,
              errors,
              costUsd,
              durationMs,
              turns,
              model,
            });
            logger?.stageError(err);
            throw err;
          }
        }

        const err = new AgentExecutionError(config.name, 'No result message received from agent');
        logger?.stageError(err);
        throw err;
      } catch (innerErr: unknown) {
        const isLast = attempt >= maxRetries;
        if (!isRetryableError(innerErr) || isLast) {
          if (isRetryableError(innerErr)) {
            const wrapped = new TransientAgentError(config.name, attempt, innerErr as Error);
            logger?.stageError(wrapped);
            throw wrapped;
          }
          throw innerErr;
        }
        // Transient error — retry after backoff
        const delayMs = retryBaseDelayMs * attempt;
        const errDetail = innerErr instanceof Error
          ? `${innerErr.message}${(innerErr as any).stderr ? ` | stderr: ${(innerErr as any).stderr}` : ''}`
          : String(innerErr);
        logger?.log(`Transient error on attempt ${attempt}/${maxRetries}, retrying in ${delayMs}ms: ${errDetail}`);
        process.stderr.write(`[${agentName}] Attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...\n`);
        await sleep(delayMs);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error(`Unexpected: retry loop exited without returning or throwing`);
  } finally {
    await staged?.cleanup();
  }
}
