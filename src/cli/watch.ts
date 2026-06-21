import { execSync } from 'node:child_process';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IActionStore } from '../pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../pipeline/runner-status.interface.ts';
import type { IPRReviewStore } from '../pipeline/pr-review-store.interface.ts';
import { connectStores } from '../db/connect-stores.ts';
import { loadConfig, loadConfigFromState } from './config.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { queryWorkItems, postWorkItemComment, addWorkItemTags, removeWorkItemTags, fetchWorkItem, findRerunCommandInComments, findRerunCommandInPRComments, getPullRequestStatus, fetchTestCaseFailures } from '../sdk/azure-devops-client.ts';
import { formatErrorComment } from '../formatters/devops-comment.ts';
import { findRepoByAreaPath, findRepoByRepositoryId, buildAreaPathFilter, getActiveAreaPaths } from '../config/repos.ts';
import {
  buildDockerArgs,
  createWorkspaceVolume,
  removeWorkspaceVolume,
  removeStaleContainer,
  spawnContainer,
} from '../sdk/docker.ts';
import type { PipelineConfig, PipelineState, TestCaseFailure } from '../types/pipeline.types.ts';
import type { PipelineAction } from '../dashboard/actions.ts';
import { loadManifest } from '../overlay/index.ts';
import { notifyDiscord, notifyPipelineError } from '../sdk/discord-notify.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_STATE_VOLUME = process.env['DO_STATE_VOLUME'] ?? 'do-pipeline-state';
const DEFAULT_IMAGE_NAME = process.env['DO_PIPELINE_IMAGE'] ?? 'devopsworker:latest';

// ---------------------------------------------------------------------------
// Watch config
// ---------------------------------------------------------------------------

export interface WatchConfig {
  stateVolume: string;
  imageName: string;
}

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
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

function logError(label: string, err: unknown): void {
  log(`${label}: ${err}`);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code) log(`  code: ${e.code}`);
    if (e.status !== undefined) log(`  exit status: ${e.status}`);
    if (e.stderr) log(`  stderr: ${Buffer.isBuffer(e.stderr) ? e.stderr.toString().trim() : e.stderr}`);
    if (e.stack) log(`  stack: ${String(e.stack).split('\n').slice(1, 4).join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// Color-coded per-WI logging
// ---------------------------------------------------------------------------

const COLORS = [
  '\x1b[36m', // cyan
  '\x1b[35m', // magenta
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
];
const RESET = '\x1b[0m';

let colorIndex = 0;
const wiColors = new Map<number, string>();

export function colorForWI(id: number): string {
  if (!wiColors.has(id)) wiColors.set(id, COLORS[colorIndex++ % COLORS.length]!);
  return wiColors.get(id)!;
}

export function releaseColor(id: number): void {
  wiColors.delete(id);
}

function logWI(id: number, message: string): void {
  const c = colorForWI(id);
  log(`${c}[WI #${id}]${RESET} ${message}`);
}

function logWIError(id: number, label: string, err: unknown): void {
  logWI(id, `${label}: ${err}`);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code) logWI(id, `  code: ${e.code}`);
    if (e.status !== undefined) logWI(id, `  exit status: ${e.status}`);
    if (e.stderr) logWI(id, `  stderr: ${Buffer.isBuffer(e.stderr) ? e.stderr.toString().trim() : e.stderr}`);
    if (e.stack) logWI(id, `  stack: ${String(e.stack).split('\n').slice(1, 4).join('\n')}`);
  }
}

function workItemUrl(id: number, config: PipelineConfig): string {
  const org = encodeURIComponent(config.azureDevOps.organization);
  const project = encodeURIComponent(config.azureDevOps.project);
  return `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`;
}

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

