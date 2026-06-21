import { describe, test, expect } from 'bun:test';
import { resolveActiveAgent } from '../../src/sdk/run-agent.ts';

describe('resolveActiveAgent', () => {
  const map = new Map<string, string>([['tooluse-1', 'security-edge-case-analyzer']]);

  test('returns sub-agent name when parent id is a known dispatch', () => {
    expect(resolveActiveAgent('tooluse-1', map, 'pr-reviewer')).toBe('security-edge-case-analyzer');
  });
  test('returns default when no parent id', () => {
    expect(resolveActiveAgent(undefined, map, 'pr-reviewer')).toBe('pr-reviewer');
  });
  test('returns default when parent id is unknown', () => {
    expect(resolveActiveAgent('other', map, 'pr-reviewer')).toBe('pr-reviewer');
  });
});
