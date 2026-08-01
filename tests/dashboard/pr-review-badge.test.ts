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
// properties that matter (which signal drives the class, and the cascade order that
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

  test('the row modifier derives from badgeForReview, not a second isTest check', () => {
    expect(tsx).toContain("badgeForReview(r) ? 'pr-review-row--test' : ''");
    // A second derivation is how the same fact starts disagreeing with itself.
    expect(tsx).not.toContain("r.isTest ? 'pr-review-row--test'");
  });

  test('--error and --pending are declared AFTER --test so the state needing action wins', () => {
    const test = css.indexOf('.pr-review-row--test {');
    const error = css.indexOf('.pr-review-row--error {');
    const pending = css.indexOf('.pr-review-row--pending {');
    expect(test).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(test);
    expect(pending).toBeGreaterThan(test);
  });

  test('the test stripe does not spend --color-accent, which is reserved for attention', () => {
    const rule = css.slice(css.indexOf('.pr-review-row--test {'));
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('--color-accent');
  });

  test('a test run is not dimmed — it is a fact, not a degraded state', () => {
    const rule = css.slice(css.indexOf('.pr-review-row--test {'));
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('opacity');
  });
});
