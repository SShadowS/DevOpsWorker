import { describe, test, expect } from 'bun:test';
import { parseArgs, topTools } from '../../src/cli/subagent-stats.ts';

describe('subagent-stats parseArgs', () => {
  test('defaults', () => {
    expect(parseArgs([])).toEqual({ limit: 50, json: false });
  });

  test('parses limit, repo and json', () => {
    expect(parseArgs(['--limit', '10', '--repo', 'Banking', '--json']))
      .toEqual({ limit: 10, repoKey: 'Banking', json: true });
  });

  test('accepts short flags', () => {
    expect(parseArgs(['-n', '5', '-r', 'DO'])).toEqual({ limit: 5, repoKey: 'DO', json: false });
  });

  test('ignores a trailing flag with no value', () => {
    expect(parseArgs(['--limit'])).toEqual({ limit: 50, json: false });
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
