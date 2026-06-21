import { describe, test, expect } from 'bun:test';
import { makeReviewRunId } from '../../src/cli/review-pr.ts';

describe('makeReviewRunId', () => {
  test('includes prId and is unique per call', () => {
    const a = makeReviewRunId(123);
    const b = makeReviewRunId(123);
    expect(a).toContain('123');
    expect(a).not.toBe(b);
  });
});
