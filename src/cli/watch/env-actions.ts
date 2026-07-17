import type { IStateStore } from '../../pipeline/state-store.interface.ts';
import type { PipelineConfig, PipelineState } from '../../types/pipeline.types.ts';
import type { EnvProvider } from '../../sdk/env-provider.ts';
import { loadManifest } from '../../overlay/index.ts';
import { postWorkItemComment, addWorkItemTags } from '../../sdk/azure-devops-client.ts';
import { formatErrorComment } from '../../formatters/devops-comment.ts';
import { logWI, logWIError } from './watch-logger.ts';

// ---------------------------------------------------------------------------
// Env-provider action arms
//
// Everything that talks to the overlay's BC-environment provider: the
// shared acquisition/PAT/reprovision helpers, plus the 5 dashboard env-*
// actions (start/stop/delete/share/reprovision). Extracted from watch.ts so
// this overlay-facing layer is testable and importable independently of the
// dashboard action queue and the poll loop.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the overlay's env provider for a config. Returns undefined when no
 * overlay is installed (a public AL pipeline runs without ephemeral BC
 * environments) — every call site checks for this and skips/escalates.
 *
 * Previously duplicated inline as `(await loadManifest()).envProvider?.({config})`
 * at every env call site (the poll path's reprovision + all 5 dashboard arms).
 */
export async function getEnvProvider(config: PipelineConfig): Promise<EnvProvider | undefined> {
  return (await loadManifest()).envProvider?.({ config });
}

/**
 * Inject the live PAT into a config whose persisted copy stripped it to ''
 * (persisted configs never keep secrets). One spelling (falsy-check) covers
 * both original call-site spellings — `config.azureDevOps.pat === ''` in
 * container-dispatcher.ts's executeStartFresh, and `!prConfig.azureDevOps.pat`
 * / `!config.azureDevOps.pat` in watch.ts's gather phase and the dashboard's
 * reprovision-env arm. `azureDevOps.pat` is a required `string` field (never
 * null/undefined per the type), so both spellings only ever distinguish ''
 * from a real token — identical for every value actually in play.
 */
export function ensurePat(cfg: PipelineConfig, fallback: string): PipelineConfig {
  if (!cfg.azureDevOps.pat) cfg.azureDevOps.pat = fallback;
  return cfg;
}

/**
 * Reprovision a BC environment for a work item, or escalate (error comment +
 * need-input tag) on failure. Shared by the poll path (a /reprovision-env PR
 * comment, detected by the pure work-detector and applied in watch.ts) and
 * the dashboard's reprovision-env action — previously two separate copies of
 * this exact try/catch (`executeReprovision` in watch.ts, and an inline copy
 * in the dashboard action switch).
 *
 * Callers are responsible for ensuring `config.azureDevOps.pat` is live
 * (via `ensurePat`) before calling this — it does not inject a fallback
 * itself, matching both original call sites (which ensured the PAT earlier,
 * outside this block).
 */
export async function reprovisionEnv(
  workItemId: number,
  state: PipelineState,
  config: PipelineConfig,
  stateStore: IStateStore,
): Promise<void> {
  try {
    const ep = await getEnvProvider(config);
    if (!ep) { logWI(workItemId, 'No env provider configured (no overlay) — skipping reprovision'); return; }
    await ep.reprovision(workItemId, state, config, stateStore);
    logWI(workItemId, 'Environment reprovisioned successfully');
  } catch (err) {
    logWIError(workItemId, 'Failed to reprovision environment', err);
    const comment = formatErrorComment(workItemId, 'env-reprovision', err instanceof Error ? err : new Error(String(err)));
    await postWorkItemComment(workItemId, comment, config).catch(() => {});
    await addWorkItemTags(workItemId, ['need-input'], config).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dashboard env-* action arms
// ---------------------------------------------------------------------------

export async function executeEnvStart(
  workItemId: number,
  state: PipelineState,
  stateStore: IStateStore,
): Promise<void> {
  if (!state.environment) { logWI(workItemId, 'No environment to start'); return; }
  const config = await stateStore.loadConfig(workItemId);
  if (!config) { logWI(workItemId, 'No config found'); return; }
  const ep = await getEnvProvider(config);
  if (!ep) { logWI(workItemId, 'No env provider configured (no overlay)'); return; }
  await ep.startEnv(state.environment.envId, 'dashboard');
  logWI(workItemId, `Environment started`);
}

export async function executeEnvStop(
  workItemId: number,
  state: PipelineState,
  stateStore: IStateStore,
): Promise<void> {
  if (!state.environment) { logWI(workItemId, 'No environment to stop'); return; }
  const config = await stateStore.loadConfig(workItemId);
  if (!config) { logWI(workItemId, 'No config found'); return; }
  const ep = await getEnvProvider(config);
  if (!ep) { logWI(workItemId, 'No env provider configured (no overlay)'); return; }
  await ep.stopEnv(state.environment.envId, { strict: true }, 'dashboard');
  logWI(workItemId, `Environment stopped`);
}

export async function executeEnvDelete(
  workItemId: number,
  state: PipelineState,
  stateStore: IStateStore,
): Promise<void> {
  if (!state.environment) { logWI(workItemId, 'No environment to delete'); return; }
  const config = await stateStore.loadConfig(workItemId);
  if (!config) { logWI(workItemId, 'No config found'); return; }
  const ep = await getEnvProvider(config);
  if (!ep) { logWI(workItemId, 'No env provider configured (no overlay)'); return; }
  await ep.stopEnv(state.environment.envId, { strict: true }, 'dashboard');
  await ep.deleteEnv(state.environment.envId, { strict: true }, 'dashboard');
  state.environment = undefined;
  await stateStore.save(workItemId, state);
  logWI(workItemId, `Environment deleted`);
}

export async function executeEnvShare(
  workItemId: number,
  state: PipelineState,
  stateStore: IStateStore,
  email: string | undefined,
): Promise<void> {
  if (!state.environment) { logWI(workItemId, 'No environment to share'); return; }
  if (!email) { logWI(workItemId, 'No email provided for env-share'); return; }
  const config = await stateStore.loadConfig(workItemId);
  if (!config) { logWI(workItemId, 'No config found'); return; }
  const ep = await getEnvProvider(config);
  if (!ep) { logWI(workItemId, 'No env provider configured (no overlay)'); return; }
  await ep.shareEnv(state.environment.envId, email, 'dashboard');
  logWI(workItemId, `Environment shared with ${email}`);
}

/**
 * The dashboard's reprovision-env action. Loads the persisted config, ensures
 * a live PAT (the persisted copy stripped it to ''), then delegates to the
 * shared `reprovisionEnv`.
 *
 * Note: on failure, `reprovisionEnv`'s escalation (error comment + need-input
 * tag) posts using the per-item `config` (with the PAT just ensured onto it),
 * not the watcher's `pollingConfig`. This is a deliberate correction, not a
 * proven-equivalent refactor: the original dashboard arm escalated against
 * `pollingConfig` while it already reprovisioned against the per-item
 * `config` — an internal inconsistency in the old code. Converging both on
 * the per-item `config` matches the poll path's precedent (`executeReprovision`
 * in the old `watch.ts` always used its per-item `config`/`prConfig`) and is
 * more correct: the escalation comment/tag now land on the work item's own
 * ADO project rather than the watcher's default. `RepoConfig.azureDevOps.project`
 * is a required field with no deployment-wide fallback (`src/types/pipeline.types.ts`),
 * so this is only behaviorally different from the old dashboard arm when a
 * repo lives in a different ADO project than the watcher's `pollingConfig` —
 * in that case the new behavior (per-item project) is the one we want. See
 * the Task 14 report for the full history.
 */
export async function executeReprovisionEnvAction(
  workItemId: number,
  state: PipelineState,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
): Promise<void> {
  const config = await stateStore.loadConfig(workItemId);
  if (!config) { logWI(workItemId, 'No config found for reprovision'); return; }
  ensurePat(config, pollingConfig.azureDevOps.pat);
  await reprovisionEnv(workItemId, state, config, stateStore);
}
