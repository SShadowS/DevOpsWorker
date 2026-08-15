import type postgres from 'postgres';
import type { IStateStore } from '../../pipeline/state-store.interface.ts';
import type { IReflectionStore } from '../../pipeline/reflection-store.interface.ts';
import type { ReflectionProposal } from '../../db/reflection-proposal-mapper.ts';
import type { PipelineConfig, PipelineState } from '../../types/pipeline.types.ts';
import type { RepoConfig } from '../../config/repo-config.ts';
import { fetchWorkItem, getPullRequestStatus, postWorkItemComment, addWorkItemTags, removeWorkItemTags } from '../../sdk/azure-devops-client.ts';
import { findRepoByAreaPath } from '../../config/repos.ts';
import { pipelineErrorComment } from '../../formatters/devops-comment.ts';
import { notifyPipelineError } from '../../sdk/discord-notify.ts';
import {
  buildDockerArgs,
  createWorkspaceVolume,
  removeWorkspaceVolume,
  removeStaleContainer,
  createVolume,
  removeContainer,
  spawnContainer,
} from '../../sdk/docker.ts';
import { log, logWI, workItemUrl } from './watch-logger.ts';
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
    // Marks a review run as non-production (isTestRun() in review-pr.ts) even
    // when it does post — e.g. a scripted probe run outside NO_POST. Forwarded
    // for the same reason as PR_REVIEW_NO_POST: unset here means every such
    // run is silently recorded as production, with no error.
    PR_REVIEW_TEST_RUN: process.env['PR_REVIEW_TEST_RUN'] ?? '',
    // EVAL-ONLY A/B arms (no-ops when unset). Forwarded here because the
    // allowlist is the only route into a spawned container — a var the eval
    // hooks read but that is not listed silently does nothing, with no error.
    PR_REVIEW_SUBAGENT_MODEL: process.env['PR_REVIEW_SUBAGENT_MODEL'] ?? '',
    PR_REVIEW_SUBAGENT_TOOL_RULE: process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] ?? '',
    PR_REVIEW_AGENT_SET: process.env['PR_REVIEW_AGENT_SET'] ?? '',
    PR_REVIEW_AGENT_ROUTING: process.env['PR_REVIEW_AGENT_ROUTING'] ?? '',
    PR_REVIEW_SCOPED_PAYLOAD: process.env['PR_REVIEW_SCOPED_PAYLOAD'] ?? '',
    PR_REVIEW_SECURITY_BC_ONLY: process.env['PR_REVIEW_SECURITY_BC_ONLY'] ?? '',
    // Git identity inside pipeline containers. Email must be authorized in the
    // AL Object ID Ninja backend app pool; name marks commits as AI-made.
    GIT_USER_NAME: process.env['GIT_USER_NAME'] ?? '',
    GIT_USER_EMAIL: process.env['GIT_USER_EMAIL'] ?? '',
    // Which ADO org/project `scripts/await-pipeline.ts` talks to. Absent from this
    // list until 2026-08-03, so the script fell through to a placeholder org and
    // every CI wait 404'd in a way that read as "no such build" — 11 work items,
    // 83 occurrences, since March. A var the container reads but nobody forwards
    // does not crash; it takes its default and reports something confidently wrong.
    AZURE_DEVOPS_ORG_URL: process.env['AZURE_DEVOPS_ORG_URL'] ?? '',
    AZURE_DEVOPS_PROJECT: process.env['AZURE_DEVOPS_PROJECT'] ?? '',
    // Operational policy read by loadConfig()/buildConfigFromRepo() INSIDE the
    // container. This list is an allowlist: a variable the config layer reads but
    // that is not forwarded here silently falls back to its default, with no error
    // and nothing in the logs. Add new config env vars here when you add them.
    DEFAULT_MODEL: process.env['DEFAULT_MODEL'] ?? '',
    DEFAULT_EFFORT: process.env['DEFAULT_EFFORT'] ?? '',
    REVISION_MAX_ATTEMPTS: process.env['REVISION_MAX_ATTEMPTS'] ?? '',
  };
}

