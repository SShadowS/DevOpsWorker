import { describe, test, expect } from 'bun:test';
import { categorizeCommand, summarizeRuns, diffSummaries, summarizeSubAgents, isAtOrAfter, type RunMetrics } from '../../src/cli/pr-review-metrics.ts';

describe('categorizeCommand', () => {
  test('classifies MCP-result parsing', () => {
    expect(categorizeCommand('cat /root/.claude/projects/x/tool-results/mcp-azureDevOps-get_pull_request_changes-1.txt | python3 -c "import json"'))
      .toBe('mcp-parse');
  });
  test('classifies plain python3 munging', () => {
    expect(categorizeCommand('python3 -c "print(1)"')).toBe('python');
  });
  test('classifies git', () => {
    expect(categorizeCommand('git diff a...b')).toBe('git');
  });
  test('classifies other', () => {
    expect(categorizeCommand('ls /workspace')).toBe('other');
  });
  test('python takes priority over git (ordering)', () => {
    expect(categorizeCommand('python3 build.py && git commit -m x')).toBe('python');
  });
});

describe('summarizeRuns', () => {
  test('computes medians of tool counts', () => {
    const runs = [
      { toolCalls: { Bash: 10, Read: 4 }, turns: 20, costUsd: 1, durationMs: 1000 },
      { toolCalls: { Bash: 20, Read: 6 }, turns: 30, costUsd: 3, durationMs: 3000 },
      { toolCalls: { Bash: 30, Read: 8 }, turns: 40, costUsd: 2, durationMs: 2000 },
    ];
    const s = summarizeRuns(runs);
    expect(s.medianTool.Bash).toBe(20);
    expect(s.medianTurns).toBe(30);
    expect(s.medianCostUsd).toBe(2);
  });
  test('even number of runs averages the two middle values', () => {
    const runs = [
      { toolCalls: { Bash: 10 }, turns: 10, costUsd: 1, durationMs: 1000 },
      { toolCalls: { Bash: 20 }, turns: 20, costUsd: 2, durationMs: 2000 },
    ];
    const s = summarizeRuns(runs);
    expect(s.medianTool.Bash).toBe(15);
    expect(s.medianTurns).toBe(15);
  });
  test('empty runs yields n=0 and zeroed medians', () => {
    const s = summarizeRuns([]);
    expect(s.n).toBe(0);
    expect(s.medianTurns).toBe(0);
    expect(s.medianTool).toEqual({});
  });
  test('tool present in only some runs is treated as 0 in the others', () => {
    const runs: RunMetrics[] = [
      { toolCalls: { Read: 4 }, turns: 5, costUsd: 1, durationMs: 100 },
      { toolCalls: {}, turns: 5, costUsd: 1, durationMs: 100 },
    ];
    const s = summarizeRuns(runs);
    expect(s.medianTool.Read).toBe(2); // median of [4, 0]
  });
});

describe('diffSummaries', () => {
  test('reports per-tool deltas', () => {
    const before = summarizeRuns([{ toolCalls: { Bash: 20 }, turns: 30, costUsd: 2, durationMs: 2000 }]);
    const after = summarizeRuns([{ toolCalls: { Bash: 5 }, turns: 18, costUsd: 1, durationMs: 1500 }]);
    const d = diffSummaries(before, after);
    expect(d.toolDelta.Bash).toBe(-15);
    expect(d.turnsDelta).toBe(-12);
  });
});

// ---------------------------------------------------------------------------
// summarizeSubAgents — per-named-sub-agent aggregation
// ---------------------------------------------------------------------------

function usage(turns: number, tokens: number, cost: number, toolCalls: Record<string, number> = {}) {
  return {
    turns,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheCreation: 0 },
    toolCalls,
    apportionedCostUsd: cost,
  };
}

