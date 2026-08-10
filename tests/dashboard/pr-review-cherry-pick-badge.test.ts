import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cherryPickSourcePr, routerMissedCherryPick } from '../../src/dashboard/client/components/pr-review-list.tsx';

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

describe('cherry-pick mark', () => {
  const tsx = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/pr-review-list.tsx', import.meta.url)),
    'utf8',
  );
  const bits = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/pr-review-bits.tsx', import.meta.url)),
    'utf8',
  );
  const css = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
    'utf8',
  );

  test('it is a glyph, not a sixth box in a row full of boxes', () => {
    // A row can already carry a verdict badge plus four finding pills. A text badge was
    // reported as impossible to pick out of that queue even after its contrast was fixed,
    // so the mark has to differ in shape, not only in colour.
    expect(bits).toContain('<svg');
    expect(css).toContain('.pr-review-row__cherry-pick {');
    expect(css).not.toContain('.pr-review__badge--cherry-pick');
    expect(tsx).not.toContain('pr-review__badge--cherry-pick');
  });

  test('it sits next to the PR number, ahead of the badges', () => {
    // Position is the point: at the end of the row it lands at a different x on every
    // row, so there is no column to scan down.
    const mark = tsx.indexOf('<CherryPickMark');
    const verdict = tsx.indexOf('<RecommendationBadge');
    const findings = tsx.indexOf('<FindingsPills');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(verdict);
    expect(mark).toBeLessThan(findings);
  });

  test('it inherits the readable blue, not the border-weight one', () => {
    // The glyph is stroked with currentColor, so the rule's `color` is what paints it.
    const rule = css.slice(css.indexOf('.pr-review-row__cherry-pick {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('--color-info-text');
    expect(body).not.toContain('--color-accent');
  });

  test('it names the source PR rather than the column value', () => {
    // Dashboard text rule: someone reading a row cannot see the code that produced it,
    // so "sanity:52051" on screen is a dead end. The tooltip must say what it means.
    expect(bits).toContain('cherry-picked from PR');
    expect(bits).not.toContain('>sanity:');
  });

  test('it has a name for a screen reader, since the glyph says nothing on its own', () => {
    expect(bits).toMatch(/role="img"/);
    // The same sentence the sighted reader gets as a tooltip, so the two never drift.
    expect(bits).toMatch(/aria-label=\{label\}/);
    expect(bits).toContain('cherry-picked from PR #${sourcePr}');
  });

  test('a port the pre-flight check missed is marked differently from one it caught', () => {
    // Both are ports, but only one of them is a problem: the missed one was read in
    // full at full price, and the mark is the only place that shows up.
    expect(bits).toContain('pr-review-row__cherry-pick--missed');
    expect(css).toContain('.pr-review-row__cherry-pick--missed {');
    const rule = css.slice(css.indexOf('.pr-review-row__cherry-pick--missed {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('--color-accent');
  });

  test('the row keeps ONE stripe: cherry-pick is a mark, not another border colour', () => {
    // Which route a review took is a label, not a state, and the row's one edge belongs
    // to its state — the same reason a test run has no stripe either. See the stripe
    // vocabulary at the top of dashboard.css.
    expect(css).not.toContain('.pr-review-row--cherry-pick');
    expect(tsx).not.toContain('pr-review-row--cherry-pick');
  });
});

// The disagreement between the two signals is the point of the second one, so it gets
// its own tests. `observedCherryPick` is what the reviewer concluded while reading;
// `reviewPath` is what the router decided before spending. Only the router can save
// money, so the reviewer's answer is worth exactly one thing: catching the router out.
describe('routerMissedCherryPick', () => {
  test('the reviewer said port, the router said full — that is a miss', () => {
    expect(routerMissedCherryPick({ observedCherryPick: true, reviewPath: 'full:not a cherry-pick' })).toBe(true);
  });

  test('both agreed it is a port — no miss, the cheap path ran', () => {
    expect(routerMissedCherryPick({ observedCherryPick: true, reviewPath: 'sanity:52839' })).toBe(false);
  });

  test('the reviewer said nothing — not a miss, and not a denial either', () => {
    // Null is "we never found out": the row predates the field, or the review failed.
    expect(routerMissedCherryPick({ observedCherryPick: null, reviewPath: 'full:not a cherry-pick' })).toBe(false);
    expect(routerMissedCherryPick({ reviewPath: 'full:not a cherry-pick' })).toBe(false);
  });

  test('the reviewer said it is not a port', () => {
    expect(routerMissedCherryPick({ observedCherryPick: false, reviewPath: 'full:not a cherry-pick' })).toBe(false);
  });

  test('a queued row has no path yet, so nothing can be missed', () => {
    expect(routerMissedCherryPick({ observedCherryPick: true, reviewPath: null })).toBe(false);
  });
});

// The router writes several `full:` reasons AFTER it has already recognised the port.
// Those rows are not blind spots, and marking them as such would call the designed
// "ask for a deeper look" workflow a defect. Each string below is one the router
// really writes (see chooseReviewPath in src/sdk/ado/backport.ts).
describe('routerMissedCherryPick — the other full: reasons are not misses', () => {
  for (const reason of [
    'full:forced by caller (--full or /review-full)',
    'full:cherry-pick detected but no source PR id in the trailer',
    'full:source PR !52117 not found in this repository',
    'full:source PR !52117 diff could not be computed: fatal: bad object',
    'full:PR source branch unknown — cannot check out the merge preview',
  ]) {
    test(`"${reason}" is the router knowing, not missing`, () => {
      expect(routerMissedCherryPick({ observedCherryPick: true, reviewPath: reason })).toBe(false);
    });
  }
});
