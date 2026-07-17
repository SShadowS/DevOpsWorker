import { execSync } from 'node:child_process';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IActionStore } from '../pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../pipeline/runner-status.interface.ts';
import type { IPRReviewStore } from '../pipeline/pr-review-store.interface.ts';
import { connectStores } from '../db/connect-stores.ts';
import { loadConfig } from './config.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { queryWorkItems, postWorkItemComment, addWorkItemTags, removeWorkItemTags, findRerunCommandInComments, findRerunCommandInPRComments, getPullRequestStatus, fetchTestCaseFailures } from '../sdk/azure-devops-client.ts';
import { formatErrorComment } from '../formatters/devops-comment.ts';
import { findRepoByRepositoryId, buildAreaPathFilter, getActiveAreaPaths } from '../config/repos.ts';
import {
  buildDockerArgs,
  removeWorkspaceVolume,
  spawnContainer,
  createVolume,
  removeVolume,
  removeContainer,
} from '../sdk/docker.ts';
import type { PipelineConfig, PipelineState, TestCaseFailure } from '../types/pipeline.types.ts';
import type { PipelineAction } from '../dashboard/actions.ts';
import { loadManifest } from '../overlay/index.ts';
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
  handleContainerOutcome,
  executeStartFresh,
  executeContinue,
  type WatchConfig,
} from './watch/container-dispatcher.ts';

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
    if (!prConfig.azureDevOps.pat) prConfig.azureDevOps.pat = config.azureDevOps.pat;

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
    if (!prConfig.azureDevOps.pat) prConfig.azureDevOps.pat = config.azureDevOps.pat;

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
      if (ctx) await executeReprovision(action.workItemId, ctx.state, ctx.prConfig, stateStore);
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

