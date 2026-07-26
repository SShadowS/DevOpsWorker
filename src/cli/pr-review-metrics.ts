export type CommandCategory = 'mcp-parse' | 'python' | 'git' | 'other';

/** Classify a single Bash command string by its dominant purpose. */
export function categorizeCommand(cmd: string): CommandCategory {
  if (/tool-results\/mcp-/.test(cmd)) return 'mcp-parse';
  if (/\bpython3?\b/.test(cmd)) return 'python';
  if (/(^|&&|\|\s*|;|\s)git\s/.test(cmd)) return 'git';
  return 'other';
}

export interface RunMetrics {
  toolCalls: Record<string, number>;
  turns: number;
  costUsd: number;
  durationMs: number;
}

export interface RunSummary {
  n: number;
  medianTool: Record<string, number>;
  medianTurns: number;
  medianCostUsd: number;
  medianDurationMs: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarizeRuns(runs: RunMetrics[]): RunSummary {
  const toolNames = new Set<string>();
  for (const r of runs) for (const k of Object.keys(r.toolCalls)) toolNames.add(k);
  const medianTool: Record<string, number> = {};
  for (const name of toolNames) {
    medianTool[name] = median(runs.map(r => r.toolCalls[name] ?? 0));
  }
  return {
    n: runs.length,
    medianTool,
    medianTurns: median(runs.map(r => r.turns)),
    medianCostUsd: median(runs.map(r => r.costUsd)),
    medianDurationMs: median(runs.map(r => r.durationMs)),
  };
}

export interface SummaryDiff {
  toolDelta: Record<string, number>;
  turnsDelta: number;
  costDelta: number;
  durationDelta: number;
}

export function diffSummaries(before: RunSummary, after: RunSummary): SummaryDiff {
  const names = new Set([...Object.keys(before.medianTool), ...Object.keys(after.medianTool)]);
  const toolDelta: Record<string, number> = {};
  for (const name of names) {
    toolDelta[name] = (after.medianTool[name] ?? 0) - (before.medianTool[name] ?? 0);
  }
  return {
    toolDelta,
    turnsDelta: after.medianTurns - before.medianTurns,
    costDelta: after.medianCostUsd - before.medianCostUsd,
    durationDelta: after.medianDurationMs - before.medianDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Per-named-sub-agent aggregation
//
// `toolCalls`/`costUsd` above are run totals: for a reviewer that fans out to
// eight sub-agents they say what the run spent, never which sub-agent spent it.
// These aggregate the per-sub-agent attribution captured in `SubAgentUsage`
// across many runs, so "which reviewer is expensive / slow / silent?" becomes
// answerable.
// ---------------------------------------------------------------------------

export interface SubAgentStat {
  name: string;
  /** Runs in which this sub-agent was dispatched at all. */
  runs: number;
  totalTurns: number;
  medianTurns: number;
  totalTokens: number;
  medianTokens: number;
  /** Sum of the per-run apportioned cost estimates. See `SubAgentUsage`. */
  totalCostUsd: number;
  medianCostUsd: number;
  toolCalls: Record<string, number>;
}

/** Minimal shape needed here — accepts `SubAgentUsage` unchanged. */
export interface SubAgentRunUsage {
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  toolCalls: Record<string, number>;
  apportionedCostUsd?: number;
}

/**
 * Aggregate per-sub-agent usage across runs, sorted by total apportioned cost
 * (descending) so the biggest spender reads first.
 *
 * Sub-agents are counted only in the runs where they were dispatched: a reviewer
 * that runs in 2 of 10 reviews reports `runs: 2` and medians over those 2, not a
 * median diluted by eight zeroes. That keeps "expensive when it runs" distinct
 * from "runs often", which are different problems with different fixes.
 */
export function summarizeSubAgents(
  runs: Array<Record<string, SubAgentRunUsage> | null | undefined>,
): SubAgentStat[] {
  const byName = new Map<string, SubAgentRunUsage[]>();
  for (const run of runs) {
    if (!run) continue;
    for (const [name, usage] of Object.entries(run)) {
      const list = byName.get(name) ?? [];
      list.push(usage);
      byName.set(name, list);
    }
  }

  const stats: SubAgentStat[] = [];
  for (const [name, usages] of byName) {
    const tokensOf = (u: SubAgentRunUsage) =>
      u.tokens.input + u.tokens.output + u.tokens.cacheRead + u.tokens.cacheCreation;
    const costs = usages.map(u => u.apportionedCostUsd ?? 0);
    const toolCalls: Record<string, number> = {};
    for (const u of usages) {
      for (const [tool, n] of Object.entries(u.toolCalls)) {
        toolCalls[tool] = (toolCalls[tool] ?? 0) + n;
      }
    }
    stats.push({
      name,
      runs: usages.length,
      totalTurns: usages.reduce((a, u) => a + u.turns, 0),
      medianTurns: median(usages.map(u => u.turns)),
      totalTokens: usages.reduce((a, u) => a + tokensOf(u), 0),
      medianTokens: median(usages.map(tokensOf)),
      totalCostUsd: costs.reduce((a, c) => a + c, 0),
      medianCostUsd: median(costs),
      toolCalls,
    });
  }

  return stats.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}