/** Reset module-level color state — exported for testing only. */
export function _resetColorState(): void {
  colorIndex = 0;
  wiColors.clear();
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
  const actions: WatchAction[] = [];

  // Pre-fetch need-input tagged items — used to prevent auto-retry loops
  const needInputIds = new Set(
    await queryWorkItems(WIQL_NEED_INPUT, config).catch(() => [] as number[]),
  );

  // Check for items needing fresh analysis.
  // The 'analyse' tag is an explicit "start from scratch" signal — always honour it,
  // even if state already exists (user may be re-running after a previous attempt).
  const analyseIds = await queryWorkItems(WIQL_ANALYSE, config);
  for (const id of analyseIds) {
    if (skipIds.has(id)) continue;
    actions.push({ type: 'start-fresh', workItemId: id });
  }

  // Check for items with approved plans ready to continue
  const planApprovedIds = await queryWorkItems(WIQL_PLAN_APPROVED, config);
  for (const id of planApprovedIds) {
    if (skipIds.has(id)) continue;
    const state = await stateStore.load(id);
    if (state?.checkpoint?.name === 'plan-approved') {
      actions.push({ type: 'continue-pipeline', workItemId: id });
    } else if (state?.error && !needInputIds.has(id)) {
      // Pipeline failed after the plan-approved checkpoint (e.g., at env-provision or coding).
      // The plan-approved tag is still present and the user has removed need-input,
      // signalling they want to retry. Only resume if need-input is absent — this prevents
      // infinite retry loops (handleContainerOutcome re-adds need-input on failure).
      logWI(id, `plan-approved tag present with error at "${state.error.stage}", need-input removed — resuming`);
      if (state.error.type === 'revision-exhausted') {
        state.skipResetState = true;
      }
      state.error = undefined;
      await stateStore.save(id, state);
      actions.push({ type: 'continue-pipeline', workItemId: id });
    }
  }

  // Check for /rerun-plan or /fix comments on paused items (checkpoint or error state).
  // This catches the case where a user posts feedback instead of adding a tag.
  // Only scan items paused at plan-approved or pr-published checkpoints, or in error state.
  // Skip old completed items to avoid excessive API calls.
  const SCANNABLE_CHECKPOINTS = new Set(['plan-approved', 'pr-published']);
  const allIdsForScan = await stateStore.listAll();
  const checkpointedIds: number[] = [];
  for (const id of allIdsForScan) {
    if (skipIds.has(id)) continue;
    const s = await stateStore.load(id);
    if (!s || s.completedAt) continue;
    if (s.error) { checkpointedIds.push(id); continue; }
    if (s.checkpoint && SCANNABLE_CHECKPOINTS.has(s.checkpoint.name)) checkpointedIds.push(id);
  }

  for (const id of checkpointedIds) {
    if (actions.some(a => a.workItemId === id)) continue; // already queued
    const state = await stateStore.load(id);
    if (!state) continue;
    const since = state.error?.timestamp ?? state.checkpoint?.enteredAt;

    // Check for /rerun-plan
    const rerunFeedback = await findRerunCommandInComments(id, '/rerun-plan', config, since);
    if (rerunFeedback) {
      logWI(id, `Found /rerun-plan comment — restarting planning`);
      state.error = undefined;
      state.checkpoint = undefined;
      state.revisionFeedback = {
        source: 'work-item-comment',
        feedback: rerunFeedback,
        targetStage: 'planning',
      };
      // humanFeedback is what buildPrompt reads for the agent's prompt
      // Strip the command prefix so the agent only sees the user's message
      const rerunMessage = rerunFeedback.replace(/^\s*\/rerun-plan\s*/i, '').trim();
      state.humanFeedback = { rerunComment: rerunMessage || rerunFeedback, source: 'work-item-comment' };
      await stateStore.save(id, state);
      await removeWorkItemTags(id, ['need-input', 'plan-approved'], config).catch(() => {});
      actions.push({ type: 'continue-pipeline', workItemId: id });
      continue;
    }

    // Check for /fix
    const fixFeedback = await findRerunCommandInComments(id, '/fix', config, since);
    if (fixFeedback) {
      logWI(id, `Found /fix comment — restarting coding`);
      state.error = undefined;
      state.checkpoint = undefined;
      state.rerunMode = 'fix';
      state.revisionFeedback = {
        source: 'work-item-comment',
        feedback: fixFeedback,
        targetStage: 'coding',
      };
      const fixMessage = fixFeedback.replace(/^\s*\/fix\s*/i, '').trim();
      state.humanFeedback = { rerunComment: fixMessage || fixFeedback, source: 'work-item-comment' };
      await stateStore.save(id, state);
      await removeWorkItemTags(id, ['need-input'], config).catch(() => {});
      actions.push({ type: 'continue-pipeline', workItemId: id });
      continue;
    }

    // Check for /fix-test
    const prId = state.draftPR?.id;
    const fixTestWI = await findRerunCommandInComments(id, '/fix-test', config, since);
    const fixTestPR = !fixTestWI && prId ? await findRerunCommandInPRComments(prId, '/fix-test', config, since) : null;
    const fixTestFeedback = fixTestWI ?? fixTestPR;
    if (fixTestFeedback) {
      const fixTestSource: 'work-item-comment' | 'pr-comment' = fixTestWI ? 'work-item-comment' : 'pr-comment';
      logWI(id, `Found /fix-test comment — fetching test case failures and restarting coding`);
      let testCaseFailures: TestCaseFailure[] | undefined;
      try {
        testCaseFailures = await fetchTestCaseFailures(id, config);
      } catch (err) {
        logWI(id, `Warning: failed to fetch test case failures: ${err}`);
      }
      state.error = undefined;
      state.checkpoint = undefined;
      state.rerunMode = 'fix-test';
      state.revisionFeedback = {
        source: fixTestSource,
        feedback: fixTestFeedback,
        targetStage: 'coding',
      };
      const fixTestMessage = fixTestFeedback.replace(/^\s*\/fix-test\s*/i, '').trim();
      state.humanFeedback = {
        rerunComment: fixTestMessage || fixTestFeedback,
        source: fixTestSource,
        testCaseFailures,
      };
      await stateStore.save(id, state);
      await removeWorkItemTags(id, ['need-input'], config).catch(() => {});
      actions.push({ type: 'continue-pipeline', workItemId: id });
      continue;
    }
  }

  // Check for completed PRs on items paused at pr-published or pr-completed checkpoint.
  // This is the 5th detection path — auto-continues without manual intervention.
  const allIdsForPR = await stateStore.listAll();
  const prCompletedIds: number[] = [];
  for (const id of allIdsForPR) {
    if (skipIds.has(id)) continue;
    if (actions.some(a => a.workItemId === id)) continue;
    const s = await stateStore.load(id);
    if (!s || s.completedAt) continue;
    if ((s.checkpoint?.name === 'pr-completed' || s.checkpoint?.name === 'pr-published') && s.draftPR?.id && !s.error) prCompletedIds.push(id);
  }

  for (const id of prCompletedIds) {
    const state = await stateStore.load(id);
    if (!state?.draftPR?.id) continue;

    const prConfig = await stateStore.loadConfig(id);
    if (!prConfig) {
      log(`Warning: no persisted config for WI #${id}, skipping PR completion check`);
      continue;
    }
    // Ensure PAT is available (persisted config may have empty PAT)
    if (!prConfig.azureDevOps.pat) {
      prConfig.azureDevOps.pat = config.azureDevOps.pat;
    }

    try {
      const prStatus = await getPullRequestStatus(state.draftPR.id, prConfig);
      if (prStatus?.status === 'completed') {
        logWI(id, 'PR completed — auto-continuing pipeline');
        actions.push({ type: 'continue-pipeline', workItemId: id });
      }
    } catch (err) {
      log(`Warning: failed to check PR status for WI #${id}: ${err}`);
    }
  }

  // Path #6: Check for /reprovision-env PR comment — reprovision BC environment outside pipeline
  // Scan items that have a PR and are paused at a PR-related checkpoint or in error state.
  const allIdsForReprovision = await stateStore.listAll();
  const reprovisionCandidates: number[] = [];
  for (const id of allIdsForReprovision) {
    if (skipIds.has(id)) continue;
    if (actions.some(a => a.workItemId === id)) continue;
    const s = await stateStore.load(id);
    if (!s || s.completedAt || !s.draftPR?.id) continue;
    if (s.checkpoint != null || s.error != null) reprovisionCandidates.push(id);
  }

  for (const id of reprovisionCandidates) {
    const state = await stateStore.load(id);
    if (!state?.draftPR?.id) continue;

    const prConfig = await stateStore.loadConfig(id);
    if (!prConfig) continue;
    if (!prConfig.azureDevOps.pat) {
      prConfig.azureDevOps.pat = config.azureDevOps.pat;
    }

    const since = state.error?.timestamp ?? state.checkpoint?.enteredAt;
    const found = await findRerunCommandInPRComments(state.draftPR.id, '/reprovision-env', prConfig, since).catch(() => null);
    if (found) {
      logWI(id, 'Found /reprovision-env PR comment — scheduling environment reprovision');
      try {
        const ep = (await loadManifest()).envProvider?.({ config: prConfig });
        if (!ep) { logWI(id, 'No env provider configured (no overlay) — skipping reprovision'); continue; }
        await ep.reprovision(id, state, prConfig, stateStore);
        logWI(id, 'Environment reprovisioned successfully');
      } catch (err) {
        logWIError(id, 'Failed to reprovision environment', err);
        const comment = formatErrorComment(id, 'env-reprovision', err instanceof Error ? err : new Error(String(err)));
        await postWorkItemComment(id, comment, prConfig).catch(() => {});
        await addWorkItemTags(id, ['need-input'], prConfig).catch(() => {});
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Docker dispatch helpers
// ---------------------------------------------------------------------------

function getContainerEnv(): Record<string, string> {
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

async function handleContainerOutcome(
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
// Pipeline execution helpers
// ---------------------------------------------------------------------------

async function executeStartFresh(
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
    if (prConfig.azureDevOps.pat === '') {
      prConfig.azureDevOps.pat = pollingConfig.azureDevOps.pat;
    }
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

  // 1. Fetch work item to get area path
  const workItem = await fetchWorkItem(workItemId, pollingConfig);
  const match = findRepoByAreaPath(workItem.areaPath);
  if (!match) {
    throw new Error(
      `No repo config found for area path "${workItem.areaPath}" (WI #${workItemId})`,
    );
  }
  const { key: repoKey, config: repoConfig } = match;
  logWI(workItemId, `Matched repo "${repoKey}" for area path "${workItem.areaPath}"`);

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

async function executeContinue(
  workItemId: number,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  // Determine repo from persisted config's area path
  const persistedConfig = await stateStore.loadConfig(workItemId);
  let repoKey: string;
  let repoConfig;

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
    const workItem = await fetchWorkItem(workItemId, pollingConfig);
    const match = findRepoByAreaPath(workItem.areaPath);
    if (!match) {
      throw new Error(
        `No repo config found for area path "${workItem.areaPath}" (WI #${workItemId})`,
      );
    }
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
      // Create workspace volume
      const createProc = Bun.spawn(['docker', 'volume', 'create', workspaceVolume], { stdout: 'pipe', stderr: 'pipe' });
      await createProc.exited;

      // Remove any stale container
      const rmProc = Bun.spawn(['docker', 'rm', '-f', containerName], { stdout: 'pipe', stderr: 'pipe' });
      await rmProc.exited;

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
      // Clean up workspace volume
      const cleanProc = Bun.spawn(['docker', 'volume', 'rm', '-f', workspaceVolume], { stdout: 'pipe', stderr: 'pipe' });
      await cleanProc.exited;
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