/** Execute a /reprovision-env action: reprovision the BC env, or escalate on failure. */
async function executeReprovision(
  workItemId: number,
  state: PipelineState,
  prConfig: PipelineConfig,
  stateStore: IStateStore,
): Promise<void> {
  try {
    const ep = (await loadManifest()).envProvider?.({ config: prConfig });
    if (!ep) { logWI(workItemId, 'No env provider configured (no overlay) — skipping reprovision'); return; }
    await ep.reprovision(workItemId, state, prConfig, stateStore);
    logWI(workItemId, 'Environment reprovisioned successfully');
  } catch (err) {
    logWIError(workItemId, 'Failed to reprovision environment', err);
    const comment = formatErrorComment(workItemId, 'env-reprovision', err instanceof Error ? err : new Error(String(err)));
    await postWorkItemComment(workItemId, comment, prConfig).catch(() => {});
    await addWorkItemTags(workItemId, ['need-input'], prConfig).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Container dispatch — getContainerEnv/getPrReviewContainerEnv/
// handleContainerOutcome/executeStartFresh/executeContinue/resolveRepoForWorkItem
// live in ./watch/container-dispatcher.ts (imported above).
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
// Dashboard action file processing
// ---------------------------------------------------------------------------

/** Run an action's body and record terminal status in the action store.
 *  On success: markCompleted. On failure: markFailed (the original error is still rethrown). */
async function trackedExecute(
  actionStore: IActionStore,
  actionId: number,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
    await actionStore.markCompleted(actionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await actionStore.markFailed(actionId, msg).catch(() => {});
    throw err;
  }
}

async function processActionFiles(
  stateStore: IStateStore,
  actionStore: IActionStore,
  prReviewStore: IPRReviewStore,
  running: Map<number, Promise<void>>,
  maxConcurrency: number,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  const ids = await actionStore.listPending();
  if (ids.length === 0) return;

  for (const workItemId of ids) {
    // Check concurrency limit before claiming (claim transitions pending → running)
    if (running.size >= maxConcurrency) {
      log(`Concurrency limit reached (${running.size}/${maxConcurrency}), deferring remaining actions`);
      break;
    }

    const action = await actionStore.claimNextPending(workItemId);
    if (!action) continue;
    const actionId = action.id!;

    // Force-poll: terminal immediately, no body
    if (action.type === 'force-poll') {
      log('Force-poll requested from dashboard');
      await actionStore.markCompleted(actionId);
      continue;
    }

    // Env actions are quick CLI calls — execute without taking a concurrency slot
    if (action.type.startsWith('env-')) {
      logWI(workItemId, `Processing env action: ${action.type}`);
      trackedExecute(actionStore, actionId,
        () => executeAction(action, stateStore, prReviewStore, pollingConfig, watchConfig),
      ).catch(err => logWIError(workItemId, `Failed env action ${action.type}`, err));
      continue;
    }

    // PR reviews share workItemId=0 — use negative PR ID as concurrency key to allow parallel reviews
    let concurrencyKey = workItemId;
    if (action.type === 'review-pr') {
      const prId = JSON.parse(action.feedback ?? '{}').prId;
      concurrencyKey = prId ? -prId : workItemId;
      if (running.has(concurrencyKey)) {
        log(`[PR #${prId}] Already reviewing, skipping`);
        // Release the claim — another worker still holds the slot.
        await actionStore.markFailed(actionId, 'duplicate: another review for this PR is already running');
        continue;
      }
      log(`[PR #${prId ?? '?'}] Processing review-pr action`);
    } else {
      if (running.has(workItemId)) {
        log(`Skipping action for WI #${workItemId} — pipeline already running`);
        await actionStore.markFailed(actionId, 'duplicate: pipeline already running for this work item');
        continue;
      }
      logWI(workItemId, `Processing dashboard action: ${action.type}`);
    }

    const promise = trackedExecute(actionStore, actionId,
      () => executeAction(action, stateStore, prReviewStore, pollingConfig, watchConfig),
    )
      .catch(err => logWIError(workItemId, `Failed to execute action ${action.type}`, err))
      .finally(() => { running.delete(concurrencyKey); releaseColor(workItemId); });
    running.set(concurrencyKey, promise);
  }
}

async function executeAction(
  action: PipelineAction,
  stateStore: IStateStore,
  prReviewStore: IPRReviewStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  // review-pr actions don't have pipeline state (workItemId is 0)
  // Spawn a Docker container that runs the review (same infra as pipeline stages)
  if (action.type === 'review-pr') {
    const payload = JSON.parse(action.feedback ?? '{}');
    const { prId, repoKey, repositoryId, project, sourceBranch, targetBranch, prUrl } = payload;
    if (!prId || !repoKey) {
      log(`Invalid review-pr action: missing prId or repoKey`);
      return;
    }

    const repo = findRepoByRepositoryId(repositoryId);
    if (!repo) {
      log(`Cannot review PR #${prId}: unknown repo ${repositoryId}`);
      return;
    }

    // Use PR ID as workspace volume name (not work item ID)
    const workspaceVolume = `pr-review-${prId}`;
    const containerName = `pr-review-${prId}`;
    try {
      // Create workspace volume. Names here are PR-keyed (pr-review-{prId}), not the
      // wi-{id} scheme createWorkspaceVolume derives — use the generic, name-agnostic
      // primitives instead of that helper. Swallow create failures exactly like the
      // original raw spawn did (it awaited .exited without checking the exit code).
      await createVolume(workspaceVolume).catch(() => {});

      // Remove any stale container
      await removeContainer(containerName);

      // Build container args
      const args = buildDockerArgs({
        workItemId: 0,
        repoKey: repo.key,
        repo: repo.config,
        command: 'review-pr',
        env: getPrReviewContainerEnv(),
        stateVolume: watchConfig.stateVolume,
        workspaceVolume,
        imageName: watchConfig.imageName,
        extraArgs: [
          '--pr-id', String(prId),
          '--repo-id', repositoryId,
          '--source-branch', sourceBranch || '',
          '--target-branch', targetBranch || '',
          ...(prUrl ? ['--pr-url', prUrl] : []),
          '--action-id', String(action.id),
        ],
      });

      // Override container name (buildDockerArgs uses wi-{id} by default)
      const nameIdx = args.indexOf('--name');
      if (nameIdx !== -1 && args[nameIdx + 1]) {
        args[nameIdx + 1] = containerName;
      }

      log(`[PR #${prId}] Spawning review container`);
      const exitCode = await spawnContainer(args);

      if (exitCode === 0) {
        log(`[PR #${prId}] Review completed`);
      } else {
        log(`[PR #${prId}] Review container exited with code ${exitCode}`);
        // Dedup: review-pr.ts inside the container already notifies on agent
        // errors (rate-limit, validation, etc.) and writes a pr_reviews row.
        // Only notify here when the container died before saving — i.e. there
        // is no row for this action yet (OOM kill, segfault, image issue).
        const existing = action.id != null
          ? await prReviewStore.findByActionId(action.id).catch(() => null)
          : null;
        if (!existing) {
          await notifyDiscord({
            title: `PR review container exit ${exitCode}`,
            description: `Container died without saving a review row — likely a host-level issue (OOM, image, docker socket).`,
            severity: 'error',
            source: 'pr-review-watcher',
            url: prUrl,
            fields: [
              { name: 'PR', value: `#${prId}`, inline: true },
              { name: 'Repo', value: repo.config.azureDevOps.repositoryName, inline: true },
              { name: 'Exit code', value: String(exitCode), inline: true },
            ],
          });
        }
      }
    } catch (err) {
      logError(`[PR #${prId}] Failed to review`, err);
      const msg = err instanceof Error ? err.message : String(err);
      await notifyDiscord({
        title: `PR review spawn failed`,
        description: msg,
        severity: 'error',
        source: 'pr-review-watcher',
        url: prUrl,
        fields: [
          { name: 'PR', value: `#${prId}`, inline: true },
          { name: 'Repo', value: repo.config.azureDevOps.repositoryName, inline: true },
        ],
      });
    } finally {
      // Clean up workspace volume (PR-keyed name — see createVolume call above)
      await removeVolume(workspaceVolume);
    }
    return;
  }

  // Normal pipeline actions require state
  const state = await stateStore.load(action.workItemId);
  if (!state) {
    logWI(action.workItemId, `No state found, skipping`);
    return;
  }

  switch (action.type) {
    case 'approve-plan': {
      // Add the plan-approved tag, then continue the pipeline
      try {
        await addWorkItemTags(action.workItemId, ['plan-approved'], pollingConfig);
        logWI(action.workItemId, `Added "plan-approved" tag`);
      } catch (err) {
        logWI(action.workItemId, `Warning: failed to add tag: ${err}`);
      }
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'rerun-plan': {
      state.revisionFeedback = {
        source: 'dashboard',
        feedback: action.feedback ?? '',
        targetStage: 'planning',
      };
      state.error = undefined;
      state.checkpoint = undefined;
      const rerunFeedback = action.feedback ?? '';
      const rerunMessage = rerunFeedback.replace(/^\s*\/rerun-plan\s*/i, '').trim();
      state.humanFeedback = { rerunComment: rerunMessage || rerunFeedback, source: 'work-item-comment' };
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'fix': {
      state.revisionFeedback = {
        source: 'dashboard',
        feedback: action.feedback ?? '',
        targetStage: 'coding',
      };
      state.rerunMode = 'fix';
      state.error = undefined;
      state.checkpoint = undefined;
      const fixFeedbackStr = action.feedback ?? '';
      const fixMessage = fixFeedbackStr.replace(/^\s*\/fix\s*/i, '').trim();
      state.humanFeedback = { rerunComment: fixMessage || fixFeedbackStr, source: 'work-item-comment' };
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'fix-test': {
      state.revisionFeedback = {
        source: 'dashboard',
        feedback: action.feedback ?? '',
        targetStage: 'coding',
      };
      state.rerunMode = 'fix-test';
      state.error = undefined;
      state.checkpoint = undefined;
      const fixTestFeedbackStr = action.feedback ?? '';
      const fixTestMessage = fixTestFeedbackStr.replace(/^\s*\/fix-test\s*/i, '').trim();
      let dashboardTestCaseFailures: TestCaseFailure[] | undefined;
      try {
        dashboardTestCaseFailures = await fetchTestCaseFailures(action.workItemId, pollingConfig);
      } catch (err) {
        logWI(action.workItemId, `Warning: failed to fetch test case failures: ${err}`);
      }
      state.humanFeedback = {
        rerunComment: fixTestMessage || fixTestFeedbackStr,
        source: 'work-item-comment',
        testCaseFailures: dashboardTestCaseFailures,
      };
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'continue': {
      if (state.error?.type === 'revision-exhausted') {
        state.skipResetState = true;
      }
      state.error = undefined;
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'env-start': {
      if (!state.environment) { logWI(action.workItemId, 'No environment to start'); break; }
      const config = await stateStore.loadConfig(action.workItemId);
      if (!config) { logWI(action.workItemId, 'No config found'); break; }
      const ep = (await loadManifest()).envProvider?.({ config });
      if (!ep) { logWI(action.workItemId, 'No env provider configured (no overlay)'); break; }
      await ep.startEnv(state.environment.envId, 'dashboard');
      logWI(action.workItemId, `Environment started`);
      break;
    }

    case 'env-stop': {
      if (!state.environment) { logWI(action.workItemId, 'No environment to stop'); break; }
      const config = await stateStore.loadConfig(action.workItemId);
      if (!config) { logWI(action.workItemId, 'No config found'); break; }
      const ep = (await loadManifest()).envProvider?.({ config });
      if (!ep) { logWI(action.workItemId, 'No env provider configured (no overlay)'); break; }
      await ep.stopEnv(state.environment.envId, { strict: true }, 'dashboard');
      logWI(action.workItemId, `Environment stopped`);
      break;
    }

    case 'env-delete': {
      if (!state.environment) { logWI(action.workItemId, 'No environment to delete'); break; }
      const config = await stateStore.loadConfig(action.workItemId);
      if (!config) { logWI(action.workItemId, 'No config found'); break; }
      const ep = (await loadManifest()).envProvider?.({ config });
      if (!ep) { logWI(action.workItemId, 'No env provider configured (no overlay)'); break; }
      await ep.stopEnv(state.environment.envId, { strict: true }, 'dashboard');
      await ep.deleteEnv(state.environment.envId, { strict: true }, 'dashboard');
      state.environment = undefined;
      await stateStore.save(action.workItemId, state);
      logWI(action.workItemId, `Environment deleted`);
      break;
    }

    case 'env-share': {
      if (!state.environment) { logWI(action.workItemId, 'No environment to share'); break; }
      if (!action.email) { logWI(action.workItemId, 'No email provided for env-share'); break; }
      const config = await stateStore.loadConfig(action.workItemId);
      if (!config) { logWI(action.workItemId, 'No config found'); break; }
      const ep = (await loadManifest()).envProvider?.({ config });
      if (!ep) { logWI(action.workItemId, 'No env provider configured (no overlay)'); break; }
      await ep.shareEnv(state.environment.envId, action.email, 'dashboard');
      logWI(action.workItemId, `Environment shared with ${action.email}`);
      break;
    }

    case 'reprovision-env': {
      const config = await stateStore.loadConfig(action.workItemId);
      if (!config) { logWI(action.workItemId, 'No config found for reprovision'); break; }
      // Inject live PAT (persisted config strips it to '')
      if (!config.azureDevOps.pat) {
        config.azureDevOps.pat = pollingConfig.azureDevOps.pat;
      }
      try {
        const ep = (await loadManifest()).envProvider?.({ config });
        if (!ep) { logWI(action.workItemId, 'No env provider configured (no overlay) — skipping reprovision'); break; }
        await ep.reprovision(action.workItemId, state, config, stateStore);
        logWI(action.workItemId, 'Environment reprovisioned successfully');
      } catch (err) {
        logWIError(action.workItemId, 'Failed to reprovision environment', err);
        const comment = formatErrorComment(action.workItemId, 'env-reprovision', err instanceof Error ? err : new Error(String(err)));
        await postWorkItemComment(action.workItemId, comment, pollingConfig).catch(() => {});
        await addWorkItemTags(action.workItemId, ['need-input'], pollingConfig).catch(() => {});
      }
      break;
    }
  }
}

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
