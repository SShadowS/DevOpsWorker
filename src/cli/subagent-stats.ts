import { connectStores } from '../db/connect-stores.ts';
import { summarizeSubAgents, type SubAgentRunUsage } from './pr-review-metrics.ts';

// ---------------------------------------------------------------------------
// subagent-stats — per-named-sub-agent usage across recent PR reviews
//
// A reviewer's run totals (cost, turns, tool calls) cannot say which of its
// eight sub-agents spent them, and `modelUsage` only splits by model — so
// sub-agents sharing Sonnet collapse into one number. This reads the
// per-sub-agent attribution captured on each review and ranks it.
// ---------------------------------------------------------------------------

interface Options {
  limit: number;
  repoKey?: string;
  json: boolean;
}

export function parseArgs(args: string[]): Options {
  const opts: Options = { limit: 50, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--limit' || a === '-n') && args[i + 1]) opts.limit = Number(args[++i]);
    else if ((a === '--repo' || a === '-r') && args[i + 1]) opts.repoKey = args[++i];
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

export async function subagentStats(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const stores = await connectStores();

  const reviews = await stores.prReviewStore.listRecent(opts.limit);
  const scoped = opts.repoKey ? reviews.filter(r => r.repoKey === opts.repoKey) : reviews;
  const withData = scoped.filter(r => r.subAgents && Object.keys(r.subAgents).length > 0);

  const stats = summarizeSubAgents(
    withData.map(r => r.subAgents as Record<string, SubAgentRunUsage>),
  );

  if (opts.json) {
    console.log(JSON.stringify({ reviewsScanned: scoped.length, reviewsWithSubAgents: withData.length, stats }, null, 2));
    return;
  }

  console.log(`\nSub-agent stats — ${withData.length} of ${scoped.length} recent reviews carry per-sub-agent data`);
  if (withData.length < scoped.length) {
    console.log('(reviews recorded before this was captured, or that dispatched no sub-agents, are excluded)');
  }
  if (stats.length === 0) {
    console.log('\nNo sub-agent data yet.');
    return;
  }

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

  const total = stats.reduce((a, s) => a + s.totalCostUsd, 0);
  const runTotal = withData.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  console.log('  ' + '-'.repeat(112));
  console.log(
    `  Attributed to sub-agents: ${fmtUsd(total)} of ${fmtUsd(runTotal)} billed ` +
      `(remainder is the orchestrator's own spend).`,
  );
  console.log('  Costs are apportioned by token share within each model — an estimate, not a billed figure.\n');
}
