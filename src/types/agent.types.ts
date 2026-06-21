import type { z } from 'zod';
import type { SdkPluginConfig, AgentDefinition as SdkAgentDefinition, HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { PipelineState, PipelineContext, StageTokenUsage } from './pipeline.types.ts';

// ---------------------------------------------------------------------------
// MCP server config types (matching the Claude Agent SDK)
// ---------------------------------------------------------------------------

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig;

// ---------------------------------------------------------------------------
// AgentConfig — defines a pipeline agent
// ---------------------------------------------------------------------------

export interface AgentConfig<TOutput extends z.ZodType> {
  /** Agent name — matches folder name (e.g. 'analyzer', 'coder') */
  name: string;

  /** Which shared prompt fragments to include (e.g. ['project-context.md', 'repo-structure.md']) */
  sharedPromptFragments: string[];

  /** Build the per-run user prompt from pipeline state */
  buildPrompt: (state: PipelineState, ctx: PipelineContext) => string;

  /** Zod schema for structured output validation */
  outputSchema: TOutput;

  /** Allowed tools (principle of least privilege) */
  allowedTools: string[];

  /** Tools to explicitly block (overrides defaults from claude_code preset) */
  disallowedTools?: string[];

  /** MCP servers this agent needs (static or function-of-state) */
  mcpServers?: Record<string, McpServerConfig> | ((state: PipelineState) => Record<string, McpServerConfig>);

  /** Max agentic turns before stopping (default: 50) */
  maxTurns?: number;

  /** Cost ceiling per agent run */
  maxBudgetUsd?: number;

  /** Model override (default: from PipelineConfig.models.default) */
  model?: string;

  /** Working directory (default: process.cwd()) */
  cwd?: string;

  /** Use the Claude Code system prompt preset + settingSources.
   *  When true, CLAUDE.md is loaded from cwd and prompt.md/rules.md are ignored. */
  useClaudeCodePreset?: boolean;

  /** Absolute path to agent source dir (src/agents/<name>/).
   *  Used to locate CLAUDE.md and .claude/ for staging into cwd. */
  agentSourceDir?: string;

  /** Override settingSources for this agent. Defaults to ['project'] when useClaudeCodePreset is true.
   *  WARNING: including 'user' loads ALL user plugins (Serena, etc.) whose tools bypass allowedTools. */
  settingSources?: ('user' | 'project' | 'local')[];

  /** Plugins to load (e.g. LSP servers). Passed directly to SDK query(). */
  plugins?: SdkPluginConfig[];

  /** Subagent definitions registered for the Task tool. Each entry can pin its
   *  own model (e.g. a cheap Haiku poller) and tool set. Passed directly to SDK
   *  query() as `agents`. Keyed by subagent_type. */
  agents?: Record<string, SdkAgentDefinition>;

  /** Programmatic hooks (e.g. a PreToolUse guard that forces CI waits through the
   *  ci-waiter subagent). Passed directly to SDK query() as `hooks`. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  /** Max retry attempts for transient failures (default: 2) */
  maxRetries?: number;

  /** Base delay between retries in ms, scales linearly (default: 5000) */
  retryBaseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// AgentResult — returned by runAgent(), includes output + telemetry
// ---------------------------------------------------------------------------

export interface AgentResult<T> {
  output: T;
  costUsd: number;
  durationMs: number;
  turns: number;
  sessionId: string;
  toolCalls: Record<string, number>;
  /** Token usage from the SDK result message. */
  tokens: StageTokenUsage;
  /** SDK result subtype (e.g. 'success', 'error_max_turns'). */
  subtype: string;
}
