import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// The row's stripe colour is a CSS concern, so these are source-text pins — the
// properties that matter (that a test run claims no stripe, and the cascade order that
// decides which stripe wins) are invisible to a unit test on a pure function.
describe('test-run row stripe', () => {
  const tsx = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/pr-review-list.tsx', import.meta.url)),
    'utf8',
  );
  const css = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
    'utf8',
  );

  test('a test run claims no stripe — the badge carries it, the state keeps the edge', () => {
    // The stripe used to be --color-info, which the shared vocabulary now spends on
    // "in flight", so a finished test run wore the running colour. Both the rule and
    // the class that would have asked for it are gone; either one coming back alone
    // is a dead class or an unreachable rule.
    expect(css).not.toContain('.pr-review-row--test {');
    expect(tsx).not.toContain('pr-review-row--test');
  });

  test('the badge is still the thing that says it, and still derives from badgeForReview', () => {
    expect(tsx).toContain('badgeForReview(r) &&');
    expect(tsx).toContain('pr-review__badge--test');
    // A second derivation is how the same fact starts disagreeing with itself.
    expect(tsx).not.toContain('r.isTest ?');
  });

  test('--error is declared before --pending, so a queued row reads as queued', () => {
    const error = css.indexOf('.pr-review-row--error {');
    const pending = css.indexOf('.pr-review-row--pending {');
    expect(error).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(error);
  });

  test('neither row stripe spends --color-accent, which is reserved for attention', () => {
    for (const selector of ['.pr-review-row--error {', '.pr-review-row--pending {']) {
      const rule = css.slice(css.indexOf(selector));
      expect(rule.slice(0, rule.indexOf('}'))).not.toContain('--color-accent');
    }
  });

  test('a test run is not dimmed — it is a fact, not a degraded state', () => {
    // With no --test rule left, this is the guard that a test run is not quietly
    // faded somewhere else instead.
    expect(css).not.toMatch(/\.pr-review-row--test\b[^{]*\{[^}]*opacity/);
  });
});
