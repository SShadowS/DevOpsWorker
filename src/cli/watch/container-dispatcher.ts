import type { IStateStore } from '../../pipeline/state-store.interface.ts';
import type { PipelineConfig } from '../../types/pipeline.types.ts';
import type { RepoConfig } from '../../config/repo-config.ts';
import { fetchWorkItem, getPullRequestStatus, postWorkItemComment, addWorkItemTags, removeWorkItemTags } from '../../sdk/azure-devops-client.ts';
import { findRepoByAreaPath } from '../../config/repos.ts';
import { formatErrorComment } from '../../formatters/devops-comment.ts';
import { notifyPipelineError } from '../../sdk/discord-notify.ts';
import {
  buildDockerArgs,
  createWorkspaceVolume,
  removeWorkspaceVolume,
  removeStaleContainer,
  spawnContainer,
} from '../../sdk/docker.ts';
import { logWI, workItemUrl } from './watch-logger.ts';
import { ensurePat } from './env-actions.ts';

// ---------------------------------------------------------------------------
// Container dispatcher
//
// Everything involved in turning a watch decision (start-fresh / continue)
// into a spawned pipeline container, plus the outcome handling that follows
// it. Extracted from watch.ts so this effectful spawn-and-wait layer is
// testable in isolation from the poll loop and the dashboard action queue.
// ---------------------------------------------------------------------------

export interface WatchConfig {
  stateVolume: string;
  imageName: string;
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a work item's repo by fetching it and matching its area path
 * against the repo registry. Throws when no repo config matches — callers
 * escalate this as an infra failure (the watcher's start-fresh/continue
 * catch handlers notify Discord and leave the item for manual retry).
 *
 * Dedups the `fetchWorkItem` → `findRepoByAreaPath` → throw block that used
 * to appear separately in `executeStartFresh` and in `executeContinue`'s
 * no-persisted-config fallback.
 */
export async function resolveRepoForWorkItem(
  workItemId: number,
  config: PipelineConfig,
): Promise<{ key: string; config: RepoConfig; areaPath: string }> {
  const workItem = await fetchWorkItem(workItemId, config);
  const match = findRepoByAreaPath(workItem.areaPath);
  if (!match) {
    throw new Error(
      `No repo config found for area path "${workItem.areaPath}" (WI #${workItemId})`,
    );
  }
  return { key: match.key, config: match.config, areaPath: workItem.areaPath };
}

// ---------------------------------------------------------------------------
// Container env builders
// ---------------------------------------------------------------------------

export function getContainerEnv(): Record<string, string> {
  return {
    AZURE_DEVOPS_PAT: process.env['AZURE_DEVOPS_PAT'] ?? '',
    CLAUDE_CODE_OAUTH_TOKEN: process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] ?? '',
    ENV_API_TOKEN: process.env['ENV_API_TOKEN'] ?? '',
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
    DISCORD_WEBHOOK_URL: process.env['DISCORD_WEBHOOK_URL'] ?? '',
    PR_REVIEW_NO_POST: process.env['PR_REVIEW_NO_POST'] ?? '',
    // Git identity inside pipeline containers. Email must be authorized in the
    // AL Object ID Ninja backend app pool; name marks commits as AI-made.
    GIT_USER_NAME: process.env['GIT_USER_NAME'] ?? '',
    GIT_USER_EMAIL: process.env['GIT_USER_EMAIL'] ?? '',
  };
}

