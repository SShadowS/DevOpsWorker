import type { IStateStore } from '../../pipeline/state-store.interface.ts';
import type { IActionStore } from '../../pipeline/action-store.interface.ts';
import type { IPRReviewStore } from '../../pipeline/pr-review-store.interface.ts';
import type { PipelineConfig, TestCaseFailure } from '../../types/pipeline.types.ts';
import type { PipelineAction } from '../../dashboard/actions.ts';
import { addWorkItemTags, fetchTestCaseFailures } from '../../sdk/azure-devops-client.ts';
import { findRepoByRepositoryId } from '../../config/repos.ts';
import {
  buildDockerArgs,
  spawnContainer,
  createVolume,
  removeVolume,
  removeContainer,
} from '../../sdk/docker.ts';
import { notifyDiscord } from '../../sdk/discord-notify.ts';
import { applyRerun } from './work-detector.ts';
import { log, logError, logWI, logWIError, releaseColor } from './watch-logger.ts';
import {
  getPrReviewContainerEnv,
  executeContinue,
  type WatchConfig,
} from './container-dispatcher.ts';
import {
  executeEnvStart,
  executeEnvStop,
  executeEnvDelete,
  executeEnvShare,
  executeReprovisionEnvAction,
} from './env-actions.ts';

// ---------------------------------------------------------------------------
// Dashboard action queue
//
// Everything involved in draining the dashboard's action queue: claiming
// pending actions under the concurrency limit, running each one, and
// recording its terminal status. Extracted from watch.ts so this queue is
// testable independently of the poll loop and the container dispatcher.
// ---------------------------------------------------------------------------

/** Run an action's body and record terminal status in the action store.
 *  On success: markCompleted. On failure: markFailed (the original error is still rethrown). */
export async function trackedExecute(
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

export async function processActionFiles(
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

export async function executeAction(
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
      applyRerun(state, {
        mode: 'rerun-plan',
        feedback: action.feedback ?? '',
        source: 'dashboard',
        targetStage: 'planning',
      });
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'fix': {
      applyRerun(state, {
        mode: 'fix',
        feedback: action.feedback ?? '',
        source: 'dashboard',
        targetStage: 'coding',
      });
      await stateStore.save(action.workItemId, state);
      await executeContinue(action.workItemId, stateStore, pollingConfig, watchConfig);
      break;
    }

    case 'fix-test': {
      let dashboardTestCaseFailures: TestCaseFailure[] | undefined;
      try {
        dashboardTestCaseFailures = await fetchTestCaseFailures(action.workItemId, pollingConfig);
      } catch (err) {
        logWI(action.workItemId, `Warning: failed to fetch test case failures: ${err}`);
      }
      applyRerun(state, {
        mode: 'fix-test',
        feedback: action.feedback ?? '',
        source: 'dashboard',
        targetStage: 'coding',
        testCaseFailures: dashboardTestCaseFailures,
      });
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

    case 'env-start':
      await executeEnvStart(action.workItemId, state, stateStore);
      break;

    case 'env-stop':
      await executeEnvStop(action.workItemId, state, stateStore);
      break;

    case 'env-delete':
      await executeEnvDelete(action.workItemId, state, stateStore);
      break;

    case 'env-share':
      await executeEnvShare(action.workItemId, state, stateStore, action.email);
      break;

    case 'reprovision-env':
      await executeReprovisionEnvAction(action.workItemId, state, stateStore, pollingConfig);
      break;
  }
}
