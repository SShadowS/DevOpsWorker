import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeReviewValue } from '../../src/dashboard/stats.ts';
import type { ReviewValueFindingRow, ReviewValueSpendInput, ReviewValueStats } from '../../src/dashboard/stats.ts';
import {
  describeAddressed,
  describeJudgedCoverage,
  buildDidRows,
  describeSilentlyFixed,
  describeEngagement,
  describeDisputed,
  describeSpend,
  describeLeadTime,
  buildReviewValuePanelView,
} from '../../src/dashboard/client/components/stats-review-value.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';

// No test in this file may open a database connection (repo convention — see
// tests/dashboard/stats.test.ts: DATABASE_URL points at the live production
// database). `computeReviewValue` is pure by construction: it takes rows, not
// a `sql` handle, which is the property the last test block below pins.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(overrides: Partial<ReviewValueFindingRow> = {}): ReviewValueFindingRow {
  return { did: null, didConfidence: null, said: null, saidEvidence: 'none', leadTimeMins: 60, ...overrides };
}

function spend(overrides: Partial<ReviewValueSpendInput> = {}): ReviewValueSpendInput {
  return { totalCostUsd: 100, reviewCount: 10, reviewsMissingCost: 0, ...overrides };
}

/**
 * The shape of a real window, scaled down and made up: 20 raised, 8 judged,
 * 4 ADDRESSED. Chosen so the two denominators give VISIBLY different answers
 * (4/8 = 50% of judged, 4/20 = 20% of raised) — the exact confusion the card
 * exists to prevent. Not a copy of any measured production window.
 */
function mixedWindow(): ReviewValueFindingRow[] {
  return [
    // judged + ADDRESSED, with a written reply
    finding({ did: 'ADDRESSED', didConfidence: 'unanimous', saidEvidence: 'thread-reply', leadTimeMins: 30 }),
    finding({ did: 'ADDRESSED', didConfidence: 'unanimous', saidEvidence: 'pr-discussion', leadTimeMins: 90 }),
    finding({ did: 'ADDRESSED', didConfidence: 'majority', saidEvidence: 'thread-reply', leadTimeMins: 150 }),
    // judged + ADDRESSED, nobody said anything -> silently fixed
    finding({ did: 'ADDRESSED', didConfidence: 'unanimous', saidEvidence: 'none', leadTimeMins: 210 }),
    // judged, not addressed
    finding({ did: 'not', didConfidence: 'unanimous', saidEvidence: 'thread-reply' }),
    finding({ did: 'not', didConfidence: 'unanimous', saidEvidence: 'none' }),
    // judged, classifier could not tell
    finding({ did: 'UNKNOWN', didConfidence: 'unanimous', saidEvidence: 'pr-discussion' }),
    // judged, ballots did not reach a majority
    finding({ did: 'SPLIT', didConfidence: 'split', saidEvidence: 'none' }),
    // 12 unjudged rows: no diff to judge against yet
    ...Array.from({ length: 9 }, () => finding({ did: null, saidEvidence: 'none' })),
    ...Array.from({ length: 3 }, () => finding({ did: null, saidEvidence: 'thread-reply' })),
  ];
}

// ---------------------------------------------------------------------------
// The judged-vs-total denominator distinction — the whole point of the card
// ---------------------------------------------------------------------------

