import { describe, test, expect } from 'bun:test';
import { categorizeCommand, summarizeRuns, diffSummaries, type RunMetrics } from '../../src/cli/pr-review-metrics.ts';

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
