import { describe, test, expect } from 'bun:test';
import { badgeForReview } from '../../src/dashboard/client/components/pr-review-list.tsx';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/tool-breakdown.test.ts).
// `badgeForReview` is pure: given a review-shaped object, it returns a value.

describe('badgeForReview', () => {
  test('a test run is badged', () => {
    expect(badgeForReview({ isTest: true })).toBe('test');
  });

  test('a production run is not badged', () => {
    expect(badgeForReview({ isTest: false })).toBe(null);
  });

  test('a legacy row missing the field is treated as production', () => {
    expect(badgeForReview({})).toBe(null);
  });
});
