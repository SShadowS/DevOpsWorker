import { describe, test, expect } from 'bun:test';
import { sortToolCalls } from '../../src/dashboard/client/components/pr-review-detail.tsx';

describe('sortToolCalls', () => {
  test('sorts by count descending', () => {
    expect(sortToolCalls({ Read: 12, Bash: 8, Edit: 3 })).toEqual([['Read', 12], ['Bash', 8], ['Edit', 3]]);
  });
  test('null → empty', () => {
    expect(sortToolCalls(null)).toEqual([]);
  });
});
