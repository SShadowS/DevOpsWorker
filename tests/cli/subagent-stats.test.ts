import { describe, test, expect } from 'bun:test';
import { parseArgs, topTools, dispatchRunsFromTelemetry } from '../../src/cli/subagent-stats.ts';

describe('subagent-stats parseArgs', () => {
  test('defaults', () => {
    expect(parseArgs([])).toEqual({ limit: 50, source: 'all', json: false });
  });

  test('parses limit, repo and json', () => {
    expect(parseArgs(['--limit', '10', '--repo', 'Banking', '--json']))
      .toEqual({ limit: 10, repoKey: 'Banking', source: 'all', json: true });
  });

  test('accepts short flags', () => {
    expect(parseArgs(['-n', '5', '-r', 'DO'])).toEqual({ limit: 5, repoKey: 'DO', source: 'all', json: false });
  });

  test('ignores a trailing flag with no value', () => {
    expect(parseArgs(['--limit'])).toEqual({ limit: 50, source: 'all', json: false });
  });
});

describe('topTools', () => {
  test('ranks by call count and truncates', () => {
    expect(topTools({ Read: 3, Grep: 9, LSP: 1, Bash: 5 })).toBe('Grep×9, Bash×5, Read×3');
  });

  test('empty map renders as empty string', () => {
    expect(topTools({})).toBe('');
  });
});

describe('subagent-stats source flag', () => {
  test('defaults to scanning both sources', () => {
    expect(parseArgs([]).source).toBe('all');
  });

  test('honours --source pipeline', () => {
    expect(parseArgs(['--source', 'pipeline']).source).toBe('pipeline');
  });
});

describe('dispatchRunsFromTelemetry', () => {
  test('keeps only stages that dispatched sub-agents, labelled by work item and stage', () => {
    const runs = dispatchRunsFromTelemetry(63396, [
      { name: 'analysis', costUsd: 0.4 },
      {
        name: 'coding',
        costUsd: 12.5,
        subAgents: {
          'security-reviewer': { turns: 3, tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, toolCalls: {}, apportionedCostUsd: 1 },
        },
      },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.origin).toBe('wi 63396/coding');
    expect(runs[0]!.costUsd).toBe(12.5);
    expect(Object.keys(runs[0]!.subAgents)).toEqual(['security-reviewer']);
  });

  test('an empty subAgents map is not a dispatching run', () => {
    expect(dispatchRunsFromTelemetry(1, [{ name: 'coding', costUsd: 1, subAgents: {} }])).toEqual([]);
  });
});
