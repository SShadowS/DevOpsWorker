import type { RepoRegistry, RepoConfig } from '../config/repo-config.ts';
import type { CompanionDef } from '../config/companions.ts';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import type { EnvProviderFactory } from '../sdk/env-provider.ts';
import type { PipelineEdit } from './stage-edit.ts';

/**
 * Context handed to an overlay's `pipeline` builder. Proprietary stages are
 * config-dependent (e.g. `envProvision(config)`), so the overlay constructs them
 * from the live config/repo and returns name-anchored edits.
 */
export interface PipelineBuildContext {
  config: PipelineConfig;
  /** The target repo when building a repo-specific pipeline; absent for the default pipeline. */
  repo?: RepoConfig;
}

/**
 * Defaults for the Azure DevOps organisation/project a consumer targets.
 * The public core ships generic, env-driven defaults; an overlay overrides them.
 */
export interface AdoDefaults {
  organization?: string;
  orgUrl?: string;
  project?: string;
  areaPath?: string;
  iterationPath?: string;
}

/**
 * Bounded, typed per-agent knobs an overlay may override. Prompt ASSETS
 * (CLAUDE.md / .claude/) come from private/agents/<name>/, NOT this map.
 * REPLACE semantics for arrays (allowedTools, sharedPromptFragments) — never
 * merged, so the effective set is explicit and auditable.
 */
export interface AgentConfigOverride {
  /** Model id (e.g. 'claude-sonnet-5'). Wins over the perAgent/default chain. */
  model?: string;
  /** REPLACE allowedTools wholesale. Omit to keep the public set. */
  allowedTools?: string[];
  /** Override max agent turns. Omit to keep the public value. */
  maxTurns?: number;
  /** REPLACE shared prompt fragments (filenames resolved from src/prompts/). */
  sharedPromptFragments?: string[];
}

/**
 * A periodic background task the watcher runs on an interval.
 *
 * The split is the same one the core uses for agents and pipeline edits: the
 * core owns the *scheduler* (registration, re-entrancy, error containment,
 * shutdown), the overlay owns the *work*. Nothing about what a task does — its
 * subject, its data, its cost — belongs in the core.
 */
export interface ScheduledTask {
  /** Stable identifier. Appears in the watcher log and keys the re-entrancy
   *  guard, so it should be unique within `scheduled`. */
  name: string;
  /** Minutes between ticks. Fractions are allowed (`0.5` = every 30s). Must be
   *  a positive finite number — anything else is refused at registration rather
   *  than turned into a hot loop by `setInterval(fn, NaN)`. */
  everyMinutes: number;
  /**
   * Also run once immediately at watcher startup.
   *
   * Set this when `everyMinutes` is longer than the watcher reliably stays up:
   * an interval-only timer whose period exceeds the process lifetime never
   * fires at all, and a job that never runs looks exactly like a job that runs
   * and does nothing. The task must therefore tolerate being invoked more often
   * than its cadence implies — a restart loop calls it on every boot.
   */
  runAtStart?: boolean;
  /** The work. A rejection is logged against the task name and swallowed: a
   *  failing task must never take the watcher down, and must never be silent. */
  run: () => Promise<void>;
}

/**
 * The contract a private overlay implements. A consumer's `private/manifest.ts`
 * default-exports an object of this shape. The public core loads it when present
 * and falls back to `{}` (an empty overlay) otherwise — so the public pipeline
 * runs unchanged with no overlay installed.
 *
 * Merge semantics per field are fixed (see the design doc):
 *   - `repos`, `companions`, `mcpServers` → ADD (merged into the core map)
 *   - `agents`, `ado`                     → OVERRIDE (named per-agent knobs)
 *   - `pipeline`                          → declarative stage edits
 */
export interface OverlayManifest {
  /** Repo registrations merged into the core registry (which ships empty/example). */
  repos?: RepoRegistry;
  /** Companion repo definitions merged into the core companion registry. */
  companions?: Record<string, CompanionDef>;
  /** Extra MCP servers merged into the core server map. Typed loosely to avoid
   *  coupling the contract to the SDK's config shape. */
  mcpServers?: Record<string, unknown>;
  /** Per-agent typed knobs, keyed by AgentConfig.name. Prompt assets come from
   *  private/agents/<name>/, NOT this map. */
  agents?: Record<string, AgentConfigOverride>;
  /** Azure DevOps org/project/area defaults. */
  ado?: AdoDefaults;
  /** Declarative pipeline topology edits, built from the live config/repo.
   *  Returns name-anchored edits (insert/replace/remove) — never raw array surgery. */
  pipeline?: (ctx: PipelineBuildContext) => PipelineEdit[];
  /** Factory for the BC test-environment backend (env lifecycle + reprovision).
   *  Absent → the core skips all env operations (public AL pipeline, no BC envs). */
  envProvider?: EnvProviderFactory;
  /** Periodic background tasks the watcher runs on an interval. The core supplies the
   *  scheduler; the overlay supplies the work. Absent/empty → the watcher schedules
   *  nothing and behaves exactly as it does with no overlay at all. */
  scheduled?: ScheduledTask[];
}
