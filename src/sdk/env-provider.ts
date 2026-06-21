import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';

/**
 * Abstraction over a BC test-environment backend (env lifecycle + reprovision).
 *
 * The public core never talks to a concrete environment tool. A private overlay
 * supplies an implementation via `OverlayManifest.envProvider`; when no overlay
 * is installed the core simply has no provider and env operations are skipped
 * (a public AL pipeline runs without ephemeral BC environments).
 *
 * The provider encapsulates CLI-path resolution and the proprietary tool calls —
 * callers pass only the environment id (and the live config for reprovision).
 */
export interface EnvProvider {
  /** Start a (provisioned) environment. Fire-and-forget; env boots async. */
  startEnv(envId: string, stage?: string): Promise<void>;
  /** Stop an environment. `strict` throws on failure; otherwise best-effort. */
  stopEnv(envId: string, opts?: { strict?: boolean }, stage?: string): Promise<void>;
  /** Delete an environment. `strict` throws on failure; otherwise best-effort. */
  deleteEnv(envId: string, opts?: { strict?: boolean }, stage?: string): Promise<void>;
  /** Share an environment with a user by email. */
  shareEnv(envId: string, email: string, stage?: string): Promise<void>;
  /** Re-run provisioning for a work item's environment, returning updated state. */
  reprovision(
    workItemId: number,
    state: PipelineState,
    config: PipelineConfig,
    stateStore: IStateStore,
  ): Promise<PipelineState>;
}

/**
 * Factory the overlay exposes. Receives the live (per-work-item) config so the
 * implementation can resolve its CLI path from `config.paths` / `config.environment`.
 */
export type EnvProviderFactory = (ctx: { config: PipelineConfig }) => EnvProvider;
