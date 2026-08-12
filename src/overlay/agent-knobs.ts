import type { AgentConfig } from '../types/agent.types.ts';
import type { OverlayManifest } from './types.ts';
import { readPromptFile } from '../sdk/prompt-loader.ts';

export interface ResolvedAgentKnobs {
  model: string;
  allowedTools: string[];
  maxTurns: number;
  sharedPromptFragments: string[];
}

/** Core (non-MCP) tool names known to the SDK. Used only to WARN on an
 *  overridden allowedTools list that names something unexpected — MCP tools
 *  (mcp__*) are dynamic and intentionally not validated. */
// Last audited against the Claude Agent SDK tool set, 2026-06-22.
const CORE_TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Grep',
  'Glob', 'Skill', 'LSP', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
]);

/** Database-sourced knobs for ONE named agent — a plain, already-resolved
 *  object, never a store. Both fields are `undefined` when no operator has
 *  set a value for this agent; `resolveAgentKnobs` falls through past an
 *  `undefined` field exactly like every other tier in its precedence chain.
 *  See `resolveDbAgentKnobs` (`src/cli/config.ts`) for how this is built from
 *  the raw `settings` table — deliberately NOT from `pipelineModels.perAgent`,
 *  which already carries a code-level fallback that must not be mistaken for
 *  a database override. */
export interface DbAgentKnobs {
  model?: string;
  maxTurns?: number;
}

/**
 * Fold an overlay's per-agent knobs, and now a database's, onto a base
 * AgentConfig. Pure: with an empty manifest (or no entry for this agent) and
 * no database knobs, it returns the base values unchanged. Validates
 * overridden knobs and throws a clear error rather than letting a typo
 * surface as a cryptic mid-run SDK failure.
 *
 * `model`/`maxTurns` precedence, deliberately: **database (`dbKnobs`) >
 * overlay manifest (`manifest.agents[name]`) > the agent's own declared config
 * (`base.model`/`base.maxTurns`) > the pipeline default** (`pipelineModels.default`,
 * with `pipelineModels.perAgent[name]` as model's one extra fallback rung below
 * the agent's own config). The database wins over the manifest because an
 * operator's deliberate, live change should beat a checked-in default.
 * `allowedTools` stays file-and-manifest-only — not exposed as a database
 * knob, since it is an auto-approve list rather than a restriction (see
 * `disallowedTools`), and editing it from a web form would suggest a control
 * that isn't there.
 */
export function resolveAgentKnobs(
  base: AgentConfig<any>,
  manifest: OverlayManifest,
  pipelineModels: { default: string; perAgent?: Record<string, string> },
  dbKnobs?: DbAgentKnobs,
): ResolvedAgentKnobs {
  const ov = manifest.agents?.[base.name];

  const allowedTools = ov?.allowedTools ?? base.allowedTools;
  if (ov?.allowedTools) {
    if (allowedTools.length === 0) {
      throw new Error(
        `Overlay agent override "${base.name}": allowedTools is empty — an agent with no tools cannot act.`,
      );
    }
    for (const t of allowedTools) {
      if (!t.startsWith('mcp__') && !CORE_TOOLS.has(t)) {
        console.warn(`[overlay] agent "${base.name}": allowedTools includes unknown core tool "${t}"`);
      }
    }
  }

  const sharedPromptFragments = ov?.sharedPromptFragments ?? base.sharedPromptFragments;
  if (ov?.sharedPromptFragments) {
    const missing = sharedPromptFragments.filter((name) => {
      // probe-only: readPromptFile throws if the fragment file is absent
      try { readPromptFile(`prompts/${name}`); return false; } catch { return true; }
    });
    if (missing.length > 0) {
      throw new Error(
        `Overlay agent override "${base.name}": sharedPromptFragments not found under src/prompts/: ${missing.join(', ')}`,
      );
    }
  }

  return {
    model: dbKnobs?.model ?? ov?.model ?? base.model ?? pipelineModels.perAgent?.[base.name] ?? pipelineModels.default,
    allowedTools,
    maxTurns: dbKnobs?.maxTurns ?? ov?.maxTurns ?? base.maxTurns ?? 50,
    sharedPromptFragments,
  };
}