// PR review uses pay-per-token API key when PR_REVIEW_ANTHROPIC_API_KEY is set,
// so the OAuth subscription is reserved for the main pipeline.
export function getPrReviewContainerEnv(): Record<string, string> {
  const prKey = process.env['PR_REVIEW_ANTHROPIC_API_KEY'];
  if (!prKey) return getContainerEnv();
  return {
    AZURE_DEVOPS_PAT: process.env['AZURE_DEVOPS_PAT'] ?? '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_API_KEY: prKey,
    ENV_API_TOKEN: process.env['ENV_API_TOKEN'] ?? '',
    DATABASE_URL: process.env['DATABASE_URL'] ?? '',
    DISCORD_WEBHOOK_URL: process.env['DISCORD_WEBHOOK_URL'] ?? '',
    PR_REVIEW_NO_POST: process.env['PR_REVIEW_NO_POST'] ?? '',
    // Git identity inside pipeline containers. Email must be authorized in the
    // AL Object ID Ninja backend app pool; name marks commits as AI-made.
    GIT_USER_NAME: process.env['GIT_USER_NAME'] ?? '',
    GIT_USER_EMAIL: process.env['GIT_USER_EMAIL'] ?? '',
  };
}

// ---------------------------------------------------------------------------
// Container outcome handling
// ---------------------------------------------------------------------------

