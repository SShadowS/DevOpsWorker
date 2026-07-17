import { execSync } from 'node:child_process';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IActionStore } from '../pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../pipeline/runner-status.interface.ts';
import { connectStores } from '../db/connect-stores.ts';
import { loadConfig } from './config.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { queryWorkItems, addWorkItemTags, removeWorkItemTags, findRerunCommandInComments, findRerunCommandInPRComments, getPullRequestStatus, fetchTestCaseFailures } from '../sdk/azure-devops-client.ts';
import { buildAreaPathFilter, getActiveAreaPaths } from '../config/repos.ts';
import { removeWorkspaceVolume } from '../sdk/docker.ts';
import type { PipelineConfig, PipelineState, TestCaseFailure } from '../types/pipeline.types.ts';
import { notifyDiscord } from '../sdk/discord-notify.ts';
import {
  detectWork,
  isCheckpointScannable,
  isPrCompletedCandidate,
  isReprovisionCandidate,
  sinceFor,
  type DetectedAction,
  type WorkDetectionInputs,
  type CheckpointScan,
  type PlanApprovedItem,
  type PrCompletedItem,
  type ReprovisionItem,
} from './watch/work-detector.ts';
import {
  log,
  logError,
  logWI,
  logWIError,
  workItemUrl,
  colorForWI,
  releaseColor,
  _resetColorState,
} from './watch/watch-logger.ts';
import {
  getPrReviewContainerEnv,
  executeStartFresh,
  executeContinue,
  type WatchConfig,
} from './watch/container-dispatcher.ts';
import { ensurePat, reprovisionEnv } from './watch/env-actions.ts';
import { processActionFiles } from './watch/action-processor.ts';

// Re-exported for existing consumers/tests that import these from watch.ts.
export { colorForWI, releaseColor, _resetColorState, getPrReviewContainerEnv };
export type { WatchConfig };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_STATE_VOLUME = process.env['DO_STATE_VOLUME'] ?? 'do-pipeline-state';
const DEFAULT_IMAGE_NAME = process.env['DO_PIPELINE_IMAGE'] ?? 'devopsworker:latest';

// ---------------------------------------------------------------------------
// WIQL queries — area path filter restricts to active repos only
// ---------------------------------------------------------------------------

const AREA_FILTER = buildAreaPathFilter();

const WIQL_ANALYSE = `
SELECT [System.Id] FROM WorkItems
WHERE [System.Tags] CONTAINS 'analyse'
  AND [System.State] <> 'Closed'
  AND [System.State] <> 'Removed'
  AND (${AREA_FILTER})
`.trim();

const WIQL_PLAN_APPROVED = `
SELECT [System.Id] FROM WorkItems
WHERE [System.Tags] CONTAINS 'plan-approved'
  AND [System.State] <> 'Closed'
  AND [System.State] <> 'Removed'
  AND (${AREA_FILTER})
`.trim();

const WIQL_NEED_INPUT = `
SELECT [System.Id] FROM WorkItems
WHERE [System.Tags] CONTAINS 'need-input'
  AND [System.State] <> 'Closed'
  AND [System.State] <> 'Removed'
  AND (${AREA_FILTER})
`.trim();

// ---------------------------------------------------------------------------
// Logging — log/logError/logWI/logWIError/workItemUrl/colorForWI/releaseColor
// live in ./watch/watch-logger.ts (imported above; colorForWI/releaseColor
// re-exported for existing test imports).
// ---------------------------------------------------------------------------

async function notifyInfraFailure(
  workItemId: number,
  label: string,
  err: unknown,
  config: PipelineConfig,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await notifyDiscord({
    title: `[infra] WI #${workItemId} ${label}`,
    description: msg,
    severity: 'error',
    source: 'pipeline-watcher',
    url: workItemUrl(workItemId, config),
    fields: [
      { name: 'Work item', value: `#${workItemId}`, inline: true },
      { name: 'Label', value: label, inline: true },
    ],
  });
}

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type WatchAction =
  | { type: 'start-fresh'; workItemId: number }
  | { type: 'continue-pipeline'; workItemId: number };

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export async function pollForAllWork(
  config: PipelineConfig,
  stateStore: IStateStore,
  skipIds: Set<number>,
): Promise<WatchAction[]> {
  // Three-phase pipeline: gather (I/O) → detectWork (pure decision) → apply (writes + dispatch).
  const { detection, reprovisionCtx } = await gatherWorkDetectionInputs(config, stateStore, skipIds);
  const detected = detectWork(detection);
  return applyDetectedActions(detected, reprovisionCtx, config, stateStore);
}