describe('computeReviewValue — judged vs total denominators', () => {
  test('reports both rates, over denominators that differ', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.findingsRaised).toBe(20);
    expect(o.judged).toBe(8);
    expect(o.unjudgeable).toBe(12);
    expect(o.addressed).toBe(4);
    // 4/8, not 4/20 — the rate that leads the card.
    expect(o.addressedRateOfJudged).toBeCloseTo(0.5, 10);
    // 4/20 — equally true, and a different number.
    expect(o.addressedRateOfRaised).toBeCloseTo(0.2, 10);
    expect(o.addressedRateOfJudged).not.toBe(o.addressedRateOfRaised);
  });

  test('judged coverage is judged/raised, not addressed/raised', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.judgedCoverage).toBeCloseTo(8 / 20, 10);
  });

  test("`did = 'UNKNOWN'` counts as JUDGED, not as unjudgeable — the classifier looked and could not tell", () => {
    const o = computeReviewValue(
      [finding({ did: 'UNKNOWN', didConfidence: 'unanimous' }), finding({ did: null })],
      spend(),
    );
    expect(o.judged).toBe(1);
    expect(o.unjudgeable).toBe(1);
    expect(o.didBreakdown['UNKNOWN']).toBe(1);
  });

  test('unjudgeable rows are counted in NO verdict bucket', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    const verdictTotal = Object.values(o.didBreakdown).reduce((s, n) => s + n, 0);
    expect(verdictTotal).toBe(o.judged);
    expect(verdictTotal).not.toBe(o.findingsRaised);
  });

  test('`SPLIT` keeps its row at zero — an absent row would read as "ballots always agree"', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED', didConfidence: 'unanimous' })], spend());
    expect(o.didBreakdown).toHaveProperty('SPLIT');
    expect(o.didBreakdown['SPLIT']).toBe(0);
    expect(Object.keys(o.didBreakdown)).toEqual(['ADDRESSED', 'not', 'UNKNOWN', 'SPLIT']);
  });

  test('an unrecognised `did` label is surfaced, not silently dropped', () => {
    const o = computeReviewValue([finding({ did: 'SOMETHING-NEW' })], spend());
    expect(o.judged).toBe(1);
    expect(o.didBreakdown['SOMETHING-NEW']).toBe(1);
  });

  test('counts unanimous ballots among judged rows only', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    // 6 of the 8 judged rows are unanimous (one majority, one split); the 12
    // unjudged rows carry no confidence at all and must not dilute the count.
    expect(o.unanimous).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Zero judged rows — no division by zero, and no fake 0%
// ---------------------------------------------------------------------------

describe('computeReviewValue — zero judged rows', () => {
  const noneJudged = Array.from({ length: 7 }, () => finding({ did: null }));

  test('every rate over `judged` is null, never NaN and never 0', () => {
    const o = computeReviewValue(noneJudged, spend());
    expect(o.judged).toBe(0);
    expect(o.addressed).toBe(0);
    expect(o.addressedRateOfJudged).toBeNull();
    expect(Number.isNaN(o.addressedRateOfJudged as unknown as number)).toBe(false);
  });

  test('the rate over RAISED is still a real 0 — that denominator is not empty', () => {
    const o = computeReviewValue(noneJudged, spend());
    expect(o.addressedRateOfRaised).toBe(0);
    expect(o.judgedCoverage).toBe(0);
  });

  test('cost per acted-on is null rather than a division by zero', () => {
    const o = computeReviewValue(noneJudged, spend({ totalCostUsd: 250 }));
    expect(o.spend.costPerAddressed).toBeNull();
    expect(o.spend.totalCostUsd).toBe(250);
  });

  test('an entirely empty window yields nulls, not NaN, everywhere a denominator is empty', () => {
    const o = computeReviewValue([], spend({ totalCostUsd: 0, reviewCount: 0 }));
    expect(o.findingsRaised).toBe(0);
    expect(o.judgedCoverage).toBeNull();
    expect(o.addressedRateOfJudged).toBeNull();
    expect(o.addressedRateOfRaised).toBeNull();
    expect(o.engagement.engagedRate).toBeNull();
    expect(o.leadTime.medianMinsBeforeSettle).toBeNull();
    expect(o.spend.costPerAddressed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// All rows unjudgeable — the live shape of a freshly-swept window
// ---------------------------------------------------------------------------

describe('computeReviewValue — every row unjudgeable', () => {
  const rows = [
    finding({ did: null, saidEvidence: 'thread-reply' }),
    finding({ did: null, saidEvidence: 'none' }),
    finding({ did: null, saidEvidence: 'pr-discussion' }),
  ];

  test('raised is exact even when nothing is judged', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.findingsRaised).toBe(3);
    expect(o.unjudgeable).toBe(3);
    expect(o.judgedCoverage).toBe(0);
  });

  test('engagement is still fully measurable — it does not depend on `did`', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.engagement.engaged).toBe(2);
    expect(o.engagement.silent).toBe(1);
    expect(o.engagement.engagedRate).toBeCloseTo(2 / 3, 10);
  });

  test('silently fixed is 0 because nothing is confirmed fixed — not because nobody was silent', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.silentlyFixed).toBe(0);
    expect(o.engagement.silent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Silently fixed
// ---------------------------------------------------------------------------

describe('computeReviewValue — silently fixed', () => {
  test("counts ADDRESSED with said_evidence 'none' only", () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.silentlyFixed).toBe(1);
    expect(o.addressed).toBe(4);
  });

  test('does not read the `said` column — it is measurable while `said` is null everywhere', () => {
    const rows = [finding({ did: 'ADDRESSED', saidEvidence: 'none', said: null })];
    const o = computeReviewValue(rows, spend());
    expect(o.silentlyFixed).toBe(1);
    expect(o.disputedAsWrong.measured).toBe(false);
  });

  test('an ADDRESSED finding that drew a reply is NOT silently fixed', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED', saidEvidence: 'thread-reply' })], spend());
    expect(o.silentlyFixed).toBe(0);
  });

  test('a silent finding that was NOT addressed is not silently fixed', () => {
    const o = computeReviewValue([finding({ did: 'not', saidEvidence: 'none' })], spend());
    expect(o.silentlyFixed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

describe('computeReviewValue — engagement', () => {
  test('thread-reply and pr-discussion both count as engaged; none does not', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    // 3 addressed-with-reply + 1 not-with-reply + 1 UNKNOWN-with-discussion + 3 unjudged-with-reply
    expect(o.engagement.engaged).toBe(8);
    expect(o.engagement.silent).toBe(12);
    expect(o.engagement.engagedRate).toBeCloseTo(8 / 20, 10);
  });

  test("an evidence kind that is neither engagement nor silence lands in `unrecorded`, not in `silent`", () => {
    const rows = [
      finding({ saidEvidence: 'stale-signal' }),
      finding({ saidEvidence: null }),
      finding({ saidEvidence: 'none' }),
      finding({ saidEvidence: 'thread-reply' }),
    ];
    const o = computeReviewValue(rows, spend());
    expect(o.engagement.engaged).toBe(1);
    expect(o.engagement.silent).toBe(1);
    expect(o.engagement.unrecorded).toBe(2);
    // Rate is over the two classified buckets only, never over all 4 rows.
    expect(o.engagement.engagedRate).toBeCloseTo(0.5, 10);
  });

  test('the raw breakdown keeps every value verbatim, including a null key', () => {
    const rows = [finding({ saidEvidence: 'stale-signal' }), finding({ saidEvidence: null })];
    const o = computeReviewValue(rows, spend());
    expect(o.engagement.breakdown['stale-signal']).toBe(1);
    expect(o.engagement.breakdown['(unrecorded)']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Disputed as factually wrong — not measured is not zero
// ---------------------------------------------------------------------------

describe('computeReviewValue — disputed as factually wrong', () => {
  test('reports NOT MEASURED with a null count while no row carries a `said` label', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.disputedAsWrong.measured).toBe(false);
    expect(o.disputedAsWrong.count).toBeNull();
    expect(o.disputedAsWrong.count).not.toBe(0);
    expect(o.disputedAsWrong.saidRecorded).toBe(0);
    expect(o.disputedAsWrong.reason.length).toBeGreaterThan(0);
  });

  test('starts measuring on its own once `said` is populated — no code change needed', () => {
    const rows = [
      finding({ said: 'rejected-wrong' }),
      finding({ said: 'fixed' }),
      finding({ said: null }),
    ];
    const o = computeReviewValue(rows, spend());
    expect(o.disputedAsWrong.measured).toBe(true);
    expect(o.disputedAsWrong.count).toBe(1);
    expect(o.disputedAsWrong.saidRecorded).toBe(2);
  });

  test('a populated `said` column with no disputes reports a real 0, distinct from not-measured', () => {
    const o = computeReviewValue([finding({ said: 'fixed' })], spend());
    expect(o.disputedAsWrong.measured).toBe(true);
    expect(o.disputedAsWrong.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lead time — negative values segmented out, never averaged in
// ---------------------------------------------------------------------------

describe('computeReviewValue — lead time', () => {
  const rows = [
    finding({ leadTimeMins: 10 }),
    finding({ leadTimeMins: 30 }),
    finding({ leadTimeMins: 50 }),
    finding({ leadTimeMins: -400 }),
    finding({ leadTimeMins: -800 }),
    finding({ leadTimeMins: null }),
  ];

  test('the median covers only findings raised BEFORE the PR settled', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.leadTime.beforeSettleCount).toBe(3);
    expect(o.leadTime.medianMinsBeforeSettle).toBe(30);
  });

  test('negative lead times are counted separately, and pull the median nowhere', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.leadTime.afterSettleCount).toBe(2);
    // A mean over all five recorded values would be negative (-222); the
    // reported figure is unaffected by their presence.
    const withoutNegatives = computeReviewValue(
      rows.filter((r) => r.leadTimeMins == null || r.leadTimeMins >= 0),
      spend(),
    );
    expect(o.leadTime.medianMinsBeforeSettle).toBe(withoutNegatives.leadTime.medianMinsBeforeSettle);
  });

  test('rows with no lead time recorded are counted, not treated as zero', () => {
    const o = computeReviewValue(rows, spend());
    expect(o.leadTime.unrecordedCount).toBe(1);
  });

  test('an even count medians across the middle pair', () => {
    const o = computeReviewValue([finding({ leadTimeMins: 10 }), finding({ leadTimeMins: 20 })], spend());
    expect(o.leadTime.medianMinsBeforeSettle).toBe(15);
  });

  test('a lead time of exactly 0 counts as before-settle, not after', () => {
    const o = computeReviewValue([finding({ leadTimeMins: 0 })], spend());
    expect(o.leadTime.beforeSettleCount).toBe(1);
    expect(o.leadTime.afterSettleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

describe('computeReviewValue — spend', () => {
  test('divides total spend by findings CONFIRMED ACTED ON, not by findings raised', () => {
    const o = computeReviewValue(mixedWindow(), spend({ totalCostUsd: 200 }));
    expect(o.addressed).toBe(4);
    expect(o.spend.costPerAddressed).toBeCloseTo(50, 10);
    // Not 200/20 = 10 (per raised) and not 200/8 = 25 (per judged).
    expect(o.spend.costPerAddressed).not.toBeCloseTo(10, 10);
    expect(o.spend.costPerAddressed).not.toBeCloseTo(25, 10);
  });

  test('passes the spend inputs through untouched, so a missing-cost floor stays visible', () => {
    const o = computeReviewValue(mixedWindow(), spend({ totalCostUsd: 200, reviewCount: 30, reviewsMissingCost: 4 }));
    expect(o.spend.totalCostUsd).toBe(200);
    expect(o.spend.reviewCount).toBe(30);
    expect(o.spend.reviewsMissingCost).toBe(4);
  });

  test("the note names the per-read-band-item figure as NOT comparable, so nothing invites a trend reading", () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.spend.note).toContain('NOT comparable');
    expect(o.spend.note).toContain('not a trend');
  });

  test('the note claims a DIRECTION, never a magnitude — it is rendered verbatim over windows that are fully judged too', () => {
    // Same fixed note on a window where every row is judged. Wording that
    // asserted "the unjudged share is large" would be false right here.
    const fullyJudged = computeReviewValue([finding({ did: 'ADDRESSED' })], spend());
    expect(fullyJudged.judgedCoverage).toBe(1);
    expect(fullyJudged.spend.note).not.toContain('large');
    expect(fullyJudged.spend.note).toContain('can only fall');
  });
});

// ---------------------------------------------------------------------------
// Stated limits reach the payload
// ---------------------------------------------------------------------------

describe('computeReviewValue — stated limits are carried on the payload, not left to the reader', () => {
  test('the reproducibility limit names aggregates as usable and rows as not', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.reproducibilityNote).toContain('33%');
    expect(o.reproducibilityNote).toContain('aggregates');
  });

  test('the scope note says unsettled PRs are excluded rather than counted as ignored', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    expect(o.scopeNote).toContain('SETTLED');
    expect(o.scopeNote.toLowerCase()).toContain('excluded');
  });
});

// ---------------------------------------------------------------------------
// Presentation — the rules that keep a figure from being misread
// ---------------------------------------------------------------------------

describe('describeAddressed', () => {
  test('names BOTH denominators explicitly, so neither rate can pass as the other', () => {
    const line = describeAddressed(computeReviewValue(mixedWindow(), spend()));
    expect(line.value).toBe('4 of 8 judged');
    expect(line.detail).toContain('50.0% of JUDGED');
    expect(line.detail).toContain('(4/8)');
    expect(line.detail).toContain('20.0% of ALL findings raised');
    expect(line.detail).toContain('(4/20)');
  });

  test('with nothing judged it states there is no rate — it does not print 0%', () => {
    const line = describeAddressed(computeReviewValue([finding({ did: null })], spend()));
    expect(line.detail).toContain('no rate to report');
    expect(line.detail).not.toContain('0.0%');
  });
});

describe('describeJudgedCoverage', () => {
  test('states the fraction judged and what the remainder is', () => {
    const text = describeJudgedCoverage(computeReviewValue(mixedWindow(), spend()));
    expect(text).toContain('8/20');
    expect(text).toContain('40.0%');
    expect(text).toContain('12 have no diff to judge against yet');
  });
});

describe('buildDidRows', () => {
  test('shares are over judged rows', () => {
    const rows = buildDidRows(computeReviewValue(mixedWindow(), spend()));
    const addressed = rows.find((r) => r.label === 'ADDRESSED')!;
    expect(addressed.count).toBe(4);
    expect(addressed.rate).toBeCloseTo(0.5, 10);
  });

  test('with nothing judged every share is null, not 0', () => {
    const rows = buildDidRows(computeReviewValue([finding({ did: null })], spend()));
    for (const r of rows) expect(r.rate).toBeNull();
  });
});

describe('describeDisputed', () => {
  test("renders 'not yet measured' with a reason, never a zero", () => {
    const line = describeDisputed(computeReviewValue(mixedWindow(), spend()).disputedAsWrong);
    expect(line.value).toBe('not yet measured');
    expect(line.value).not.toBe('0');
    expect(line.detail.length).toBeGreaterThan(0);
    expect(line.status).toBe('attention');
  });

  test('renders the count as a count once measured, and says it is not a rate', () => {
    const o = computeReviewValue([finding({ said: 'rejected-wrong' })], spend());
    const line = describeDisputed(o.disputedAsWrong);
    expect(line.value).toBe('1');
    expect(line.detail).toContain('never a rate');
  });
});

describe('describeSpend', () => {
  test('carries judged coverage into the caveat beside the per-item figure', () => {
    const o = computeReviewValue(mixedWindow(), spend({ totalCostUsd: 200 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.value).toBe('$50.00 per acted-on');
    expect(line.caveat).toContain('8/20');
    expect(line.caveat).toContain('40.0%');
    // The label names the denominator rather than repeating the section title.
    expect(line.label).toBe('Cost per confirmed acted-on finding');
  });

  test('with nothing acted on it falls back to the total and says why', () => {
    const o = computeReviewValue([finding({ did: null })], spend({ totalCostUsd: 40 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.value).toBe('$40.00');
    expect(line.detail).toContain('no per-item figure');
    expect(line.label).toBe('Total spend this window');
  });
});

describe('describeEngagement / describeSilentlyFixed / describeLeadTime', () => {
  test('engagement states both buckets and the denominator it divided by', () => {
    const o = computeReviewValue(mixedWindow(), spend());
    const line = describeEngagement(o.engagement, o.findingsRaised);
    expect(line.value).toBe('8 of 20');
    expect(line.detail).toContain('20 findings where engagement was recorded');
  });

  test('engagement flags rows in neither bucket rather than absorbing them', () => {
    const o = computeReviewValue([finding({ saidEvidence: 'stale-signal' }), finding({ saidEvidence: 'none' })], spend());
    const line = describeEngagement(o.engagement, o.findingsRaised);
    expect(line.caveat).toContain('1 finding(s) carry no engagement signal');
  });

  test('silently fixed explains that these are invisible to reply-based measures', () => {
    const line = describeSilentlyFixed(computeReviewValue(mixedWindow(), spend()));
    expect(line.value).toBe('1');
    expect(line.detail).toContain('nobody said a word');
  });

  test('lead time segments the after-settle rows out in words, not only in the number', () => {
    const o = computeReviewValue(
      [finding({ leadTimeMins: 30 }), finding({ leadTimeMins: -100 })],
      spend(),
    );
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('Median 30 min');
    expect(text).toContain('AFTER the PR settled');
    expect(text).toContain('excluded from that median');
  });

  test('lead time with nothing before settle reports n/a rather than inventing a median', () => {
    const o = computeReviewValue([finding({ leadTimeMins: -100 })], spend());
    expect(describeLeadTime(o.leadTime)).toContain('Median n/a');
  });
});

// ---------------------------------------------------------------------------
// Panel view — same four-state shape as every other slot
// ---------------------------------------------------------------------------

describe('buildReviewValuePanelView', () => {
  function statsFixture(): ReviewValueStats {
    return {
      window: '30d',
      windowDays: 30,
      since: '2026-07-08T00:00:00.000Z',
      sampleSize: 20,
      lowSample: false,
      population: 'prod',
      otherPopulationCount: 0,
      outcome: computeReviewValue(mixedWindow(), spend()),
    };
  }

  test('loading', () => {
    expect(buildReviewValuePanelView({ status: 'loading' })).toEqual({ status: 'loading', message: 'Loading…', data: null });
  });

  test('error carries the message through', () => {
    const v = buildReviewValuePanelView({ status: 'error', message: '500 Internal Server Error' });
    expect(v.status).toBe('error');
    expect(v.message).toContain('500 Internal Server Error');
  });

  test("empty says no CLASSIFIED FINDINGS, not the generic 'no data' — reviews may still have run", () => {
    const v = buildReviewValuePanelView({ status: 'empty' });
    expect(v.status).toBe('empty');
    expect(v.message).toContain('No classified findings');
    expect(v.message).toContain('settled');
  });

  test('ready passes the payload through', () => {
    const data = statsFixture();
    const v = buildReviewValuePanelView({ status: 'ready', data } as FetchState<ReviewValueStats>);
    expect(v.status).toBe('ready');
    expect(v.data).toBe(data);
    expect(v.message).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Structural guards — source-text assertions, mirroring the SQL-shape block in
// tests/dashboard/stats.test.ts. These pin properties a value assertion cannot
// reach.
// ---------------------------------------------------------------------------

describe('review-value structure', () => {
  const statsSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/stats.ts', import.meta.url)), 'utf-8');
  const viewSrc = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-view.tsx', import.meta.url)),
    'utf-8',
  );

  test('computeReviewValue takes rows, not a `sql` handle — unit-testable without a database', () => {
    const signature = statsSrc.slice(statsSrc.indexOf('export function computeReviewValue'));
    const head = signature.slice(0, signature.indexOf('{'));
    expect(head).not.toContain('postgres.Sql');
    expect(head).toContain('ReviewValueFindingRow[]');
  });

  test('the SQL lives in getReviewValueStats, never inside the pure function', () => {
    const start = statsSrc.indexOf('export function computeReviewValue');
    const end = statsSrc.indexOf('export interface ReviewValueStats');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(statsSrc.slice(start, end)).not.toContain('await sql');
  });

  test('the review-value signal is NOT fed to pickPopulationMeta — its otherPopulationCount counts findings, not reviews', () => {
    const call = viewSrc.slice(viewSrc.indexOf('pickPopulationMeta('), viewSrc.indexOf('pickPopulationMeta(') + 400);
    const invocation = call.slice(call.indexOf('pickPopulationMeta(costStats'));
    expect(invocation.slice(0, invocation.indexOf(')'))).not.toContain('reviewValueStats');
  });
});