describe('summarizeSubAgents', () => {
  test('aggregates and ranks by total apportioned cost', () => {
    const stats = summarizeSubAgents([
      { 'security-reviewer': usage(4, 1000, 1.0, { Read: 3 }), 'style-reviewer': usage(1, 100, 0.1, { Read: 1 }) },
      { 'security-reviewer': usage(6, 3000, 3.0, { Read: 2, Grep: 5 }) },
    ]);

    expect(stats.map(s => s.name)).toEqual(['security-reviewer', 'style-reviewer']);

    const sec = stats[0]!;
    expect(sec.runs).toBe(2);
    expect(sec.totalTurns).toBe(10);
    expect(sec.medianTurns).toBe(5);
    expect(sec.totalTokens).toBe(4000);
    expect(sec.totalCostUsd).toBeCloseTo(4.0, 5);
    expect(sec.medianCostUsd).toBeCloseTo(2.0, 5);
    expect(sec.toolCalls).toEqual({ Read: 5, Grep: 5 });
  });

  test('medians cover only the runs a sub-agent was dispatched in', () => {
    // style-reviewer ran once out of three; its median must be its own value,
    // not diluted toward zero by the runs it sat out.
    const stats = summarizeSubAgents([
      { 'security-reviewer': usage(2, 10, 0.5) },
      { 'security-reviewer': usage(2, 10, 0.5) },
      { 'security-reviewer': usage(2, 10, 0.5), 'style-reviewer': usage(9, 900, 0.2) },
    ]);

    const style = stats.find(s => s.name === 'style-reviewer')!;
    expect(style.runs).toBe(1);
    expect(style.medianTurns).toBe(9);
    expect(style.medianCostUsd).toBeCloseTo(0.2, 5);
  });

  test('ignores runs with no sub-agent data', () => {
    expect(summarizeSubAgents([null, undefined, {}])).toEqual([]);
  });

  test('treats a missing apportioned cost as zero', () => {
    const stats = summarizeSubAgents([
      { 'a': { turns: 1, tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }, toolCalls: {} } },
    ]);
    expect(stats[0]!.totalCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isAtOrAfter
//
// Postgres `created_at::text` uses a SPACE separator and a `+00` offset;
// `toISOString()` uses `T` and `Z`. String-comparing them always answers false
// (' ' 0x20 < 'T' 0x54 at index 10), so a "did my run record?" gate built on
// `>=` reports "no" for every row that exists — which is exactly what aborted a
// benchmark whose row had saved correctly.
// ---------------------------------------------------------------------------

describe('isAtOrAfter', () => {
  const PG = '2026-07-27 09:44:02.345483+00';

  test('a Postgres timestamp after an ISO instant compares true', () => {
    expect(isAtOrAfter(PG, '2026-07-27T09:28:14.123Z')).toBe(true);
  });

  test('the naive string comparison this replaces gets it wrong', () => {
    // Kept as an executable record of the bug.
    expect(PG >= '2026-07-27T09:28:14.123Z').toBe(false);
  });

  test('before the instant is false', () => {
    expect(isAtOrAfter(PG, '2026-07-27T10:00:00.000Z')).toBe(false);
  });

  test('the same instant in the two formats is at-or-after', () => {
    expect(isAtOrAfter('2026-07-27 09:44:02.345483+00', '2026-07-27T09:44:02.345Z')).toBe(true);
  });

  test('respects a non-UTC offset rather than comparing wall-clock text', () => {
    // 12:00+02:00 is 10:00Z — after 09:00Z despite "12" vs "09" reading later.
    expect(isAtOrAfter('2026-07-27 12:00:00+02', '2026-07-27T09:00:00.000Z')).toBe(true);
    expect(isAtOrAfter('2026-07-27 12:00:00+02', '2026-07-27T11:00:00.000Z')).toBe(false);
  });

  test('unparseable input reads as "not found", never as a match', () => {
    expect(isAtOrAfter('not a date', '2026-07-27T09:00:00.000Z')).toBe(false);
    expect(isAtOrAfter(PG, 'nonsense')).toBe(false);
    expect(isAtOrAfter('', '')).toBe(false);
  });
});
