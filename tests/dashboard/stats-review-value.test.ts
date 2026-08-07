import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeReviewValue } from '../../src/dashboard/stats.ts';
import type { ReviewValueFindingRow, ReviewValueSpendInput, ReviewValueRaisedInput, ReviewValueStats } from '../../src/dashboard/stats.ts';
import {
  describeAddressed,
  describeJudgedCoverage,
  buildDidRows,
  describeSilentlyFixed,
  describeEngagement,
  describeDisputed,
  describeSpend,
  describeLeadTime,
  describeVerdictCaption,
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
 * Calls `computeReviewValue` with a `raised` input that defaults to "every
 * raised finding was traceable" — the no-gap case most tests here are about.
 * Tests that care about the gap pass `raisedInput` explicitly, or call
 * `computeReviewValue` directly.
 */
function compute(
  findings: ReviewValueFindingRow[],
  spendInput: ReviewValueSpendInput = spend(),
  raisedInput?: ReviewValueRaisedInput,
) {
  return computeReviewValue(findings, spendInput, raisedInput ?? { readBandRaised: findings.length, noFileAnchor: 0 });
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
    const o = compute(mixedWindow(), spend());
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
    const o = compute(mixedWindow(), spend());
    expect(o.judgedCoverage).toBeCloseTo(8 / 20, 10);
  });

  test("`did = 'UNKNOWN'` counts as JUDGED, not as unjudgeable — the classifier looked and could not tell", () => {
    const o = compute(
      [finding({ did: 'UNKNOWN', didConfidence: 'unanimous' }), finding({ did: null })],
      spend(),
    );
    expect(o.judged).toBe(1);
    expect(o.unjudgeable).toBe(1);
    expect(o.didBreakdown['UNKNOWN']).toBe(1);
  });

  test('unjudgeable rows are counted in NO verdict bucket', () => {
    const o = compute(mixedWindow(), spend());
    const verdictTotal = Object.values(o.didBreakdown).reduce((s, n) => s + n, 0);
    expect(verdictTotal).toBe(o.judged);
    expect(verdictTotal).not.toBe(o.findingsRaised);
  });

  test('`SPLIT` keeps its row at zero — an absent row would read as "ballots always agree"', () => {
    const o = compute([finding({ did: 'ADDRESSED', didConfidence: 'unanimous' })], spend());
    expect(o.didBreakdown).toHaveProperty('SPLIT');
    expect(o.didBreakdown['SPLIT']).toBe(0);
    expect(Object.keys(o.didBreakdown)).toEqual(['ADDRESSED', 'not', 'UNKNOWN', 'SPLIT']);
  });

  test('an unrecognised `did` label is surfaced, not silently dropped', () => {
    const o = compute([finding({ did: 'SOMETHING-NEW' })], spend());
    expect(o.judged).toBe(1);
    expect(o.didBreakdown['SOMETHING-NEW']).toBe(1);
  });

  test('counts unanimous ballots among judged rows only', () => {
    const o = compute(mixedWindow(), spend());
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
    const o = compute(noneJudged, spend());
    expect(o.judged).toBe(0);
    expect(o.addressed).toBe(0);
    expect(o.addressedRateOfJudged).toBeNull();
    expect(Number.isNaN(o.addressedRateOfJudged as unknown as number)).toBe(false);
  });

  test('the rate over RAISED is still a real 0 — that denominator is not empty', () => {
    const o = compute(noneJudged, spend());
    expect(o.addressedRateOfRaised).toBe(0);
    expect(o.judgedCoverage).toBe(0);
  });

  test('cost per acted-on is null rather than a division by zero', () => {
    const o = compute(noneJudged, spend({ totalCostUsd: 250 }));
    expect(o.spend.costPerAddressed).toBeNull();
    expect(o.spend.totalCostUsd).toBe(250);
  });

  test('an entirely empty window yields nulls, not NaN, everywhere a denominator is empty', () => {
    const o = compute([], spend({ totalCostUsd: 0, reviewCount: 0 }));
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
    const o = compute(rows, spend());
    expect(o.findingsRaised).toBe(3);
    expect(o.unjudgeable).toBe(3);
    expect(o.judgedCoverage).toBe(0);
  });

  test('engagement is still fully measurable — it does not depend on `did`', () => {
    const o = compute(rows, spend());
    expect(o.engagement.engaged).toBe(2);
    expect(o.engagement.silent).toBe(1);
    expect(o.engagement.engagedRate).toBeCloseTo(2 / 3, 10);
  });

  test('silently fixed is 0 because nothing is confirmed fixed — not because nobody was silent', () => {
    const o = compute(rows, spend());
    expect(o.silentlyFixed).toBe(0);
    expect(o.engagement.silent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Silently fixed
// ---------------------------------------------------------------------------

describe('computeReviewValue — silently fixed', () => {
  test("counts ADDRESSED with said_evidence 'none' only", () => {
    const o = compute(mixedWindow(), spend());
    expect(o.silentlyFixed).toBe(1);
    expect(o.addressed).toBe(4);
  });

  test('does not read the `said` column — it is measurable while `said` is null everywhere', () => {
    const rows = [finding({ did: 'ADDRESSED', saidEvidence: 'none', said: null })];
    const o = compute(rows, spend());
    expect(o.silentlyFixed).toBe(1);
    expect(o.disputedAsWrong.measured).toBe(false);
  });

  test('an ADDRESSED finding that drew a reply is NOT silently fixed', () => {
    const o = compute([finding({ did: 'ADDRESSED', saidEvidence: 'thread-reply' })], spend());
    expect(o.silentlyFixed).toBe(0);
  });

  test('a silent finding that was NOT addressed is not silently fixed', () => {
    const o = compute([finding({ did: 'not', saidEvidence: 'none' })], spend());
    expect(o.silentlyFixed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

describe('computeReviewValue — engagement', () => {
  test('thread-reply and pr-discussion both count as engaged; none does not', () => {
    const o = compute(mixedWindow(), spend());
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
    const o = compute(rows, spend());
    expect(o.engagement.engaged).toBe(1);
    expect(o.engagement.silent).toBe(1);
    expect(o.engagement.unrecorded).toBe(2);
    // Rate is over the two classified buckets only, never over all 4 rows.
    expect(o.engagement.engagedRate).toBeCloseTo(0.5, 10);
  });

  test('the raw breakdown keeps every value verbatim, including a null key', () => {
    const rows = [finding({ saidEvidence: 'stale-signal' }), finding({ saidEvidence: null })];
    const o = compute(rows, spend());
    expect(o.engagement.breakdown['stale-signal']).toBe(1);
    expect(o.engagement.breakdown['(unrecorded)']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Disputed as factually wrong — not measured is not zero
// ---------------------------------------------------------------------------

describe('computeReviewValue — disputed as factually wrong', () => {
  test('reports NOT MEASURED with a null count while no row carries a `said` label', () => {
    const o = compute(mixedWindow(), spend());
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
    const o = compute(rows, spend());
    expect(o.disputedAsWrong.measured).toBe(true);
    expect(o.disputedAsWrong.count).toBe(1);
    expect(o.disputedAsWrong.saidRecorded).toBe(2);
  });

  test('a populated `said` column with no disputes reports a real 0, distinct from not-measured', () => {
    const o = compute([finding({ said: 'fixed' })], spend());
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
    const o = compute(rows, spend());
    expect(o.leadTime.beforeSettleCount).toBe(3);
    expect(o.leadTime.medianMinsBeforeSettle).toBe(30);
  });

  test('negative lead times are counted separately, and pull the median nowhere', () => {
    const o = compute(rows, spend());
    expect(o.leadTime.afterSettleCount).toBe(2);
    // A mean over all five recorded values would be negative (-222); the
    // reported figure is unaffected by their presence.
    const withoutNegatives = compute(
      rows.filter((r) => r.leadTimeMins == null || r.leadTimeMins >= 0),
      spend(),
    );
    expect(o.leadTime.medianMinsBeforeSettle).toBe(withoutNegatives.leadTime.medianMinsBeforeSettle);
  });

  test('rows with no lead time recorded are counted, not treated as zero', () => {
    const o = compute(rows, spend());
    expect(o.leadTime.unrecordedCount).toBe(1);
  });

  test('an even count medians across the middle pair', () => {
    const o = compute([finding({ leadTimeMins: 10 }), finding({ leadTimeMins: 20 })], spend());
    expect(o.leadTime.medianMinsBeforeSettle).toBe(15);
  });

  test('a lead time of exactly 0 counts as before-settle, not after', () => {
    const o = compute([finding({ leadTimeMins: 0 })], spend());
    expect(o.leadTime.beforeSettleCount).toBe(1);
    expect(o.leadTime.afterSettleCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

describe('computeReviewValue — spend', () => {
  test('divides total spend by findings CONFIRMED ACTED ON, not by findings raised', () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200 }));
    expect(o.addressed).toBe(4);
    expect(o.spend.costPerAddressed).toBeCloseTo(50, 10);
    // Not 200/20 = 10 (per raised) and not 200/8 = 25 (per judged).
    expect(o.spend.costPerAddressed).not.toBeCloseTo(10, 10);
    expect(o.spend.costPerAddressed).not.toBeCloseTo(25, 10);
  });

  test('passes the spend inputs through untouched, so a missing-cost floor stays visible', () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200, reviewCount: 30, reviewsMissingCost: 4 }));
    expect(o.spend.totalCostUsd).toBe(200);
    expect(o.spend.reviewCount).toBe(30);
    expect(o.spend.reviewsMissingCost).toBe(4);
  });

  test("the note names the per-read-band-item figure as NOT comparable, so nothing invites a trend reading", () => {
    const o = compute(mixedWindow(), spend());
    expect(o.spend.note).toContain('NOT comparable');
    expect(o.spend.note).toContain('not a trend');
  });

  // -------------------------------------------------------------------------
  // The note is DERIVED from two state flags, and the flags are what these
  // assert. An earlier version of this block constructed a fully-judged
  // fixture and then asserted `toContain('can only fall')` — pinning as
  // required behaviour a growth claim that is false at full coverage. It also
  // banned only the literal word 'large', which "the unjudged share dominates"
  // would have walked straight past. Asserting the STATE, and asserting the
  // absence of growth claims as a property over a phrase set, fixes both.
  // -------------------------------------------------------------------------

  /** Every way the note could claim the denominator still has room to move. */
  const GROWTH_CLAIMS = ['not settled', 'grows as', 'can only FALL', 'can only fall', 'upper bound at the current coverage'];

  test('at PARTIAL coverage the denominator is `will-grow` and the note says the figure can only fall', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.judgedCoverage).toBeLessThan(1);
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.note).toContain('can only FALL');
  });

  test('at FULL coverage the denominator is `settled` and the note makes NO growth claim at all', () => {
    const o = compute([finding({ did: 'ADDRESSED' })], spend());
    expect(o.judgedCoverage).toBe(1);
    expect(o.spend.denominatorState).toBe('settled');
    // The property, not a substring: nothing in the note may suggest the
    // denominator still has room to move.
    for (const claim of GROWTH_CLAIMS) expect(o.spend.note).not.toContain(claim);
    expect(o.spend.note).toContain('will not move');
  });

  test('full coverage requires nothing UNTRACEABLE either — a judged row count is not enough', () => {
    // Every traced row judged, but one raised finding has no thread. That
    // finding can never enter the denominator, so the figure is not settled.
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 1 });
    expect(o.judged).toBe(1);
    expect(o.findingsRaised).toBe(2);
    expect(o.spend.denominatorState).toBe('will-grow');
  });
});

// ---------------------------------------------------------------------------
// The numerator's exactness claim must match the data (review finding 1)
// ---------------------------------------------------------------------------

describe('computeReviewValue — numerator exactness', () => {
  test('claims exactness only when every review carries a cost', () => {
    const o = compute(mixedWindow(), spend({ reviewsMissingCost: 0 }));
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.note).toContain('The numerator is exact');
  });

  test('a single review with no cost makes the numerator a FLOOR, and the note never claims exactness', () => {
    const o = compute(mixedWindow(), spend({ reviewCount: 65, reviewsMissingCost: 1 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.note).not.toContain('The numerator is exact');
    expect(o.spend.note).toContain('FLOOR');
    expect(o.spend.note).toContain('1 of 65');
  });

  test('a floor numerator and an unsettled denominator move the figure in OPPOSITE directions — so neither bound is claimed', () => {
    const o = compute(mixedWindow(), spend({ reviewsMissingCost: 2 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.note).toContain('OPPOSITE directions');
    // The contradiction this whole finding was about: claiming the figure can
    // only fall while also disclosing that backfilling cost raises it.
    expect(o.spend.note).not.toContain('can only FALL');
    expect(o.spend.note).toContain('neither an upper nor a lower bound');
  });

  test('a floor numerator with a settled denominator is a LOWER bound, not an upper one', () => {
    const o = compute([finding({ did: 'ADDRESSED' })], spend({ reviewsMissingCost: 1 }));
    expect(o.spend.denominatorState).toBe('settled');
    expect(o.spend.note).toContain('lower bound, not an upper one');
  });
});

// ---------------------------------------------------------------------------
// Traceability — raised is NOT the row count (review finding 4)
// ---------------------------------------------------------------------------

describe('computeReviewValue — raised vs traced', () => {
  // Shape of the live 30d/prod window: 139 raised, 135 traced, 4 with no file.
  const rows = () => [
    finding({ did: 'ADDRESSED' }),
    finding({ did: 'not' }),
    finding({ did: null }),
  ];

  test('raised comes from the findings_list input, NOT from the row count', () => {
    const o = computeReviewValue(rows(), spend(), { readBandRaised: 5, noFileAnchor: 2 });
    expect(o.findingsRaised).toBe(5);
    expect(o.traceability.traced).toBe(3);
    expect(o.traceability.untraceable).toBe(2);
    expect(o.traceability.untraceableRate).toBeCloseTo(0.4, 10);
  });

  test('the rate over raised uses the TRUE raised figure, so it is not overstated', () => {
    const traced = compute(rows(), spend());
    const withGap = computeReviewValue(rows(), spend(), { readBandRaised: 5, noFileAnchor: 2 });
    // 1/3 counting rows; 1/5 counting what review actually raised.
    expect(traced.addressedRateOfRaised).toBeCloseTo(1 / 3, 10);
    expect(withGap.addressedRateOfRaised).toBeCloseTo(1 / 5, 10);
    expect(withGap.addressedRateOfRaised!).toBeLessThan(traced.addressedRateOfRaised!);
  });

  test('"awaiting a diff" and "can never be judged" are kept apart, never summed into one number', () => {
    const o = computeReviewValue(rows(), spend(), { readBandRaised: 5, noFileAnchor: 2 });
    expect(o.unjudgeable).toBe(3); // 5 raised - 2 judged
    expect(o.awaitingDiff).toBe(1); // traced but no verdict yet
    expect(o.traceability.untraceable).toBe(2); // never will have one
    expect(o.awaitingDiff + o.traceability.untraceable).toBe(o.unjudgeable);
  });

  test('the gap is declared reconciled only when missing file anchors fully explain it', () => {
    const explained = computeReviewValue(rows(), spend(), { readBandRaised: 5, noFileAnchor: 2 });
    expect(explained.traceability.reconciled).toBe(true);
    expect(explained.traceabilityNote).toContain('fully accounted for');
  });

  // -------------------------------------------------------------------------
  // The unreconciled branch. Not reachable from live data once the raised
  // query is windowed per finding (raised - traced == noFileAnchor at every
  // window), but it is the guard that fires if that ever drifts — so its
  // wording has to hold on its own. Every clause here is branched, INCLUDING
  // the missing-file-anchor cause: stating the cause and then "0 of them are
  // explained by a missing file anchor" was the same self-contradiction shape
  // as the spend note's "exact / but a floor".
  // -------------------------------------------------------------------------
  describe('unreconciled gap', () => {
    test('a partly-explained gap names both parts and never contradicts itself', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 1 });
      expect(o.traceability.untraceable).toBe(3);
      expect(o.traceability.reconciled).toBe(false);
      expect(o.traceabilityNote).toContain('1 of them is explained by having no file anchor');
      expect(o.traceabilityNote).toContain('remaining 2 are not explained');
      expect(o.traceabilityNote).not.toContain('fully accounted for');
    });

    test('a wholly-unexplained gap does NOT state the file-anchor cause it just denied', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 0 });
      expect(o.traceability.reconciled).toBe(false);
      expect(o.traceabilityNote).toContain('None of that gap is explained by a missing file anchor');
      // The cause sentence must not also appear — that was the contradiction.
      expect(o.traceabilityNote).not.toContain('are explained by having no file anchor');
      expect(o.traceabilityNote).not.toContain('0 of them');
    });

    test('counts cannot invert — "N of them" can never exceed the gap it refers to', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 5 });
      expect(o.traceability.untraceable).toBe(3);
      // Never "5 of them" where "them" is 3.
      expect(o.traceabilityNote).not.toContain('5 of them');
      // The inversion is reported rather than silently clamped...
      expect(o.traceabilityNote).toContain('cannot happen');
      // ...and it must NOT also claim the gap is explained. Saying "fully
      // accounted for" and "this cannot happen" together is the same
      // self-contradiction one level up.
      expect(o.traceabilityNote).not.toContain('fully accounted for');
    });

    test('the singular case reads as English, not "1 of them are"', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 1 });
      expect(o.traceabilityNote).toContain('1 of them is explained');
      expect(o.traceabilityNote).not.toContain('1 of them are');
    });

    test('no gap but file-less findings traced anyway is reported, not silently called clean', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 3, noFileAnchor: 2 });
      expect(o.traceability.untraceable).toBe(0);
      expect(o.traceabilityNote).toContain('counting differently');
      expect(o.traceabilityNote).not.toContain('every one of them is traceable');
    });

    // This test previously asserted only `toContain('counting differently')`,
    // which its own fixture satisfied while the sentence beside it read
    // "Every read-band finding raised in this window HAS A VERDICT" on a
    // window with nothing judged. The fixture rendered the falsehood and the
    // test passed. It now pins the claim itself.
    test('the untraceable===0 branch claims only TRACEABILITY — the condition says nothing about verdicts', () => {
      const nothingJudged = [finding({ did: null }), finding({ did: null }), finding({ did: null })];
      const o = computeReviewValue(nothingJudged, spend(), { readBandRaised: 3, noFileAnchor: 1 });
      expect(o.judged).toBe(0);
      expect(o.traceability.untraceable).toBe(0);
      expect(o.traceabilityNote).not.toContain('has a verdict');
      expect(o.traceabilityNote).toContain('has an inline thread');
      expect(o.traceabilityNote).toContain('counting differently');
    });

    test('zero raised says there is nothing to trace rather than that everything is traceable', () => {
      const o = computeReviewValue([], spend(), { readBandRaised: 0, noFileAnchor: 0 });
      expect(o.traceabilityNote).toContain('No read-band findings were raised');
      expect(o.traceabilityNote).not.toContain('Every read-band finding');
    });
  });

  test('never renders a negative gap when the two sources disagree the other way', () => {
    // A substantially-reworded re-review can fork the identity key and push
    // the findings_list count BELOW the row count. Floor, not a negative.
    const o = computeReviewValue(rows(), spend(), { readBandRaised: 1, noFileAnchor: 0 });
    expect(o.traceability.untraceable).toBe(0);
    expect(o.findingsRaised).toBe(3);
    expect(o.awaitingDiff).toBeGreaterThanOrEqual(0);
  });

  test('with no gap the note says so plainly rather than going silent', () => {
    const o = compute(rows(), spend());
    expect(o.traceability.untraceable).toBe(0);
    expect(o.traceabilityNote).toContain('every one of them is traceable');
  });

  test('engagement and lead-time denominators stay on TRACED rows, not on raised', () => {
    const o = computeReviewValue(
      [finding({ saidEvidence: 'thread-reply', leadTimeMins: 10 }), finding({ saidEvidence: 'stale-signal', leadTimeMins: null })],
      spend(),
      { readBandRaised: 9, noFileAnchor: 7 },
    );
    // 2 traced rows: 1 engaged, 0 silent, 1 unrecorded. Never 9 - 1 - 0 = 8.
    expect(o.engagement.unrecorded).toBe(1);
    expect(o.leadTime.unrecordedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stated limits reach the payload
// ---------------------------------------------------------------------------

describe('computeReviewValue — stated limits are carried on the payload, not left to the reader', () => {
  test('the reproducibility limit names aggregates as usable and rows as not', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.reproducibilityNote).toContain('33%');
    expect(o.reproducibilityNote).toContain('aggregates');
  });

  test('the scope note says unsettled PRs are excluded rather than counted as ignored', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.scopeNote).toContain('SETTLED');
    expect(o.scopeNote.toLowerCase()).toContain('excluded');
  });
});

