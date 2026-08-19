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

// ---------------------------------------------------------------------------
// CALLEE_MECHANISM reaches the container.
//
// This list is an allowlist: a variable the code inside the container reads but
// that nobody forwards takes its default silently, with no error and nothing in
// the logs. CALLEE_MECHANISM selects which callee-resolution mechanism the
// reviewer is told it has ('lsp', 'treesitter', 'none'), and it was missing —
// so an arm set on the host was measured as the baseline arm, and the only way
// to notice was to read the telemetry and find zero calls.
// ---------------------------------------------------------------------------
describe('getPrReviewContainerEnv CALLEE_MECHANISM forwarding', () => {
  const saved = process.env['CALLEE_MECHANISM'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CALLEE_MECHANISM'];
    else process.env['CALLEE_MECHANISM'] = saved;
  });

  test('forwards the arm when one is set', () => {
    process.env['CALLEE_MECHANISM'] = 'treesitter';
    expect(getPrReviewContainerEnv()['CALLEE_MECHANISM']).toBe('treesitter');
  });

  test('is present but empty when unset — the container then resolves "none"', () => {
    delete process.env['CALLEE_MECHANISM'];
    const env = getPrReviewContainerEnv();
    expect(env).toHaveProperty('CALLEE_MECHANISM');
    expect(env['CALLEE_MECHANISM']).toBe('');
  });
});