/** Effectful context needed to execute a reprovision action, keyed by work item id. */
type ReprovisionContext = Map<number, { state: PipelineState; prConfig: PipelineConfig }>;

/**
 * Phase 1 — gather. Runs every effectful query the detector needs (WIQL buckets,
 * per-item state loads, comment/PR scans) and packages them as plain data. Comment
 * and PR scans are gated on the set already claimed by an earlier path (reusing the
 * pure `detectWork` for that set) so API-call volume matches the legacy poll, and
 * the /rerun-plan → /fix → /fix-test scans short-circuit in precedence order to
 * preserve the legacy prefix-shadowing (a '/fix-test' work-item comment is caught
 * by the '/fix' scan first).
 */
async function gatherWorkDetectionInputs(
  config: PipelineConfig,
  stateStore: IStateStore,
  skipIds: Set<number>,
): Promise<{ detection: WorkDetectionInputs; reprovisionCtx: ReprovisionContext }> {
  // Pre-fetch need-input tagged items — used to prevent auto-retry loops.
  const needInputIds = new Set(
    await queryWorkItems(WIQL_NEED_INPUT, config).catch(() => [] as number[]),
  );
  // WIQL order is load-bearing for the fetch-ordinal tests: need-input, analyse, plan-approved.
  const analyseIds = await queryWorkItems(WIQL_ANALYSE, config);
  const planApprovedIds = await queryWorkItems(WIQL_PLAN_APPROVED, config);

  const planApproved: PlanApprovedItem[] = [];
  for (const id of planApprovedIds) {
    if (skipIds.has(id)) continue;
    planApproved.push({ id, state: await stateStore.load(id) });
  }

  // Ids the analyse / plan-approved paths already claim. Later (expensive) scans
  // skip these, exactly like the legacy poll's `actions.some(...)` guards. Reusing
  // the pure decision keeps the gate and the decision from ever drifting apart.
  const claimed = new Set(
    detectWork({ skipIds, needInputIds, analyseIds, planApproved, checkpointScans: [], prCompleted: [], reprovision: [] })
      .map(a => a.workItemId),
  );

  const allIds = await stateStore.listAll();

  // Paths 3/4/5 — scan paused items (scannable checkpoint or error state) for
  // /rerun-plan | /fix | /fix-test.
  const checkpointScans: CheckpointScan[] = [];
  for (const id of allIds) {
    if (skipIds.has(id) || claimed.has(id)) continue;
    const state = await stateStore.load(id);
    if (!state || !isCheckpointScannable(state)) continue;
    const since = sinceFor(state);

    const rerunPlanFeedback = await findRerunCommandInComments(id, '/rerun-plan', config, since);
    let fixFeedback: string | null = null;
    let fixTestFeedback: string | null = null;
    let fixTestSource: 'work-item-comment' | 'pr-comment' | null = null;
    let testCaseFailures: TestCaseFailure[] | undefined;

    if (!rerunPlanFeedback) {
      fixFeedback = await findRerunCommandInComments(id, '/fix', config, since);
      if (!fixFeedback) {
        const prId = state.draftPR?.id;
        const fixTestWI = await findRerunCommandInComments(id, '/fix-test', config, since);
        const fixTestPR = !fixTestWI && prId ? await findRerunCommandInPRComments(prId, '/fix-test', config, since) : null;
        fixTestFeedback = fixTestWI ?? fixTestPR;
        if (fixTestFeedback) {
          fixTestSource = fixTestWI ? 'work-item-comment' : 'pr-comment';
          try {
            testCaseFailures = await fetchTestCaseFailures(id, config);
          } catch (err) {
            logWI(id, `Warning: failed to fetch test case failures: ${err}`);
          }
        }
      }
    }

    if (rerunPlanFeedback || fixFeedback || fixTestFeedback) {
      checkpointScans.push({ id, rerunPlanFeedback, fixFeedback, fixTestFeedback, fixTestSource, testCaseFailures });
      claimed.add(id);
    }
  }

  // Path 6 — completed PRs on items paused at pr-published / pr-completed.
  const prCompleted: PrCompletedItem[] = [];
  for (const id of allIds) {
    if (skipIds.has(id) || claimed.has(id)) continue;
    const state = await stateStore.load(id);
    if (!state || !isPrCompletedCandidate(state)) continue;

    const prConfig = await stateStore.loadConfig(id);
    if (!prConfig) {
      log(`Warning: no persisted config for WI #${id}, skipping PR completion check`);
      continue;
    }
    // Ensure PAT is available (persisted config may have empty PAT).
    ensurePat(prConfig, config.azureDevOps.pat);

    let prStatus: { status: string; isDraft: boolean } | null = null;
    try {
      prStatus = await getPullRequestStatus(state.draftPR!.id, prConfig);
    } catch (err) {
      log(`Warning: failed to check PR status for WI #${id}: ${err}`);
    }
    prCompleted.push({ id, prStatus });
    if (prStatus?.status === 'completed') claimed.add(id);
  }

  // Path 7 — /reprovision-env PR comment. Reprovisions the BC environment outside
  // the pipeline; the decision is emitted here, the side effect runs in apply.
  const reprovision: ReprovisionItem[] = [];
  const reprovisionCtx: ReprovisionContext = new Map();
  for (const id of allIds) {
    if (skipIds.has(id) || claimed.has(id)) continue;
    const state = await stateStore.load(id);
    if (!state || !isReprovisionCandidate(state)) continue;

    const prConfig = await stateStore.loadConfig(id);
    if (!prConfig) continue;
    ensurePat(prConfig, config.azureDevOps.pat);

    const since = sinceFor(state);
    const found = await findRerunCommandInPRComments(state.draftPR!.id, '/reprovision-env', prConfig, since).catch(() => null);
    const commentFound = found != null;
    reprovision.push({ id, commentFound });
    if (commentFound) {
      claimed.add(id);
      reprovisionCtx.set(id, { state, prConfig });
    }
  }

  return {
    detection: { skipIds, needInputIds, analyseIds, planApproved, checkpointScans, prCompleted, reprovision },
    reprovisionCtx,
  };
}

