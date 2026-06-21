// scripts/pr-review-ab.ts
/**
 * Replay a fixed set of PRs and summarize pr_reviews + stage_logs telemetry.
 *
 * Usage:
 *   bun scripts/pr-review-ab.ts --prs 44801,44820 --runs 3 --label baseline
 *   bun scripts/pr-review-ab.ts --prs 44801,44820 --label baseline --collect --since <iso>
 *
 * Each run enqueues a review-pr action (the watcher must be running). After all
 * runs complete, re-run with --collect to summarize rows created after the cutoff.
 * Posting is controlled by the PR_REVIEW_NO_POST env var consumed inside review-pr.
 */
import { connectStores } from '../src/db/connect-stores.ts';
import { summarizeRuns, type RunMetrics } from '../src/cli/pr-review-metrics.ts';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const prIds = arg('prs').split(',').filter(Boolean).map(n => parseInt(n, 10));
const runs = parseInt(arg('runs', '3'), 10);
if (!Number.isInteger(runs) || runs < 1) { console.error('--runs must be a positive integer'); process.exit(1); }
const label = arg('label', 'run');
if (prIds.length === 0) { console.error('Need --prs <id,id,...>'); process.exit(1); }

const { sql } = await connectStores();
const enqueueCutoff = new Date().toISOString();

if (process.argv.includes('--collect')) {
  const sinceArg = arg('since');
  if (!sinceArg) { console.error('--collect requires --since <iso>'); process.exit(1); }
  const rows = await sql<RunMetrics[]>`
    SELECT tool_calls AS "toolCalls", turns,
           coalesce(cost_usd,0) AS "costUsd", coalesce(duration_ms,0) AS "durationMs"
    FROM pr_reviews
    WHERE pr_id = ANY(${prIds}) AND tool_calls IS NOT NULL AND created_at >= ${sinceArg}
  `;
  const summary = summarizeRuns(rows as unknown as RunMetrics[]);
  console.log(JSON.stringify({ label, ...summary }, null, 2));
  process.exit(0);
}

if (!process.env['PR_REVIEW_NO_POST']) {
  console.error('[ab] Refusing to enqueue: PR_REVIEW_NO_POST is not set. Set PR_REVIEW_NO_POST=1 to replay without posting, or PR_REVIEW_NO_POST=0 to intentionally post.');
  process.exit(1);
}

console.log(`[ab] cutoff=${enqueueCutoff}`);
for (let r = 0; r < runs; r++) {
  for (const prId of prIds) {
    const proc = Bun.spawn(['bun', 'scripts/trigger-pr-review.ts', '--pr-id', String(prId)],
      { stdout: 'inherit', stderr: 'inherit' });
    await proc.exited;
  }
}
console.log(`[ab] enqueued ${runs * prIds.length} reviews. After the watcher finishes, run:`);
console.log(`  bun scripts/pr-review-ab.ts --prs ${prIds.join(',')} --label ${label} --collect --since ${enqueueCutoff}`);