// PR review uses pay-per-token API key when PR_REVIEW_ANTHROPIC_API_KEY is set,
// so the OAuth subscription is reserved for the main pipeline.
export function getPrReviewContainerEnv(): Record<string, string> {
  const prKey = process.env['PR_REVIEW_ANTHROPIC_API_KEY'];
  if (!prKey) return getContainerEnv();
  // Spread the base set so a variable added there is never silently missing here —
  // this pair previously drifted, which is the same silent-staleness failure the
  // allowlist comment above warns about.
  return {
    ...getContainerEnv(),
    // Only the two credential fields differ; everything else — including git
    // identity and operational policy — comes from the base set.
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_API_KEY: prKey,
  };
}

// ---------------------------------------------------------------------------
// Container outcome handling
// ---------------------------------------------------------------------------

/** What a finished container actually did, once state is taken into account. */
export type ContainerOutcome =
  | { kind: 'completed' }
  | { kind: 'checkpoint'; name: string }
  | { kind: 'clean-exit' }
  | {
      kind: 'error';
      type: string;
      stage: string;
      message: string;
      /** True when the error came from the exit code alone and must be written to state. */
      persistError: boolean;
    };

/**
 * Decide what a container run means from its exit code plus the state it left
 * behind. Persisted state — not the exit code — is the source of truth about
 * whether pipeline work succeeded.
 *
 * The exit code of `docker run` conflates two very different things: the exit
 * code of the process inside the container, and docker's OWN failure codes.
 * 125 in particular is docker-CLI-level and is never produced by the pipeline
 * process — it shows up both when the run never started (missing image, bad
 * mount) and when the CLI loses its wait-stream to the daemon mid-run
 * ("error waiting for container: unexpected EOF"). In the latter case the
 * pipeline had already finished its work and persisted a checkpoint, so
 * escalating on the exit code alone fabricates an error over a healthy pause:
 * it overwrites clean state, posts an error comment, pings Discord, and strips
 * the `analyse` tag.
 *
 * A genuine docker-run failure leaves no fresh checkpoint or completion (the
 * container never ran), so it still classifies as an error.
 */
export function classifyContainerOutcome(
  exitCode: number,
  state: PipelineState | null | undefined,
): ContainerOutcome {
  if (exitCode !== 0) {
    // A pipeline-reported error always wins — it carries the real stage and
    // message, and it outranks a checkpoint left over from an earlier pause.
    const stateError = state?.error;
    if (stateError) {
      return {
        kind: 'error',
        type: stateError.type ?? 'container-error',
        stage: stateError.stage ?? 'container',
        message: stateError.message,
        persistError: false,
      };
    }
    // No error and no evidence of finished work — a real container failure.
    if (!state?.completedAt && !state?.checkpoint) {
      return {
        kind: 'error',
        type: 'container-error',
        stage: 'container',
        message: `Container exited with code ${exitCode}`,
        // Only persistable when there is a state row to write it to.
        persistError: Boolean(state),
      };
    }
  }

  if (state?.completedAt) return { kind: 'completed' };
  if (state?.checkpoint) return { kind: 'checkpoint', name: state.checkpoint.name };
  return { kind: 'clean-exit' };
}

