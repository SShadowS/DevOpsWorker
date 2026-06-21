import { describe, test, expect, afterEach } from 'bun:test';
import { getPrReviewContainerEnv } from '../../src/cli/watch.ts';

describe('getPrReviewContainerEnv PR_REVIEW_NO_POST forwarding', () => {
  const original = process.env['PR_REVIEW_NO_POST'];
  afterEach(() => {
    if (original === undefined) delete process.env['PR_REVIEW_NO_POST'];
    else process.env['PR_REVIEW_NO_POST'] = original;
  });

  test('forwards PR_REVIEW_NO_POST when set', () => {
    process.env['PR_REVIEW_NO_POST'] = '1';
    expect(getPrReviewContainerEnv()['PR_REVIEW_NO_POST']).toBe('1');
  });

  test('omits or empties PR_REVIEW_NO_POST when unset', () => {
    delete process.env['PR_REVIEW_NO_POST'];
    const env = getPrReviewContainerEnv();
    // either absent or empty string (buildDockerArgs drops empty values)
    expect(env['PR_REVIEW_NO_POST'] ?? '').toBe('');
  });
});
