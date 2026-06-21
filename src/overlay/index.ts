import type { RepoRegistry } from '../config/repo-config.ts';
import type { CompanionDef } from '../config/companions.ts';
import type { PipelineDefinition } from '../types/pipeline.types.ts';
import { registerRepos } from '../config/repos.ts';
import { registerCompanions } from '../config/companions.ts';
import { applyPipelineEdits } from './stage-edit.ts';
import type { OverlayManifest, PipelineBuildContext } from './types.ts';

export type { OverlayManifest, AdoDefaults, PipelineBuildContext } from './types.ts';
export type { PipelineEdit } from './stage-edit.ts';
export { applyPipelineEdits } from './stage-edit.ts';
export { loadManifest, resolvePrivateDir, resetManifestCache, resolveAgentOverlayDir } from './loader.ts';

/**
 * Resolvers fold an OverlayManifest onto a core base value. Each implements the
 * fixed merge semantics from the design doc. Call sites pass the loaded manifest;
 * with an empty manifest every resolver is the identity on its base.
 */

/**
 * Populate the core repo + companion registries from an overlay manifest.
 *
 * This is the startup chokepoint: `src/cli/index.ts` calls it once, after loading
 * the manifest, before dispatching any command — so every process (watcher,
 * webhook-server, dashboard, spawned containers) has the registries populated
 * before any consumer reads them. Idempotent; an empty manifest is a no-op.
 */
export function applyOverlayRegistries(manifest: OverlayManifest): void {
  registerRepos(manifest.repos ?? {});
  registerCompanions(manifest.companions ?? {});
}

/** ADD: overlay repos merged into the core registry (overlay wins on key clash). */
export function resolveRepos(base: RepoRegistry, manifest: OverlayManifest): RepoRegistry {
  return { ...base, ...(manifest.repos ?? {}) };
}

/** ADD: overlay companions merged into the core companion registry. */
export function resolveCompanions(
  base: Record<string, CompanionDef>,
  manifest: OverlayManifest,
): Record<string, CompanionDef> {
  return { ...base, ...(manifest.companions ?? {}) };
}

/** Declarative stage edits applied to the core pipeline, built from config/repo.
 *  With no overlay (or no `pipeline` builder) this is the identity on `base`. */
export function resolvePipeline(
  base: PipelineDefinition,
  manifest: OverlayManifest,
  ctx: PipelineBuildContext,
): PipelineDefinition {
  return applyPipelineEdits(base, manifest.pipeline?.(ctx) ?? []);
}
