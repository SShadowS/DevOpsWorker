#!/usr/bin/env bun
/**
 * await-pipeline.ts — Trigger an Azure DevOps pipeline and block until it completes.
 *
 * Designed to be called by the coder agent via a single Bash tool call, eliminating
 * the token-wasting `sleep && echo` poll loops the agent would otherwise run.
 *
 * Claude Code (CLI v2 / SDK 0.3+) AUTO-BACKGROUNDS any blocking Bash command that runs
 * longer than 120s (the `tengu_auto_background_agents` speculation, threshold 120000ms).
 * Once backgrounded, the agent must tail-poll the task output file — one turn per poll —
 * which blows through maxTurns (observed: coder hit error_max_turns polling a backgrounded
 * await-pipeline). So the default --timeout (100s) is sized to return BEFORE the 120s
 * auto-background cap, leaving headroom for bun startup + network. If the run hasn't
 * finished, the script prints the run id and exits 2 with a re-attach command; the agent
 * re-runs with `--attach <runId>` (which inherits the same short timeout) to keep watching
 * the SAME run — no new build, no sleep loop, no backgrounding.
 *
 * Usage:
 *   bun run scripts/await-pipeline.ts --branch <branch> [--pipeline <id>] [--timeout <seconds>]
 *   bun run scripts/await-pipeline.ts --attach <runId> [--timeout <seconds>]   # resume watching, no new build
 *
 * Environment:
 *   AZURE_DEVOPS_PAT   — Personal access token (required)
 *   ADO_ORG_URL        — e.g. https://dev.azure.com/your-org (or --org flag)
 *   ADO_PROJECT        — e.g. Your Project (or --project flag)
 *
 * Exit codes:
 *   0 — Pipeline succeeded
 *   1 — Pipeline failed (build log excerpt included in output)
 *   2 — Still in progress at timeout (re-attach command printed) OR genuine timeout
 *   3 — Usage/configuration error
 */

import { parseArgs } from 'util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineRun {
  id: number;
  status: string;        // 'inProgress' | 'completed' | 'notStarted' | 'cancelling'
  result?: string;       // 'succeeded' | 'failed' | 'canceled'
  _links?: { web?: { href?: string } };
}

interface TimelineRecord {
  id: string;
  name: string;
  type: string;
  state: string;
  result?: string;
  log?: { id: number; url: string };
}