/**
 * Phase 3 — apply. Persists each action's intended state-delta + tag-ops, executes
 * the reprovision side effect, and returns the dispatchable actions for the main
 * loop. Reprovision actions are consumed here (side effect only) and never returned.
 */
async function applyDetectedActions(
  detected: DetectedAction[],
  reprovisionCtx: ReprovisionContext,
  config: PipelineConfig,
  stateStore: IStateStore,
): Promise<WatchAction[]> {
  const result: WatchAction[] = [];
  for (const action of detected) {
    if (action.log) logWI(action.workItemId, action.log);

    if (action.kind === 'reprovision') {
      const ctx = reprovisionCtx.get(action.workItemId);
      if (ctx) await reprovisionEnv(action.workItemId, ctx.state, ctx.prConfig, stateStore);
      continue; // side effect only — not dispatched to a container
    }

    if (action.stateDelta) {
      const state = await stateStore.load(action.workItemId);
      if (state) {
        Object.assign(state, action.stateDelta);
        await stateStore.save(action.workItemId, state);
      }
    }
    if (action.tagOps?.remove?.length) {
      await removeWorkItemTags(action.workItemId, action.tagOps.remove, config).catch(() => {});
    }
    if (action.tagOps?.add?.length) {
      await addWorkItemTags(action.workItemId, action.tagOps.add, config).catch(() => {});
    }

    result.push({
      type: action.kind === 'start-fresh' ? 'start-fresh' : 'continue-pipeline',
      workItemId: action.workItemId,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Container dispatch — getContainerEnv/getPrReviewContainerEnv/
// handleContainerOutcome/executeStartFresh/executeContinue/resolveRepoForWorkItem
// live in ./watch/container-dispatcher.ts (imported above). reprovisionEnv/
// ensurePat/getEnvProvider live in ./watch/env-actions.ts (imported above).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Crash recovery — find orphaned sessions for pool recovery
// ---------------------------------------------------------------------------

async function findOrphanedSessions(
  stateStore: IStateStore,
  config: PipelineConfig,
): Promise<number[]> {
  // Find items tagged need-input — these should NOT be auto-resumed
  const needInputIds = new Set(
    await queryWorkItems(WIQL_NEED_INPUT, config).catch(() => [] as number[]),
  );

  const allIds = await stateStore.listAll();
  const orphaned: number[] = [];

  // Only auto-resume sessions that crashed recently (within last 2 hours).
  // Older states are likely stale leftovers from previous pipeline versions
  // or schema changes — resuming them would likely fail or cause confusion.
  const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000;
  const now = Date.now();

  for (const id of allIds) {
    const state = await stateStore.load(id);
    if (!state) continue;
    if (state.completedAt) continue;     // finished
    if (state.checkpoint) continue;       // waiting for human action
    if (state.error) continue;           // terminal failure — needs human intervention
    if (needInputIds.has(id)) {
      log(`Skipping WI #${id} — tagged need-input, requires human intervention`);
      continue;
    }

    // Check staleness — use the last telemetry timestamp or startedAt
    const lastActivity = state.telemetry?.stages?.length
      ? state.telemetry.stages[state.telemetry.stages.length - 1]!.timestamp
      : state.startedAt;
    if (!lastActivity || now - new Date(lastActivity).getTime() > MAX_ORPHAN_AGE_MS) {
      log(`Skipping WI #${id} — state is stale (last activity: ${lastActivity ?? 'unknown'})`);
      continue;
    }

    // Mid-stage crash (no error, no checkpoint, no completion) — resumable
    orphaned.push(id);
  }

  return orphaned;
}

// ---------------------------------------------------------------------------
// Dashboard action queue — trackedExecute/processActionFiles/executeAction
// (the 12-arm dispatch: approve-plan/rerun-plan/fix/fix-test/continue/
// review-pr/force-poll/env-start/env-stop/env-delete/env-share/
// reprovision-env) live in ./watch/action-processor.ts (imported above).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Abortable sleep
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: { aborted: boolean }, actionStore: IActionStore): Promise<void> {
  return new Promise(res => {
    const checkInterval = 1000;
    let elapsed = 0;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return; // prevent overlapping async checks
      checking = true;
      try {
        elapsed += checkInterval;
        // Wake early if action files appear or if aborted/timed out
        const pending = await actionStore.listPending();
        const hasActions = pending.length > 0;
        if (signal.aborted || elapsed >= ms || hasActions) {
          clearInterval(timer);
          res();
        }
      } catch {
        // Ignore errors during sleep polling — will retry next interval
        elapsed += checkInterval;
        if (signal.aborted || elapsed >= ms) {
          clearInterval(timer);
          res();
        }
      } finally {
        checking = false;
      }
    }, checkInterval);
  });
}

// ---------------------------------------------------------------------------
// Environment cleanup — clean up workspace volumes for completed pipelines
// ---------------------------------------------------------------------------

async function cleanupCompletedEnvironments(stateStore: IStateStore): Promise<void> {
  const allIds = await stateStore.listAll();

  for (const id of allIds) {
    const state = await stateStore.load(id);
    if (!state?.completedAt) continue;

    log(`Cleaning up workspace volume for WI #${id}...`);
    try {
      await removeWorkspaceVolume(id);

      // Clear environment from state if it was provisioned
      if (state.environment) {
        const updated = { ...state, environment: undefined };
        await stateStore.save(id, updated);
      }
      log(`  Workspace volume for WI #${id} cleaned up`);
    } catch (err) {
      logError(`  Warning: workspace cleanup failed for WI #${id}`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrent pool helpers
// ---------------------------------------------------------------------------

/** Remove settled promises from the running map. */
export async function reapSettled(running: Map<number, Promise<void>>): Promise<void> {
  for (const [id, p] of [...running.entries()]) {
    // Race the promise against a setTimeout — setTimeout fires after all microtasks,
    // so if p (or its .catch/.finally chain) has already settled, the .then wins.
    const settled = await Promise.race([
      p.then(() => true, () => true),
      new Promise<false>(r => setTimeout(r, 0, false)),
    ]);
    if (settled) {
      running.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseWatchArgs(args: string[]): { intervalMinutes: number; concurrency: number } {
  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error('Error: --interval must be a positive integer (minutes)');
        process.exit(1);
      }
      intervalMinutes = parsed;
    }
    if (args[i] === '--concurrency' && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error('Error: --concurrency must be a positive integer');
        process.exit(1);
      }
      concurrency = parsed;
    }
  }

  return { intervalMinutes, concurrency };
}

// ---------------------------------------------------------------------------
// Main watch loop
// ---------------------------------------------------------------------------

export async function watch(args: string[]): Promise<void> {
  let { intervalMinutes, concurrency: maxConcurrency } = parseWatchArgs(args);
  const intervalMs = intervalMinutes * 60 * 1000;
  const signal = { aborted: false };
  const running = new Map<number, Promise<void>>();

  const watchConfig: WatchConfig = {
    stateVolume: DEFAULT_STATE_VOLUME,
    imageName: DEFAULT_IMAGE_NAME,
  };

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down (waiting for in-flight pipelines to complete)...');
    signal.aborted = true;
    clearInterval(heartbeatInterval);
    clearInterval(janitorInterval);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const activeAreas = getActiveAreaPaths();
  log(`Watch started (polling every ${intervalMinutes} min, concurrency: ${maxConcurrency})`);
  log(`Active repos: ${activeAreas.length > 0 ? activeAreas.join(', ') : 'NONE — no repos are active!'}`);
  if (activeAreas.length === 0) {
    log('WARNING: No active repos configured. Set active: true in src/config/repos.ts');
  }

  // Preflight: verify docker is available and using Linux containers
  try {
    const dockerInfo = execSync('docker info', { stdio: 'pipe', timeout: 10_000 }).toString();
    if (/OSType:\s*windows/i.test(dockerInfo)) {
      log('ERROR: Docker is set to Windows containers. Switch to Linux containers (right-click Docker Desktop tray icon → "Switch to Linux containers").');
      process.exit(1);
    }
  } catch {
    log('ERROR: docker is not available or not running. Ensure Docker is installed and the daemon is started.');
    process.exit(1);
  }

  // Verify critical env vars
  if (!process.env['AZURE_DEVOPS_PAT']) {
    log('ERROR: AZURE_DEVOPS_PAT is not set');
    process.exit(1);
  }

  // Build a config for polling queries (uses env vars, session path doesn't matter for WIQL)
  const pollingConfig = loadConfig('.');
  // Fail loud if AZURE_DEVOPS_* env vars weren't supplied — otherwise the watcher
  // polls 'your-org'/'Your Project' and every WIQL query 404s silently.
  assertRealAdoConfig(pollingConfig, 'watcher');
  const { stateStore, actionStore, runnerStatus, prReviewStore } = await connectStores();

  // Independent heartbeat — runs every 30s regardless of poll loop or container blocking
  const heartbeatInterval = setInterval(async () => {
    try {
      await runnerStatus.writeHeartbeat('watcher');
    } catch { /* non-critical */ }
  }, 30_000);
  // Write initial heartbeat immediately
  runnerStatus.writeHeartbeat('watcher').catch(() => {});

  // Periodic janitor — actions stuck in 'running' for >30min are marked failed.
  // Covers watcher crash mid-action.
  const staleThresholdMs = 30 * 60_000;
  const janitorInterval = setInterval(async () => {
    try {
      const recovered = await actionStore.recoverStale(staleThresholdMs);
      if (recovered > 0) log(`Janitor recovered ${recovered} stale action(s)`);
    } catch { /* non-critical */ }
  }, 60_000);

  // Recover orphaned sessions — launch into pool concurrently
  const orphaned = await findOrphanedSessions(stateStore, pollingConfig);
  if (orphaned.length > 0) {
    log(`Found ${orphaned.length} incomplete session(s) to resume: ${orphaned.join(', ')}`);
    for (const id of orphaned) {
      if (running.size >= maxConcurrency) {
        log(`Concurrency limit reached, deferring recovery of WI #${id}`);
        break;
      }
      logWI(id, 'Resuming orphaned session...');
      const promise = executeContinue(id, stateStore, pollingConfig, watchConfig)
        .catch(async err => {
          logWIError(id, 'Failed to resume', err);
          await notifyInfraFailure(id, 'resume orphan failed', err, pollingConfig);
        })
        .finally(() => releaseColor(id));
      running.set(id, promise);
    }
  }

  while (!signal.aborted) {
    // Reap settled promises
    await reapSettled(running);

    // Check for dynamic concurrency changes from dashboard
    const dynamicMax = await runnerStatus.readDynamicConcurrency();
    if (dynamicMax !== null && dynamicMax !== maxConcurrency) {
      log(`Concurrency changed dynamically: ${maxConcurrency} → ${dynamicMax}`);
      maxConcurrency = dynamicMax;
    }

    // Process any pending dashboard actions (launches into pool)
    try {
      await processActionFiles(stateStore, actionStore, prReviewStore, running, maxConcurrency, pollingConfig, watchConfig);
    } catch (err) {
      logError('Error processing action files', err);
    }

    // Poll for new work if we have capacity
    if (running.size < maxConcurrency) {
      log('Polling Azure DevOps...');
      try {
        const actions = await pollForAllWork(pollingConfig, stateStore, new Set(running.keys()));

        if (actions.length > 0) {
          for (const action of actions) {
            if (running.size >= maxConcurrency) break;

            if (action.type === 'start-fresh') {
              logWI(action.workItemId, 'Starting fresh pipeline');
              const promise = executeStartFresh(action.workItemId, stateStore, pollingConfig, watchConfig)
                .catch(async err => {
                  logWIError(action.workItemId, 'Error during execution', err);
                  await notifyInfraFailure(action.workItemId, 'start-fresh failed', err, pollingConfig);
                })
                .finally(() => releaseColor(action.workItemId));
              running.set(action.workItemId, promise);
            } else {
              logWI(action.workItemId, 'Continuing pipeline');
              const promise = executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig)
                .catch(async err => {
                  logWIError(action.workItemId, 'Error during execution', err);
                  await notifyInfraFailure(action.workItemId, 'continue failed', err, pollingConfig);
                })
                .finally(() => releaseColor(action.workItemId));
              running.set(action.workItemId, promise);
            }
          }
        } else {
          log('No actionable work items found');
        }
      } catch (err) {
        logError('Error during poll', err);
      }
    } else {
      log(`All ${maxConcurrency} slot(s) occupied, skipping poll`);
    }

    // Write runner status for dashboard (non-critical — heartbeat is on its own interval)
    try {
      await runnerStatus.writeStatus(running.size, maxConcurrency, Array.from(running.keys()));
    } catch (err) {
      logError('Warning: failed to write runner status', err);
    }

    // Clean up environments for completed pipelines
    try {
      await cleanupCompletedEnvironments(stateStore);
    } catch (err) {
      logError('Warning: env cleanup check failed', err);
    }

    if (signal.aborted) break;

    // Smart sleep based on pool occupancy
    if (running.size === 0) {
      const nextPoll = new Date(Date.now() + intervalMs)
        .toISOString().replace('T', ' ').slice(0, 19);
      log(`Next poll at ${nextPoll}`);
      await sleep(intervalMs, signal, actionStore);
    } else if (running.size < maxConcurrency) {
      // Poll faster when partially loaded
      const shortInterval = Math.min(intervalMs, 30_000);
      await sleep(shortInterval, signal, actionStore);
    } else {
      // All slots full — wait for any pipeline to finish or interval
      await Promise.race([
        ...Array.from(running.values()).map(p => p.catch(() => {})),
        sleep(intervalMs, signal, actionStore),
      ]);
    }
  }

  // Graceful shutdown — wait for all in-flight pipelines
  if (running.size > 0) {
    log(`Waiting for ${running.size} in-flight pipeline(s) to complete...`);
    await Promise.allSettled(running.values());
    log('All pipelines finished');
  }

  log('Watch stopped');
}
