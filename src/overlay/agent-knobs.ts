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
const CORE_TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Grep',
  'Glob', 'Skill', 'LSP', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
]);

/**
 * Fold an overlay's per-agent knobs onto a base AgentConfig. Pure: with an empty
 * manifest (or no entry for this agent) it returns the base values unchanged.
 * Validates overridden knobs and throws a clear error rather than letting a typo
 * surface as a cryptic mid-run SDK failure.
 *
 * `model` precedence: override → base.model → perAgent[name] → default.
 * (The deprecated OverlayManifest.models map is deliberately NOT consulted.)
 */
export function resolveAgentKnobs(
  base: AgentConfig<any>,
  manifest: OverlayManifest,
  pipelineModels: { default: string; perAgent?: Record<string, string> },
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
    const missing = ov.sharedPromptFragments.filter((name) => {
      try { readPromptFile(`prompts/${name}`); return false; } catch { return true; }
    });
    if (missing.length > 0) {
      throw new Error(
        `Overlay agent override "${base.name}": sharedPromptFragments not found under src/prompts/: ${missing.join(', ')}`,
      );
    }
  }

  return {
    model: ov?.model ?? base.model ?? pipelineModels.perAgent?.[base.name] ?? pipelineModels.default,
    allowedTools,
    maxTurns: ov?.maxTurns ?? base.maxTurns ?? 50,
    sharedPromptFragments,
  };
}