interface AdoCtx {
  authHeader: string;
  apiBase: string;
  orgUrl: string;
  project: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type RunSource = { mode: 'trigger' } | { mode: 'attach'; runId: number };

/**
 * Decide whether this invocation triggers a new build or attaches to an existing
 * run. `--attach <runId>` wins and skips triggering (so re-watching a long build
 * never starts a duplicate). Otherwise `--branch` is required to trigger.
 */
export function parseRunSource(opts: { attach?: string; branch?: string }): RunSource {
  if (opts.attach !== undefined) {
    const runId = parseInt(opts.attach, 10);
    if (Number.isNaN(runId)) throw new Error('--attach requires a numeric run id');
    return { mode: 'attach', runId };
  }
  if (!opts.branch) throw new Error('--branch is required (or use --attach <runId> to resume)');
  return { mode: 'trigger' };
}

/**
 * Validate the --trigger-only flag. It only makes sense when triggering a new
 * build (you can't "trigger-only" a run that already exists via --attach).
 */
export function validateTriggerOnly(source: RunSource, triggerOnly: boolean): void {
  if (triggerOnly && source.mode === 'attach') {
    throw new Error('--trigger-only cannot be combined with --attach (attach watches an existing run)');
  }
}

/**
 * Parseable handle printed after a trigger-only run. Deliberately prints ONLY the
 * runId and a delegation instruction — NOT a runnable `--attach` command — so the
 * caller (coder) cannot copy-paste an inline poll loop and must hand the runId to
 * the ci-waiter subagent. The PreToolUse guard hook blocks inline `--attach` anyway.
 */
export function buildTriggerHandle(runId: number): string {
  return [
    `runId=${runId}`,
    `Build triggered. Do NOT wait for it yourself — hand this runId to the ci-waiter subagent`,
    `(Task with subagent_type "ci-waiter"); it polls until the build finishes and reports PASSED/FAILED.`,
    `Do NOT re-run with --branch (that starts a duplicate build).`,
  ].join('\n');
}

/**
 * Message printed when a run is still going at timeout — tells the caller how to resume.
 * The re-run command carries `--waiter` when this invocation was the ci-waiter subagent,
 * so the subagent's next `--attach` keeps the sentinel the guard hook requires.
 */
export function buildResumeHint(runId: number, timeoutS: number, waiter = false): string {
  const waiterFlag = waiter ? ' --waiter' : '';
  return [
    `Pipeline run #${runId} is still in progress (did not finish within ${timeoutS}s).`,
    `To keep watching the SAME run without triggering a new build, re-run:`,
    ``,
    `  bun scripts/await-pipeline.ts --attach ${runId} --timeout ${timeoutS}${waiterFlag}`,
    ``,
    `Do NOT use sleep loops, and do NOT re-run with --branch (that starts a duplicate build).`,
  ].join('\n');
}

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ---------------------------------------------------------------------------
// Azure DevOps REST helpers
// ---------------------------------------------------------------------------

async function adoFetch<T>(ctx: AdoCtx, path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${ctx.apiBase}${path}${sep}api-version=7.1`;
  const res = await fetch(url, {
    headers: { Authorization: ctx.authHeader, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ADO API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function adoPost<T>(ctx: AdoCtx, path: string, body: unknown): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${ctx.apiBase}${path}${sep}api-version=7.1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: ctx.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ADO API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function triggerPipeline(ctx: AdoCtx, pipeId: string, branchName: string): Promise<PipelineRun> {
  // Use the Builds API which supports sourceBranch directly
  return adoPost<PipelineRun>(ctx, '/build/builds', {
    definition: { id: parseInt(pipeId, 10) },
    sourceBranch: `refs/heads/${branchName}`,
  });
}

async function getRunStatus(ctx: AdoCtx, runId: number): Promise<PipelineRun> {
  return adoFetch<PipelineRun>(ctx, `/build/builds/${runId}`);
}

async function getTimeline(ctx: AdoCtx, runId: number): Promise<{ records: TimelineRecord[] }> {
  return adoFetch<{ records: TimelineRecord[] }>(ctx, `/build/builds/${runId}/timeline`);
}

async function getBuildLog(ctx: AdoCtx, logUrl: string): Promise<string> {
  const res = await fetch(logUrl, { headers: { Authorization: ctx.authHeader } });
  if (!res.ok) return '(could not fetch log)';
  return res.text();
}

function runWebUrl(ctx: AdoCtx, run: PipelineRun): string {
  return run._links?.web?.href ?? `${ctx.orgUrl}/${encodeURIComponent(ctx.project)}/_build/results?buildId=${run.id}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      branch:   { type: 'string' },
      attach:   { type: 'string' },
      'trigger-only': { type: 'boolean', default: false },
      waiter: { type: 'boolean', default: false },  // ci-waiter sentinel: marks an --attach as coming from the subagent
      pipeline: { type: 'string', default: '973' },
      timeout:  { type: 'string', default: '100' },  // < 120s CLI auto-background cap (see header)
      org:      { type: 'string', default: process.env.ADO_ORG_URL ?? 'https://dev.azure.com/your-org' },
      project:  { type: 'string', default: process.env.ADO_PROJECT ?? 'Your Project' },
      poll:     { type: 'string', default: '30' },
    },
    strict: true,
  });

  const pat = process.env.AZURE_DEVOPS_PAT;
  if (!pat) {
    console.error('ERROR: AZURE_DEVOPS_PAT environment variable is required');
    process.exit(3);
  }

  const triggerOnly = values['trigger-only'] === true;
  const waiter = values.waiter === true;

  let source: RunSource;
  try {
    source = parseRunSource(values);
    validateTriggerOnly(source, triggerOnly);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(3);
  }

  const orgUrl = values.org!;
  const project = values.project!;
  const ctx: AdoCtx = {
    authHeader: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    apiBase: `${orgUrl}/${encodeURIComponent(project)}/_apis`,
    orgUrl,
    project,
  };
  const pipelineId = values.pipeline!;
  const timeoutS = parseInt(values.timeout!, 10);
  const pollIntervalS = parseInt(values.poll!, 10);

  // 1. Trigger a new run, or attach to an existing one
  let run: PipelineRun;
  if (source.mode === 'trigger') {
    console.log(`Triggering pipeline ${pipelineId} on branch "${values.branch}"...`);
    try {
      run = await triggerPipeline(ctx, pipelineId, values.branch!);
    } catch (err) {
      console.error(`Failed to trigger pipeline: ${(err as Error).message}`);
      process.exit(3);
    }
    console.log(`Pipeline run #${run.id} started: ${runWebUrl(ctx, run)}`);

    // Trigger-only: hand back the runId and exit immediately. The caller (coder)
    // owns the runId authoritatively, then delegates the long poll to a cheap
    // ci-waiter subagent via `--attach <runId>`. Avoids burning the caller's
    // turns/context on the wait.
    if (triggerOnly) {
      console.log(`\n${buildTriggerHandle(run.id)}`);
      process.exit(0);
    }
  } else {
    console.log(`Attaching to existing pipeline run #${source.runId} (no new build triggered)...`);
    try {
      run = await getRunStatus(ctx, source.runId);
    } catch (err) {
      console.error(`Failed to read run #${source.runId}: ${(err as Error).message}`);
      process.exit(3);
    }
    console.log(`Watching run #${run.id}: ${runWebUrl(ctx, run)}`);
  }

  const runUrl = runWebUrl(ctx, run);

  // 2. Poll until completion or timeout (checks status before sleeping, so an
  //    already-finished attach returns immediately)
  const startTime = Date.now();
  const deadline = startTime + timeoutS * 1000;
  let latest: PipelineRun = run;

  while (latest.status !== 'completed' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalS * 1000));
    try {
      latest = await getRunStatus(ctx, run.id);
    } catch (err) {
      console.error(`Warning: poll failed (${(err as Error).message}), retrying...`);
      continue;
    }
    console.log(`[${formatElapsed(Date.now() - startTime)}] status=${latest.status} result=${latest.result ?? '-'}`);
  }

  // 3. Handle result
  if (latest.status !== 'completed') {
    console.error(`\n${buildResumeHint(run.id, timeoutS, waiter)}`);
    console.error(`Run URL: ${runUrl}`);
    process.exit(2);
  }

  if (latest.result === 'succeeded') {
    console.log(`\n✅ Pipeline SUCCEEDED`);
    console.log(`Run URL: ${runUrl}`);
    process.exit(0);
  }

  // 4. Pipeline failed — fetch logs for failed/warning steps
  console.error(`\n❌ Pipeline FAILED (result: ${latest.result})`);
  console.error(`Run URL: ${runUrl}`);

  try {
    const timeline = await getTimeline(ctx, run.id);
    // Match tasks that failed outright or succeeded with issues (causes partiallySucceeded)
    const nonSuccessResults = new Set(['failed', 'succeededWithIssues']);
    const failedTasks = timeline.records.filter(
      r => r.type === 'Task' && r.result != null && nonSuccessResults.has(r.result) && r.log,
    );

    if (failedTasks.length === 0) {
      console.error('\nNo failed task logs found in timeline.');
      const taskRecords = timeline.records.filter(r => r.type === 'Task');
      console.error(`\nAll task results (${taskRecords.length} tasks):`);
      for (const r of taskRecords) {
        console.error(`  ${r.name}: ${r.result ?? 'no result'}`);
      }
    }

    for (const task of failedTasks.slice(0, 3)) {  // Cap at 3 to avoid huge output
      console.error(`\n--- Failed: ${task.name} ---`);
      const logText = await getBuildLog(ctx, task.log!.url);
      const lines = logText.split('\n');
      const tail = lines.slice(-100).join('\n');
      if (lines.length > 100) {
        console.error(`(showing last 100 of ${lines.length} lines)`);
      }
      console.error(tail);
    }
  } catch (err) {
    console.error(`Warning: could not fetch failure logs: ${(err as Error).message}`);
  }

  process.exit(1);
}

if (import.meta.main) run();