// ---------------------------------------------------------------------------
// Presentation — the rules that keep a figure from being misread
// ---------------------------------------------------------------------------

describe('describeAddressed', () => {
  test('names BOTH denominators explicitly, so neither rate can pass as the other', () => {
    const line = describeAddressed(compute(mixedWindow(), spend()));
    expect(line.value).toBe('4 of 8 judged');
    expect(line.detail).toContain('50.0% of JUDGED');
    expect(line.detail).toContain('(4/8)');
    expect(line.detail).toContain('20.0% of ALL findings raised');
    expect(line.detail).toContain('(4/20)');
  });

  test('with nothing judged it states there is no rate — it does not print 0%', () => {
    const line = describeAddressed(compute([finding({ did: null })], spend()));
    expect(line.detail).toContain('no rate to report');
    expect(line.detail).not.toContain('0.0%');
  });
});

describe('describeJudgedCoverage', () => {
  test('states the fraction judged and what the remainder is', () => {
    const text = describeJudgedCoverage(compute(mixedWindow(), spend()));
    expect(text).toContain('8/20');
    expect(text).toContain('40.0%');
    expect(text).toContain('12 carry no verdict, awaiting a diff to judge against');
  });

  test('separates "not yet" from "never" when some findings have no thread', () => {
    const o = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 3 },
    );
    const text = describeJudgedCoverage(o);
    expect(text).toContain('1 awaiting a diff to judge against');
    expect(text).toContain('3 that can never be judged (no inline thread)');
  });

  test('with a single reason the count is stated once, not on both sides of a colon', () => {
    const o = compute([finding({ did: 'ADDRESSED' }), finding({ did: null }), finding({ did: null })], spend());
    const text = describeJudgedCoverage(o);
    expect(o.unjudgeable).toBe(2);
    expect(text).toContain('2 carry no verdict, awaiting a diff to judge against');
    expect(text).not.toContain('2 carry no verdict: 2 awaiting');
  });

  test('a zero clause is omitted, not rendered as "0 awaiting a diff"', () => {
    // Every traced row judged; the only unjudged findings are untraceable.
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 5, noFileAnchor: 4 });
    const text = describeJudgedCoverage(o);
    expect(o.awaitingDiff).toBe(0);
    expect(text).not.toContain('0 awaiting');
    expect(text).toContain('4 carry no verdict and never can: none of them has an inline thread');
  });

  test('says so plainly when everything raised has a verdict', () => {
    const text = describeJudgedCoverage(compute([finding({ did: 'ADDRESSED' })], spend()));
    expect(text).toContain('every finding raised in this window has a verdict');
  });
});