export async function handleContainerOutcome(
  workItemId: number,
  exitCode: number,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  if (exitCode === 0) {
    // Container exited successfully — clean up stale need-input tag if present
    await removeWorkItemTags(workItemId, ['need-input'], pollingConfig).catch(() => {});

    // Check state for checkpoint vs completed
    const state = await stateStore.load(workItemId);
    if (state?.completedAt) {
      logWI(workItemId, 'Pipeline completed successfully');
      await removeWorkspaceVolume(workItemId);
    } else if (state?.checkpoint) {
      logWI(workItemId, `Pipeline paused at checkpoint: ${state.checkpoint.name}`);
    } else {
      logWI(workItemId, 'Container exited successfully (no checkpoint, no completion)');
    }
  } else {
    logWI(workItemId, `Container exited with code ${exitCode}`);
    // Error handling: post error comment and tag work item
    // Check state file for rich error details (e.g., analyzer needs-input questions)
    try {
      const state = await stateStore.load(workItemId);
      const stateError = state?.error;
      const errorForComment = stateError?.message
        ? new Error(stateError.message)
        : new Error(`Container exited with code ${exitCode}`);
      const stage = stateError?.stage ?? 'container';

      // Persist error to state if not already set — prevents findOrphanedSessions
      // from treating this as a resumable mid-stage crash on next watcher restart
      if (state && !stateError) {
        state.error = {
          type: 'ContainerError',
          stage,
          message: `Container exited with code ${exitCode}`,
          timestamp: new Date().toISOString(),
        };
        await stateStore.save(workItemId, state);
      }

      const comment = formatErrorComment(
        workItemId,
        stage,
        errorForComment,
      );
      await postWorkItemComment(workItemId, comment, pollingConfig);
      logWI(workItemId, 'Posted error comment to work item');

      const errorType = stateError?.type ?? 'container-error';
      await notifyPipelineError(
        { type: errorType, stage, message: errorForComment.message },
        {
          source: 'pipeline-container',
          url: workItemUrl(workItemId, pollingConfig),
          fields: [
            { name: 'Work item', value: `#${workItemId}`, inline: true },
            { name: 'Stage', value: stage, inline: true },
            { name: 'Exit code', value: String(exitCode), inline: true },
          ],
        },
      );
    } catch (err) {
      logWI(workItemId, `Warning: failed to post error comment: ${err}`);
    }

    try {
      await addWorkItemTags(workItemId, ['need-input'], pollingConfig);
      await removeWorkItemTags(workItemId, ['analyse'], pollingConfig);
      logWI(workItemId, 'Tagged "need-input", removed "analyse" for error escalation');
    } catch (err) {
      logWI(workItemId, `Warning: failed to update tags: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

export async function executeStartFresh(
  workItemId: number,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  // 0a. Guard: refuse to restart if work item already has an active PR
  const existingState = await stateStore.load(workItemId);
  if (existingState?.draftPR?.id) {
    const prId = existingState.draftPR.id;
    // Use persisted config for the correct repositoryId, fall back to polling config
    const prConfig = (await stateStore.loadConfig(workItemId)) ?? pollingConfig;
    ensurePat(prConfig, pollingConfig.azureDevOps.pat);
    const prStatus = await getPullRequestStatus(prId, prConfig);

    if (prStatus && prStatus.status === 'active') {
      const prUrl = existingState.draftPR.url;
      const statusLabel = prStatus.isDraft ? 'draft' : 'published';
      logWI(workItemId, `Blocked fresh start — active ${statusLabel} PR #${prId} exists`);

      const comment =
        `<b>⚠️ Fresh pipeline run blocked</b><br><br>` +
        `This work item already has an active ${statusLabel} pull request: ` +
        `<a href="${prUrl}">PR #${prId}</a>.<br><br>` +
        `To re-analyse from scratch, first <b>abandon or complete</b> the existing PR, ` +
        `then re-add the <code>analyse</code> tag.<br>` +
        `To iterate on existing code, use <code>/fix</code> or <code>/rerun-plan</code> comments instead.`;
      await postWorkItemComment(workItemId, comment, pollingConfig).catch(() => {});
      await removeWorkItemTags(workItemId, ['analyse'], pollingConfig).catch(() => {});
      return;
    }
  }

  // 0b. Clean up tags — remove analyse (consumed). Keep need-input until container
  // succeeds — if the container fails, handleContainerOutcome re-adds it anyway,
  // and removing it prematurely leaves a gap where a watcher restart would see
  // no tag and no error in state, causing a false orphan resume.
  await removeWorkItemTags(workItemId, ['analyse'], pollingConfig).catch(() => {});

  // 1. Resolve repo from the work item's area path
  const { key: repoKey, config: repoConfig, areaPath } = await resolveRepoForWorkItem(workItemId, pollingConfig);
  logWI(workItemId, `Matched repo "${repoKey}" for area path "${areaPath}"`);

  // 2. Create workspace volume
  const workspaceVolume = await createWorkspaceVolume(workItemId);
  logWI(workItemId, `Created workspace volume: ${workspaceVolume}`);

  // 3. Remove any stale container
  await removeStaleContainer(workItemId);

  // 4. Build and spawn container
  const args = buildDockerArgs({
    workItemId,
    repoKey,
    repo: repoConfig,
    command: 'run',
    env: getContainerEnv(),
    stateVolume: watchConfig.stateVolume,
    workspaceVolume,
    imageName: watchConfig.imageName,
  });
  logWI(workItemId, `Spawning container for fresh pipeline run`);
  const exitCode = await spawnContainer(args);

  // 5. Handle outcome
  await handleContainerOutcome(workItemId, exitCode, stateStore, pollingConfig, watchConfig);
}

export async function executeContinue(
  workItemId: number,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  // Determine repo from persisted config's area path
  const persistedConfig = await stateStore.loadConfig(workItemId);
  let repoKey: string;
  let repoConfig: RepoConfig;

  if (persistedConfig) {
    const match = findRepoByAreaPath(persistedConfig.azureDevOps.areaPath);
    if (!match) {
      throw new Error(
        `No repo config for persisted area path "${persistedConfig.azureDevOps.areaPath}" (WI #${workItemId})`,
      );
    }
    repoKey = match.key;
    repoConfig = match.config;
  } else {
    // Fall back to fetching work item
    const match = await resolveRepoForWorkItem(workItemId, pollingConfig);
    repoKey = match.key;
    repoConfig = match.config;
  }

  logWI(workItemId, `Continuing pipeline with repo "${repoKey}"`);

  // Remove any stale container (but reuse existing workspace volume)
  await removeStaleContainer(workItemId);

  // Build and spawn container
  const workspaceVolume = `wi-${workItemId}`;
  const args = buildDockerArgs({
    workItemId,
    repoKey,
    repo: repoConfig,
    command: 'continue',
    env: getContainerEnv(),
    stateVolume: watchConfig.stateVolume,
    workspaceVolume,
    imageName: watchConfig.imageName,
  });
  logWI(workItemId, `Spawning container for pipeline continue`);
  const exitCode = await spawnContainer(args);

  await handleContainerOutcome(workItemId, exitCode, stateStore, pollingConfig, watchConfig);
}
