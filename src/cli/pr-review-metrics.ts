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