describe('buildDidRows', () => {
  test('shares are over judged rows', () => {
    const rows = buildDidRows(compute(mixedWindow(), spend()));
    const addressed = rows.find((r) => r.label === 'ADDRESSED')!;
    expect(addressed.count).toBe(4);
    expect(addressed.rate).toBeCloseTo(0.5, 10);
  });

  test('with nothing judged every share is null, not 0', () => {
    const rows = buildDidRows(compute([finding({ did: null })], spend()));
    for (const r of rows) expect(r.rate).toBeNull();
  });
});

describe('describeDisputed', () => {
  test("renders 'not yet measured' with a reason, never a zero", () => {
    const line = describeDisputed(compute(mixedWindow(), spend()).disputedAsWrong);
    expect(line.value).toBe('not yet measured');
    expect(line.value).not.toBe('0');
    expect(line.detail.length).toBeGreaterThan(0);
    // 'attention' is asserted here only because `ScorecardFigure` now RENDERS
    // it as a modifier class — pinned by the structural test below. It was
    // previously set by every builder and read by nobody, so this assertion
    // guarded a field with no effect on what anyone sees.
    expect(line.status).toBe('attention');
  });

  test('renders the count as a count once measured, and says it is not a rate', () => {
    const o = compute([finding({ said: 'rejected-wrong' })], spend());
    const line = describeDisputed(o.disputedAsWrong);
    expect(line.value).toBe('1');
    expect(line.detail).toContain('never a rate');
  });
});

