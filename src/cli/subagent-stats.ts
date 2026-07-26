import { connectStores } from '../db/connect-stores.ts';
import { summarizeSubAgents, type SubAgentRunUsage, type SubAgentStat } from './pr-review-metrics.ts';

// ---------------------------------------------------------------------------
// subagent-stats — per-named-sub-agent usage
//
// An agent's run totals (cost, turns, tool calls) cannot say which of its eight
// sub-agents spent them, and `modelUsage` only splits by model — so sub-agents
// sharing Sonnet collapse into one number. This reads the per-sub-agent
// attribution captured on each run and ranks it.
//
// Two sources, because the two reviewers persist to different places: the
// standalone `pr-reviewer` writes to `pr_reviews`, while the in-pipeline
// `code-reviewer` writes to `pipeline_state.telemetry.stages` (under the
// enclosing stage name, not its own). Both are scanned by default — reading
// only one silently under-reports the fan-out that actually dominates spend.
// ---------------------------------------------------------------------------

export type Source = 'reviews' | 'pipeline' | 'all';

export interface Options {
  limit: number;
  repoKey?: string;
  source: Source;
  json: boolean;
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { limit: 50, source: 'all', json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--limit' || a === '-n') && args[i + 1]) opts.limit = Number(args[++i]);
    else if ((a === '--repo' || a === '-r') && args[i + 1]) opts.repoKey = args[++i];
    else if (a === '--source' && args[i + 1]) opts.source = args[++i] as Source;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Top N tool names by call count, as `Read×12, Grep×4`. */
export function topTools(toolCalls: Record<string, number>, n = 3): string {
  return Object.entries(toolCalls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

/** One dispatching run: the parent that fanned out, and what its sub-agents used. */
export interface DispatchRun {
  /** Where it came from — `pr#1234` or `wi 63396/coding`. */
  origin: string;
  /** Total billed for the whole run (parent + fan-out). */
  costUsd: number;
  subAgents: Record<string, SubAgentRunUsage>;
}

/** Pull dispatching runs out of a pipeline state's stage telemetry. */
export function dispatchRunsFromTelemetry(
  workItemId: number,
  stages: Array<{ name: string; costUsd: number; subAgents?: Record<string, SubAgentRunUsage> }>,
): DispatchRun[] {
  return stages
    .filter(s => s.subAgents && Object.keys(s.subAgents).length > 0)
    .map(s => ({
      origin: `wi ${workItemId}/${s.name}`,
      costUsd: s.costUsd,
      subAgents: s.subAgents!,
    }));
}

function renderTable(stats: SubAgentStat[]): void {
  console.log('');
  console.log('  sub-agent                     runs   turns(med)   tokens(med)   cost(sum)  cost(med)   top tools');
  console.log('  ' + '-'.repeat(112));
  for (const s of stats) {
    console.log(
      '  ' +
        s.name.padEnd(28) +
        String(s.runs).padStart(5) +
        String(s.medianTurns).padStart(12) +
        s.medianTokens.toLocaleString('en-US').padStart(14) +
        fmtUsd(s.totalCostUsd).padStart(12) +
        fmtUsd(s.medianCostUsd).padStart(11) +
        '   ' + topTools(s.toolCalls),
    );
  }
}

export async function subagentStats(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const stores = await connectStores();

  const runs: DispatchRun[] = [];
  let reviewsScanned = 0;
  let pipelineStagesScanned = 0;

  if (opts.source === 'reviews' || opts.source === 'all') {
    const reviews = await stores.prReviewStore.listRecent(opts.limit);
    const scoped = opts.repoKey ? reviews.filter(r => r.repoKey === opts.repoKey) : reviews;
    reviewsScanned = scoped.length;
    for (const r of scoped) {
      if (!r.subAgents || Object.keys(r.subAgents).length === 0) continue;
      runs.push({
        origin: `pr#${r.prId}`,
        costUsd: r.costUsd ?? 0,
        subAgents: r.subAgents as Record<string, SubAgentRunUsage>,
      });
    }
  }

  if (opts.source === 'pipeline' || opts.source === 'all') {
    // No "recent N" index on pipeline_state — listAll() then load is the only
    // route. Bounded by --limit so this stays cheap on a busy deployment.
    const ids = (await stores.stateStore.listAll()).slice(-opts.limit);
    for (const id of ids) {
      const state = await stores.stateStore.load(id);
      if (!state) continue;
      // repoKey lives on the persisted config, not the state — only pay for the
      // extra load when a --repo filter is actually in play.
      if (opts.repoKey) {
        const cfg = await stores.stateStore.loadConfig(id);
        if (cfg?.repoKey !== opts.repoKey) continue;
      }
      pipelineStagesScanned += state.telemetry.stages.length;
      runs.push(...dispatchRunsFromTelemetry(id, state.telemetry.stages));
    }
  }

  const stats = summarizeSubAgents(runs.map(r => r.subAgents));

  if (opts.json) {
    console.log(JSON.stringify({ reviewsScanned, pipelineStagesScanned, dispatchingRuns: runs.length, stats }, null, 2));
    return;
  }

  console.log(
    `\nSub-agent stats — ${runs.length} dispatching run(s) ` +
      `across ${reviewsScanned} PR review(s) and ${pipelineStagesScanned} pipeline stage(s)`,
  );
  if (stats.length === 0) {
    console.log('\nNo sub-agent data yet. Runs recorded before this was captured carry none.');
    return;
  }

  renderTable(stats);

  const total = stats.reduce((a, s) => a + s.totalCostUsd, 0);
  const runTotal = runs.reduce((a, r) => a + r.costUsd, 0);
  console.log('  ' + '-'.repeat(112));
  console.log(
    `  Attributed to sub-agents: ${fmtUsd(total)} of ${fmtUsd(runTotal)} billed ` +
      `(remainder is the dispatching agent's own spend).`,
  );
  console.log('  Costs are apportioned by token share within each model — an estimate, not a billed figure.\n');
}
