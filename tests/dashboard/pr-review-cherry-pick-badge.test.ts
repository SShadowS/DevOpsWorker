import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cherryPickSourcePr } from '../../src/dashboard/client/components/pr-review-list.tsx';

// Same rules as pr-review-badge.test.ts: no database connection, no component tree.
// `cherryPickSourcePr` is pure — given a review-shaped object it returns a number or null.
//
// The value it reads is written by review-pr.ts as `review_path`, and only two shapes
// reach it: `sanity:<source pr id>` when the review took the cherry-pick path, and
// `full:<reason>` when it did not.

describe('cherryPickSourcePr', () => {
  test('a cherry-pick review reports the PR it was picked from', () => {
    expect(cherryPickSourcePr({ reviewPath: 'sanity:52051' })).toBe(52051);
  });

  test('the +merge-commit suffix does not hide the source PR', () => {
    // Real value from the table: 'sanity:52117+merge-commit'. Parsing that as one
    // number would give NaN and silently drop the badge on those rows.
    expect(cherryPickSourcePr({ reviewPath: 'sanity:52117+merge-commit' })).toBe(52117);
  });

  test('a full review is not a cherry-pick', () => {
    expect(cherryPickSourcePr({ reviewPath: 'full:not a cherry-pick' })).toBe(null);
  });

  test('a full review that mentions cherry-picking is still not one', () => {
    // 'full:cherry-pick detected but no source PR id in the trailer' is a real value:
    // the commit looked like a cherry-pick but the review fell back to a full read.
    // Matching on the word "cherry-pick" instead of the `sanity:` prefix would badge it.
    expect(cherryPickSourcePr({ reviewPath: 'full:cherry-pick detected but no source PR id in the trailer' })).toBe(null);
  });

  test('a row from before review_path existed is not badged', () => {
    // 1486 rows predate the column. Absence means "unknown", and the badge must not
    // claim otherwise in either direction.
    expect(cherryPickSourcePr({ reviewPath: null })).toBe(null);
    expect(cherryPickSourcePr({})).toBe(null);
  });

  test('a sanity path with no usable id is not badged', () => {
    expect(cherryPickSourcePr({ reviewPath: 'sanity:' })).toBe(null);
    expect(cherryPickSourcePr({ reviewPath: 'sanity:unknown' })).toBe(null);
  });
});

describe('DashboardPRReview DTO carries reviewPath to the client', () => {
  // Same trap pr-review-dto-isTest.test.ts was written for: the store already maps
  // `reviewPath`, so a badge can pass every unit test above while the field never
  // reaches the browser. These pin the three sites that have to agree.
  const typesSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/types.ts', import.meta.url)), 'utf-8');
  const stateReaderSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/state-reader.ts', import.meta.url)), 'utf-8');

  test('DashboardPRReview declares reviewPath', () => {
    const iface = typesSrc.match(/export interface DashboardPRReview \{[\s\S]*?\n\}/);
    expect(iface).not.toBeNull();
    expect(iface![0]).toContain('reviewPath: string | null');
  });

  test('readPRReviews sets reviewPath on completed rows', () => {
    const fn = stateReaderSrc.match(/export async function readPRReviews[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('reviewPath: r.reviewPath');
  });

  test('readPRReviews sets reviewPath on pending/in-progress rows', () => {
    // A queued review has no DB row yet, so it has no path — null, not undefined,
    // so the field is present on every object the list renders.
    const fn = stateReaderSrc.match(/export async function readPRReviews[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('reviewPath: null');
  });

  test('readPRReviewDetail sets reviewPath', () => {
    const fn = stateReaderSrc.match(/export async function readPRReviewDetail[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('reviewPath: r.reviewPath');
  });
});

describe('cherry-pick badge', () => {
  const tsx = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/pr-review-list.tsx', import.meta.url)),
    'utf8',
  );
  const css = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
    'utf8',
  );

  test('the badge has its own colour rule', () => {
    expect(css).toContain('.pr-review__badge--cherry-pick {');
  });

  test('the badge does not spend --color-accent, which is reserved for attention', () => {
    const rule = css.slice(css.indexOf('.pr-review__badge--cherry-pick {'));
    expect(rule.slice(0, rule.indexOf('}'))).not.toContain('--color-accent');
  });

  test('the badge names the source PR rather than the column value', () => {
    // Dashboard text rule: someone reading a card cannot see the code that produced
    // it, so "sanity:52051" on screen is a dead end. The tooltip must say what it means.
    expect(tsx).toContain('cherry-picked from PR');
    expect(tsx).not.toContain('>sanity:');
  });

  test('the row keeps ONE stripe: cherry-pick is a badge, not another border colour', () => {
    // Which route a review took is a label, not a state, and the row's one edge belongs
    // to its state — the same reason a test run has no stripe either. See the stripe
    // vocabulary at the top of dashboard.css.
    expect(css).not.toContain('.pr-review-row--cherry-pick');
    expect(tsx).not.toContain('pr-review-row--cherry-pick');
  });
});
