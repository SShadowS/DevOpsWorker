import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { AgentConfig, AgentResult, McpServerConfig } from '../types/agent.types.ts';
import type { PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import { buildSystemPrompt, buildSharedFragmentContent } from './prompt-loader.ts';
import { stageAgentWorkspace, type StagedWorkspace } from './agent-workspace.ts';
import { consumeAgentStream, parseAgentOutput } from './agent-stream.ts';
import { resolveAgentOverlayDir, loadManifest, resolveAgentKnobs } from '../overlay/index.ts';
import type { OverlayManifest } from '../overlay/index.ts';
import { AgentExecutionError, AgentValidationError, BudgetExceededError, RateLimitError, TransientAgentError } from './errors.ts';

// ---------------------------------------------------------------------------
// runAgent — generic wrapper around the Claude Agent SDK query()
// ---------------------------------------------------------------------------

/**
 * Disable Claude Code CLI v2 (SDK 0.3+) auto-backgrounding of long-running bash.
 * The spawned CLI inherits this process's env. When unset, the CLI auto-backgrounds
 * blocking commands past 120s and exposes `run_in_background` (which the model uses on
 * await-pipeline, abandoning the CI wait → ciResult=not-run / error_max_turns). Setting
 * this strips `run_in_background` from the tool schema and skips the 120s speculation.
 * (Belt-and-suspenders with the Dockerfile ENV; covers local non-container runs too.)
 *
 * Called explicitly from CLI entrypoints (not as an import-time side effect) so that
 * merely importing this module — e.g. from tests that exercise the pure helpers below —
 * doesn't silently mutate process-global env.
 */
export function initAgentRuntime(): void {
  if (process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS == null) {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }
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
 * The `runAgent` call-site composition for MCP servers: resolve the agent's own
 * (possibly state-dependent) server map, then fold in the overlay manifest's
 * `mcpServers`. Extracted so the wiring itself — not just `mergeMcpServers` in
 * isolation — is directly testable (see `tests/overlay/manifest-contract.test.ts`,
 * which fails if this stops reading `manifest.mcpServers`).
 */
export function resolveAgentMcpServers(
  config: AgentConfig<z.ZodType>,
  state: PipelineState,
  manifest: OverlayManifest,
): Record<string, McpServerConfig> {
  return mergeMcpServers(resolveMcpServers(config.mcpServers, state), manifest.mcpServers);
}

// Re-exported for backward compatibility — moved to agent-stream.ts alongside
// consumeAgentStream, which is its only other caller (avoids a circular
// import between run-agent.ts and agent-stream.ts).
export { resolveActiveAgent } from './agent-stream.ts';

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
  const resolvedMcpServers = resolveAgentMcpServers(config, state, manifest);

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
        const stream = query({
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
        });

        const {
          resultMessage, sessionId, costUsd, durationMs, turns,
          lastAssistantText, rateLimitHit, tokens, toolCalls,
        } = await consumeAgentStream(stream, { agentName, logger });

        if (!resultMessage) {
          const err = new AgentExecutionError(config.name, 'No result message received from agent');
          logger?.stageError(err);
          throw err;
        }

        // --- Debug: log everything about the result handover ---
        const resultMsg = resultMessage as any;
        logger?.log(`RESULT subtype=${resultMessage.subtype} structured_output=${resultMsg.structured_output != null ? typeof resultMsg.structured_output : 'NULL'} result_keys=${Object.keys(resultMessage).join(',')}`);
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

        if (resultMessage.subtype === 'success') {
          const parseResult = parseAgentOutput(resultMsg, lastAssistantText, config.outputSchema, logger);

          if (parseResult.status === 'success') {
            logger?.stageComplete({ costUsd, durationMs, turns, sessionId });

            return {
              output: parseResult.data,
              costUsd,
              durationMs,
              turns,
              sessionId,
              toolCalls,
              tokens,
              subtype: resultMessage.subtype,
              model,
            };
          }

          if (parseResult.status === 'invalid') {
            const err = new AgentValidationError(config.name, parseResult.error);
            logger?.stageError(err);
            throw err;
          }

          // status === 'none' — success but no structured output. Check if
          // rate limited (only the SDK's rate_limit_event flag, not text
          // heuristics which could false-positive).
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
        const errors = 'errors' in resultMessage ? resultMessage.errors : [];
        const err = new AgentExecutionError(config.name, {
          subtype: resultMessage.subtype,
          errors,
          costUsd,
          durationMs,
          turns,
          model,
        });
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