describe('describeSpend', () => {
  test('carries judged coverage into the caveat beside the per-item figure', () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.value).toBe('$50.00 per acted-on');
    expect(line.caveat).toContain('8/20');
    expect(line.caveat).toContain('40.0%');
    // The label names the denominator rather than repeating the section title.
    expect(line.label).toBe('Cost per confirmed acted-on finding');
    // A measurement, so it must NOT get the not-a-measurement treatment —
    // that is reserved for "not yet measured". The section carries the
    // unsettledness instead.
    expect(line.status).toBe('neutral');
  });

  test('with nothing acted on it falls back to the total and says why', () => {
    const o = compute([finding({ did: null })], spend({ totalCostUsd: 40 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.value).toBe('$40.00');
    expect(line.detail).toContain('no per-item figure');
    expect(line.label).toBe('Total spend this window');
  });

  test('with NO per-item figure it renders NO per-item caveat — an upper-bound claim there has no referent', () => {
    const o = compute([finding({ did: null })], spend({ totalCostUsd: 40 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(o.spend.costPerAddressed).toBeNull();
    expect(line.caveat).toBeNull();
    // The nearest number is the TOTAL, which is a floor — the exact inverse of
    // "treat it as an upper bound".
    expect(line.detail).not.toContain('upper bound');
  });

  test('the missing-cost floor is disclosed on the no-per-item branch too, beside the total it qualifies', () => {
    const o = compute([finding({ did: null })], spend({ totalCostUsd: 40, reviewCount: 65, reviewsMissingCost: 1 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.detail).toContain('FLOOR');
    expect(line.detail).toContain('1 of 65');
  });

  test('the per-item branch states the missing-cost fact ONCE, in the caveat, not also in the detail', () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200, reviewCount: 65, reviewsMissingCost: 1 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.caveat).toContain('FLOOR');
    expect(line.caveat).not.toContain('The numerator is exact');
    // Said once, not twice: the detail no longer repeats it.
    expect(line.detail).not.toContain('FLOOR');
    const occurrences = (`${line.detail} ${line.caveat}`.match(/carr(?:y|ies) no recorded cost/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe('describeEngagement / describeSilentlyFixed / describeLeadTime', () => {
  test('the headline fraction and the rate share ONE denominator', () => {
    const o = compute(mixedWindow(), spend());
    const line = describeEngagement(o.engagement, o);
    const denominator = o.engagement.engaged + o.engagement.silent;
    expect(line.value).toBe(`8 of ${denominator} with a readable signal`);
    expect(line.detail).toContain(`${denominator} findings where engagement could be read`);
  });

  test('the contrast clause is OMITTED when the denominator IS all findings raised', () => {
    // The live 30d/test shape: 2 raised, 2 traced, both with a signal. Saying
    // "that is not all 2 raised" there is simply false.
    const o = compute([finding({ saidEvidence: 'thread-reply' }), finding({ saidEvidence: 'none' })], spend());
    const line = describeEngagement(o.engagement, o);
    expect(o.engagement.engaged + o.engagement.silent).toBe(o.findingsRaised);
    expect(line.detail).not.toContain('not all');
    expect(line.detail).not.toContain('raised:');
  });

  test('the headline denominator is NOT findingsRaised when the two differ', () => {
    // 1 engaged, 0 silent, 1 unrecorded among 2 traced; 6 raised.
    const o = computeReviewValue(
      [finding({ saidEvidence: 'thread-reply' }), finding({ saidEvidence: 'stale-signal' })],
      spend(),
      { readBandRaised: 6, noFileAnchor: 4 },
    );
    const line = describeEngagement(o.engagement, o);
    expect(line.value).toBe('1 of 1 with a readable signal');
    expect(line.value).not.toContain('of 6');
    // The raised total is still stated — just not as this figure's denominator.
    expect(line.detail).toContain('not all 6 raised');
  });

  test('engagement names BOTH excluded populations separately — unclassified signal and no thread at all', () => {
    const o = computeReviewValue(
      [finding({ saidEvidence: 'stale-signal' }), finding({ saidEvidence: 'none' })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 3 },
    );
    const line = describeEngagement(o.engagement, o);
    expect(line.caveat).toContain('1 traced finding carries no engagement signal');
    expect(line.caveat).toContain('3 raised findings have no thread at all');
  });

  test('silently fixed explains that these are invisible to reply-based measures', () => {
    const line = describeSilentlyFixed(compute(mixedWindow(), spend()));
    expect(line.value).toBe('1');
    expect(line.detail).toContain('nobody said a word');
  });

  test('lead time segments the after-settle rows out in words, not only in the number', () => {
    const o = compute(
      [finding({ leadTimeMins: 30 }), finding({ leadTimeMins: -100 })],
      spend(),
    );
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('Median 30 min');
    expect(text).toContain('AFTER the PR settled');
    expect(text).toContain('excluded from the median above');
  });

  test('lead time with nothing before settle says there is none, rather than "Median n/a"', () => {
    const o = compute([finding({ leadTimeMins: -100 })], spend());
    const text = describeLeadTime(o.leadTime);
    expect(o.leadTime.medianMinsBeforeSettle).toBeNull();
    expect(text).toContain('no lead time to report');
    // "Median n/a" invited the reader to treat an absent population as a
    // measured null.
    expect(text).not.toContain('Median n/a');
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
      outcome: compute(mixedWindow(), spend()),
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
// Count agreement, swept.
//
// Three consecutive review rounds found the same defect: a clause naming a
// count with a hardcoded plural, correct for every value except 1. The third
// round found three more of them INSIDE the functions written that round to
// eliminate the previous three. So this block does not test instances — it
// renders every count-bearing string on the card at n=1 and asserts that no
// singular subject is followed by a plural verb, and that no "(s)" placeholder
// survives anywhere.
// ---------------------------------------------------------------------------

describe('count agreement across every rendered string', () => {
  /** Every string the card can render, for one outcome. */
  function allStrings(o: ReturnType<typeof compute>): string[] {
    const lines = [
      describeAddressed(o),
      describeSilentlyFixed(o),
      describeEngagement(o.engagement, o),
      describeSpend(o.spend, o.addressed, o),
      describeDisputed(o.disputedAsWrong),
    ];
    return [
      ...lines.flatMap((l) => [l.label, l.value, l.detail, l.caveat ?? '']),
      describeJudgedCoverage(o),
      describeVerdictCaption(o),
      describeLeadTime(o.leadTime),
      o.traceabilityNote,
      o.reproducibilityNote,
      o.scopeNote,
      o.spend.note,
    ];
  }

  /** Singular subject followed by a plural verb — "1 finding are", "1 review
   *  carry", "1 of them were". The set of verbs is small because the card's
   *  vocabulary is small; an unlisted verb is a gap, not a pass. */
  const BAD_AGREEMENT = /\b1\s+(?:\w+\s+){0,3}?(are|were|have|carry)\b/;

  const CASES: Array<[string, ReturnType<typeof compute>]> = [
    ['everything at 1', computeReviewValue(
      [finding({ did: 'ADDRESSED', didConfidence: 'majority', saidEvidence: 'thread-reply', leadTimeMins: 5 })],
      { totalCostUsd: 100, reviewCount: 1, reviewsMissingCost: 1 },
      { readBandRaised: 1, noFileAnchor: 0 },
    )],
    ['one untraceable, one traced', computeReviewValue(
      [finding({ did: 'ADDRESSED', saidEvidence: 'thread-reply' })],
      spend({ reviewCount: 1 }),
      { readBandRaised: 2, noFileAnchor: 1 },
    )],
    ['gap 2 explained 1, remainder 1', computeReviewValue(
      [finding({ did: 'not' })], spend(), { readBandRaised: 3, noFileAnchor: 1 },
    )],
    ['one after-settle, one unrecorded lead time, one unclassified signal', computeReviewValue(
      [finding({ leadTimeMins: -5 }), finding({ leadTimeMins: null, saidEvidence: 'stale-signal' }), finding({ leadTimeMins: 9, saidEvidence: 'thread-reply' })],
      spend(), { readBandRaised: 4, noFileAnchor: 1 },
    )],
    ['nothing at all', computeReviewValue([], { totalCostUsd: 0, reviewCount: 0, reviewsMissingCost: 0 }, { readBandRaised: 0, noFileAnchor: 0 })],
    ['everything equal and settled', compute([
      finding({ did: 'ADDRESSED', didConfidence: 'unanimous', saidEvidence: 'thread-reply' }),
      finding({ did: 'not', didConfidence: 'unanimous', saidEvidence: 'none' }),
    ], spend())],
  ];

  for (const [name, o] of CASES) {
    test(`${name}: no singular subject takes a plural verb`, () => {
      const offenders = allStrings(o).filter((s) => BAD_AGREEMENT.test(s));
      expect(offenders).toEqual([]);
    });

    test(`${name}: no "(s)" placeholder survives`, () => {
      const offenders = allStrings(o).filter((s) => s.includes('(s)'));
      expect(offenders).toEqual([]);
    });

    test(`${name}: no clause states a count of zero as a category`, () => {
      // "0 awaiting a diff", "0 findings carry", "Only 0 of them" — a zero
      // count rendered as a listed reason reads as a category that exists and
      // is empty, when it is simply not a reason anything here is unjudged.
      const offenders = allStrings(o).filter((s) => /\b0 (awaiting|of them|traced finding|raised finding)/.test(s));
      expect(offenders).toEqual([]);
    });
  }

  test('the regex actually catches a bad string — a guard that matches nothing proves nothing', () => {
    expect(BAD_AGREEMENT.test('1 of 65 reviews carry no recorded cost')).toBe(true);
    expect(BAD_AGREEMENT.test('1 finding are excluded')).toBe(true);
    expect(BAD_AGREEMENT.test('The remaining 1 are not explained')).toBe(true);
    expect(BAD_AGREEMENT.test('1 of them were recorded')).toBe(true);
    // ...and does not fire on the corrected forms.
    expect(BAD_AGREEMENT.test('1 of 65 reviews carries no recorded cost')).toBe(false);
    expect(BAD_AGREEMENT.test('The remaining 1 is not explained')).toBe(false);
    expect(BAD_AGREEMENT.test('2 findings are excluded')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Individual clauses whose singular form flips a NEGATION, not just a verb —
// these cannot be caught by an agreement regex.
// ---------------------------------------------------------------------------

describe('negation survives the singular form', () => {
  test('one untraceable finding "has NO inline thread", not "has an inline thread"', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 1 });
    const text = describeJudgedCoverage(o);
    expect(text).toContain('it has no inline thread');
    expect(text).not.toContain('it has an inline thread');
  });

  test('many untraceable findings read "none of them has an inline thread"', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 3, noFileAnchor: 2 });
    expect(describeJudgedCoverage(o)).toContain('none of them has an inline thread');
  });
});

// ---------------------------------------------------------------------------
// Clauses that must not reference a quantity the sentence before them denied
// ---------------------------------------------------------------------------

describe('no clause points at a figure that does not exist', () => {
  test('with no before-settle findings the after-settle clause does not cite "that median"', () => {
    const o = compute([finding({ leadTimeMins: -10 }), finding({ leadTimeMins: -20 })], spend());
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('no lead time to report');
    expect(text).not.toContain('excluded from the median above');
    expect(text).not.toContain('that median');
  });

  test('with a median present the after-settle clause DOES say what it is excluded from', () => {
    const o = compute([finding({ leadTimeMins: 10 }), finding({ leadTimeMins: -20 })], spend());
    expect(describeLeadTime(o.leadTime)).toContain('excluded from the median above');
  });

  test('zero engagement population reads as an absence, not as "0 of 0"', () => {
    const o = compute([finding({ saidEvidence: 'stale-signal' })], spend());
    expect(describeEngagement(o.engagement, o).value).toBe('no readable signal');
  });

  test('zero raised is not reported as "every finding has a verdict"', () => {
    const o = computeReviewValue([], spend(), { readBandRaised: 0, noFileAnchor: 0 });
    const text = describeJudgedCoverage(o);
    expect(text).toBe('No read-band findings were raised in this window.');
  });

  test('the verdict caption does not describe an empty remainder', () => {
    const allUnanimous = compute([
      finding({ did: 'ADDRESSED', didConfidence: 'unanimous' }),
      finding({ did: 'not', didConfidence: 'unanimous' }),
    ], spend());
    expect(describeVerdictCaption(allUnanimous)).toContain('Every judged row had all three ballots agree');
    expect(describeVerdictCaption(allUnanimous)).not.toContain('the other');

    const noneUnanimous = compute([finding({ did: 'ADDRESSED', didConfidence: 'majority' })], spend());
    expect(describeVerdictCaption(noneUnanimous)).toContain('No judged row had all three ballots agree');

    const mixed = compute([
      finding({ did: 'ADDRESSED', didConfidence: 'unanimous' }),
      finding({ did: 'not', didConfidence: 'majority' }),
    ], spend());
    expect(describeVerdictCaption(mixed)).toContain('the other 1 reached only a majority');
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

  test("only the not-a-measurement line carries 'attention' — the treatment must stay rare enough to mean something", () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200 }));
    const lines = [
      describeAddressed(o),
      describeSilentlyFixed(o),
      describeEngagement(o.engagement, o),
      describeSpend(o.spend, o.addressed, o),
      describeDisputed(o.disputedAsWrong),
    ];
    expect(lines.filter((l) => l.status === 'attention').map((l) => l.label)).toEqual(['Disputed as factually wrong']);
  });

  test('ScorecardLine.status is actually rendered — a builder-only field would make the flag decorative', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    expect(cardSrc).toContain('review-value-figure--${line.status}');
  });

  test('every status a builder emits has a CSS rule — an unstyled modifier renders identically to none', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    const cssSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
      'utf-8',
    );
    const emitted = new Set((cardSrc.match(/status: '(ok|attention|neutral)'/g) ?? []).map((m) => m.split("'")[1]!));
    expect(emitted.size).toBeGreaterThan(0);
    for (const status of emitted) {
      // 'neutral' is the unadorned base — the bare `.review-value-figure` rule
      // IS its styling, so it needs no modifier of its own.
      if (status === 'neutral') continue;
      expect(cssSrc).toContain(`.review-value-figure--${status}`);
    }
  });

  // -------------------------------------------------------------------------
  // The `findingKey` reproduction in SQL. It only ever executes against a live
  // database, both of its normalisation steps are no-ops on current data (0 of
  // 143 read-band entries carry a backslash or a leading slash), and nothing
  // else asserts on the query text — so re-collapsing `'\\'` to `'\'` would
  // leave the whole suite green while silently changing the headline number
  // the first time a Windows-style path appears. `'\'` in a TS template is the
  // escape for a quote, which makes the call `replace(x, '', '/')`: a no-op
  // Postgres accepts without complaint.
  // -------------------------------------------------------------------------
  test("the backslash normalisation uses '\\\\', not the silently-empty '\\'", () => {
    const raisedQuery = statsSrc.slice(statsSrc.indexOf('WITH read_band AS ('), statsSrc.indexOf('FROM identified'));
    expect(raisedQuery).toContain("replace(btrim(f->>'file'), '\\\\', '/')");
    // The collapsed form must not appear at all — it is the regression.
    expect(raisedQuery).not.toMatch(/replace\([^)]*'\\'[^\\]/);
  });

  test('the file normalisation strips leading slashes as well, matching findingKey', () => {
    const raisedQuery = statsSrc.slice(statsSrc.indexOf('WITH read_band AS ('), statsSrc.indexOf('FROM identified'));
    expect(raisedQuery).toContain("'^/+'");
  });

  test('the raised query is windowed per FINDING, not only per PR', () => {
    const fn = statsSrc.slice(statsSrc.indexOf('export async function getReviewValueStats'));
    const raisedQuery = fn.slice(fn.indexOf('WITH read_band AS ('), fn.indexOf('// Spend over the REVIEWS'));
    // The per-identity min(created_at) IS the window predicate; a PR-scoped
    // EXISTS alone made "raised" a different, larger population than "traced".
    expect(raisedQuery).toContain('min(created_at) AS first_raised_at');
    expect(raisedQuery).toContain('GROUP BY pr_id, repo_key, norm_file, norm_title');
    expect(raisedQuery).toMatch(/WHERE first_raised_at > now\(\) - \(\$\{days\}::int/);
  });

  test('the review-value signal is NOT fed to pickPopulationMeta — its otherPopulationCount counts findings, not reviews', () => {
    const call = viewSrc.slice(viewSrc.indexOf('pickPopulationMeta('), viewSrc.indexOf('pickPopulationMeta(') + 400);
    const invocation = call.slice(call.indexOf('pickPopulationMeta(costStats'));
    expect(invocation.slice(0, invocation.indexOf(')'))).not.toContain('reviewValueStats');
  });
});