export async function handleContainerOutcome(
  workItemId: number,
  exitCode: number,
  stateStore: IStateStore,
  pollingConfig: PipelineConfig,
  watchConfig: WatchConfig,
): Promise<void> {
  const state = await stateStore.load(workItemId);
  const outcome = classifyContainerOutcome(exitCode, state);

  if (exitCode !== 0 && outcome.kind !== 'error') {
    logWI(
      workItemId,
      `Container exited with code ${exitCode}, but state shows ${outcome.kind} — ` +
        `treating as success (docker-level failure, not a pipeline failure)`,
    );
  }

  if (outcome.kind !== 'error') {
    // Container did its job — clean up stale need-input tag if present
    await removeWorkItemTags(workItemId, ['need-input'], pollingConfig).catch(() => {});

    if (outcome.kind === 'completed') {
      logWI(workItemId, 'Pipeline completed successfully');
      await removeWorkspaceVolume(workItemId);
    } else if (outcome.kind === 'checkpoint') {
      logWI(workItemId, `Pipeline paused at checkpoint: ${outcome.name}`);
    } else {
      logWI(workItemId, 'Container exited successfully (no checkpoint, no completion)');
    }
    return;
  }

  logWI(workItemId, `Container exited with code ${exitCode}`);
  // Error handling: post error comment and tag work item
  try {
    // Persist error to state if not already set — prevents findOrphanedSessions
    // from treating this as a resumable mid-stage crash on next watcher restart
    if (state && outcome.persistError) {
      state.error = {
        type: 'ContainerError',
        stage: outcome.stage,
        message: outcome.message,
        timestamp: new Date().toISOString(),
      };
      await stateStore.save(workItemId, state);
    }

    // The original error class is gone by here (the container reported a message,
    // not an object), so a stalled loop is recognised from state instead — which
    // is also why this works for any stalled loop, not just one that threw
    // RevisionExhaustedError. A stalled loop gets the Markdown report; anything
    // else keeps the plain HTML error comment.
    const { text: comment, format } = pipelineErrorComment(
      workItemId,
      outcome.stage,
      new Error(outcome.message),
      state ?? undefined,
    );
    await postWorkItemComment(workItemId, comment, pollingConfig, format);
    logWI(workItemId, 'Posted error comment to work item');

    await notifyPipelineError(
      { type: outcome.type, stage: outcome.stage, message: outcome.message },
      {
        source: 'pipeline-container',
        url: workItemUrl(workItemId, pollingConfig),
        fields: [
          { name: 'Work item', value: `#${workItemId}`, inline: true },
          { name: 'Stage', value: outcome.stage, inline: true },
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

// ---------------------------------------------------------------------------
// Reflection dispatch
//
// The monthly reflection agent has no work item and no repo — it reads
// finding_outcomes/pr_reviews history from Postgres and writes a proposal
// row, so its container needs the DB + credential env pattern the PR
// reviewer uses, minus every repo coordinate (no clone happens).
// ---------------------------------------------------------------------------

export interface ReflectionDispatchDeps {
  /**
   * A Postgres client capable of `.reserve()`. The advisory lock below is
   * SESSION-scoped, so it must be taken and released on the SAME physical
   * connection — see `acquireReflectionLock`.
   */
  sql: postgres.Sql;
  reflectionStore: IReflectionStore;
  watchConfig: WatchConfig;
  /** Injectable clock, defaulting to the real one — lets a test pin "today"
   *  without faking the global Date. */
  now?: () => Date;
}

/**
 * Whether today's scheduler tick should dispatch a reflection run.
 *
 * Pure and total: no I/O, so the day-15 gate and the one-proposal-per-cycle
 * gate can both be exercised without a database. `existing` is expected to
 * come from `IReflectionStore.findByCycle`, which already excludes
 * 'superseded' rows before this function ever sees them — a cycle whose only
 * row is superseded therefore reaches here as `null`, indistinguishable from
 * a cycle with no proposal at all, and this function does not need to know
 * 'superseded' exists.
 *
 * **UTC, not local time** — `getUTCDate()`, not `getDate()`. `cycleDate` in
 * `executeReflection` is `now.toISOString().slice(0, 10)`, and `reflect.ts`'s
 * own default cycle date is the same UTC-based string. Gating on the local
 * day while keying the lookup on the UTC day lets a host east of UTC (local
 * date already the 16th while UTC is still the 15th) or west of UTC (local
 * date still the 14th while UTC has rolled to the 15th) pass this gate on a
 * tick where `cycleDate` reads a day the guard never intended to admit — or,
 * worse, let two ticks either side of UTC midnight both read local-15th,
 * each produce a DIFFERENT `cycleDate`, each see `findByCycle` return null
 * for their own key, and each dispatch: the exact double-spawn the advisory
 * lock exists to prevent, defeated by the gate and the key disagreeing about
 * which calendar they're using.
 */
export function shouldDispatchReflection(now: Date, existing: ReflectionProposal | null): boolean {
  return now.getUTCDate() === 15 && existing === null;
}

/**
 * Advisory-lock key for the reflection dispatch guard+spawn. Any stable
 * constant works, as long as it does not collide with another advisory lock
 * on the same database — mirrors the overlay's `SWEEP_LOCK_KEY` pattern in
 * `private/scripts/lib/outcome-store.ts`, a different fixed value so the two
 * locks can never contend with each other.
 */
const REFLECTION_LOCK_KEY = 0x52_45_46_4c; // 'REFL'

/**
 * Cross-process mutual exclusion around the reflection guard+spawn.
 *
 * `runAtStart: true` (the overlay's `monthly-reflection` task) means every
 * watcher boot calls `executeReflection`, and more than one watcher can be up
 * at once — a compose restart overlapping a hand-run `pipeline watch`. Without
 * this lock, two processes can both read "no proposal for this cycle yet" and
 * both spawn a container: a second, wasted reflection run racing the first.
 * This is the system-level single-writer guarantee the guard alone cannot
 * provide, so it wraps the guard check AND the spawn, not just the spawn.
 *
 * Session-scoped like `pg_advisory_lock` always is, so it is taken and
 * released on the SAME reserved connection — postgres.js pools, and
 * `pg_advisory_unlock` on a different pooled connection is a no-op that
 * leaves the lock held until that backend eventually dies.
 *
 * Returns the reserved connection when the lock was taken, or `null` when
 * another process holds it — not an error, it means the work is already
 * being done.
 */
async function acquireReflectionLock(sql: postgres.Sql): Promise<postgres.ReservedSql | null> {
  const held = await sql.reserve();
  try {
    const rows = await held<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${REFLECTION_LOCK_KEY}) AS locked`;
    if (rows[0]?.locked) return held;
    held.release();
    return null;
  } catch (err) {
    held.release();
    throw err;
  }
}

/** Release the advisory lock and return the connection to the pool. Safe on every path. */
async function releaseReflectionLock(held: postgres.ReservedSql): Promise<void> {
  try {
    await held`SELECT pg_advisory_unlock(${REFLECTION_LOCK_KEY})`;
  } finally {
    // Releasing the connection is what matters even if the unlock statement
    // failed: the lock dies with the backend, but a reserved connection never
    // returned to the pool leaks for good.
    held.release();
  }
}

/**
 * Dispatch the monthly reflection container, if today is its day and no
 * proposal exists yet for this cycle.
 *
 * Called by the overlay's `monthly-reflection` scheduled task on every tick,
 * including once at watcher startup — so this must tolerate being invoked
 * far more often than once a month, and do nothing on every day but the 15th.
 *
 * Never throws. A dispatch failure — a lock error, a docker error, anything
 * unexpected — is logged and swallowed here, matching the `ScheduledTask.run`
 * contract: this must never take the watcher down and must never fail
 * silently. (The scheduler wraps every task's `run` in its own catch too;
 * this function does not rely on that alone, so it behaves the same way
 * whether or not it is reached through the scheduler.)
 */
export async function executeReflection(deps: ReflectionDispatchDeps): Promise<void> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const cycleDate = now.toISOString().slice(0, 10);

    const held = await acquireReflectionLock(deps.sql);
    if (!held) {
      log('Reflection dispatch: another watcher holds the dispatch lock — skipping this tick');
      return;
    }
    try {
      const existing = await deps.reflectionStore.findByCycle(cycleDate);
      if (!shouldDispatchReflection(now, existing)) return;

      // Named after the cycle, not `wi-{id}` — there is no work item. Reused
      // rather than random so a container that dies mid-run leaves a
      // recognisable stale name for `removeContainer` to clear next tick.
      const name = `reflection-${cycleDate}`;
      await createVolume(name);
      await removeContainer(name);

      const args = buildDockerArgs({
        workItemId: 0,
        command: 'reflect',
        env: getPrReviewContainerEnv(),
        stateVolume: deps.watchConfig.stateVolume,
        workspaceVolume: name,
        imageName: deps.watchConfig.imageName,
        extraArgs: ['--cycle-date', cycleDate],
      });
      // buildDockerArgs names the container `wi-0` (no work item to key off
      // of) — override it with the cycle-scoped name used above.
      const nameIdx = args.indexOf('--name');
      if (nameIdx !== -1 && args[nameIdx + 1]) args[nameIdx + 1] = name;

      log(`Reflection dispatch: spawning container for cycle ${cycleDate}`);
      const exitCode = await spawnContainer(args);
      if (exitCode === 0) {
        log(`Reflection dispatch: container for cycle ${cycleDate} finished`);
      } else {
        // Not escalated further here — the reflect agent records its own
        // error on the proposal row and notifies Discord itself (see
        // src/cli/reflect.ts). This log is only about the dispatch, i.e.
        // whether the container ran at all.
        log(`Reflection dispatch: container for cycle ${cycleDate} exited with code ${exitCode}`);
      }
    } finally {
      await releaseReflectionLock(held);
    }
  } catch (err) {
    log(`Reflection dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
