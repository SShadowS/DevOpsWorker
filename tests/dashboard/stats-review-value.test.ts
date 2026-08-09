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
  didVerdictText,
  buildReviewValuePanelView,
} from '../../src/dashboard/client/components/stats-review-value.tsx';
import { DID_LABELS } from '../../src/db/finding-outcome-mapper.ts';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';

// No test in this file may open a database connection (repo convention — see
// tests/dashboard/stats.test.ts: DATABASE_URL points at the live production
// database). `computeReviewValue` is pure by construction: it takes rows, not
// a `sql` handle, which is the property the last test block below pins.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(overrides: Partial<ReviewValueFindingRow> = {}): ReviewValueFindingRow {
  return { did: null, didConfidence: null, said: null, saidConfidence: null, saidEvidence: 'none', leadTimeMins: 60, ...overrides };
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
    // Same convention as `count`: a zero here would be a measured cross-tab of
    // a population that was never measured.
    expect(o.disputedAsWrong.unjudged).toBeNull();
    expect(o.disputedAsWrong.unjudged).not.toBe(0);
    expect(o.disputedAsWrong.saidRecorded).toBe(0);
    expect(o.disputedAsWrong.reason!.length).toBeGreaterThan(0);
  });

  // The reason's clauses are true only while `saidRecorded === 0`, so on a
  // measured payload it is not unused — it is FALSE. It shipped as a plain
  // `string` for one round and every live payload served the not-measured
  // sentence — which opens by saying no problem here has a recorded answer —
  // beside a `saidRecorded` of 72. The card never rendered it, which is exactly
  // why the type has to carry the scope: "nothing reads it" is not a contract.
  test('the reason is NULL once measured — it is not merely unread there, it is false', () => {
    const measured = compute([finding({ said: 'fixed' })], spend());
    expect(measured.disputedAsWrong.measured).toBe(true);
    expect(measured.disputedAsWrong.reason).toBeNull();
    // ...and present exactly where it is true.
    const notMeasured = compute(mixedWindow(), spend());
    expect(notMeasured.disputedAsWrong.reason).not.toBeNull();
  });

  // ENTAILMENT. The reason is rendered only when `saidRecorded === 0`, and that
  // condition establishes that no row here carries a label — nothing about the
  // classifier's existence. It asserted "it has not been built" for as long as
  // that happened to be true, and stayed on the payload after the sweep ran and
  // populated 72 of 135 live rows.
  test('the not-measured reason does not claim the said phase is unbuilt', () => {
    const reason = compute(mixedWindow(), spend()).disputedAsWrong.reason!;
    expect(reason).not.toContain('has not been built');
    expect(reason).not.toContain('deliberately leaves null');
    // It says what the condition DOES establish, and lists the causes it
    // cannot distinguish rather than picking one.
    expect(reason).toContain('No problem here has a recorded answer for what the team said about it');
    expect(reason).toContain('not measured rather than as zero');
  });

  // ENTAILMENT, and the subtler one: WHOSE limitation is it? `saidRecorded ===
  // 0` establishes what THIS COMPUTATION saw. `said_confidence` ALONE only
  // resolves a tie; production data (2026-08-08: 63/63 not-yet-measured rows
  // carry `said_confidence` null) showed it cannot separate "no ballot" from
  // "not yet classified" on its own — both leave that column null — so
  // `said_evidence` is read too, and the reason names whichever of the three
  // states the window is actually in rather than claim it cannot tell (the
  // earlier round's defect on this exact line: it said the opposite of what
  // the columns it went on to name already let it do). Every state below,
  // printed verbatim — see task-8-report.md for the same output produced by
  // a standalone script, not just this suite. Two of the three states below
  // (not-yet-classified, tied) have NO live example as of 2026-08-08 — they
  // are pinned here from forced fixtures precisely because they can't be
  // eyeballed against production.
  describe('state taxonomy — said_confidence + said_evidence resolve all three states', () => {
    test('PURE: no engaged evidence — the only state observed in production (63/63 live rows)', () => {
      const rows = Array.from({ length: 5 }, () => finding({ saidConfidence: null, saidEvidence: 'none' }));
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '5 findings have no reply on record, so no answer was ever recorded for them. Reported as not ' +
        'measured rather than as zero: counting this as zero would say nobody disputed these, and nothing here ' +
        'recorded an answer on whether anyone did.',
      );
    });

    // NO LIVE EXAMPLE as of 2026-08-08 — every finding with a reply on record
    // has, live, already been balloted. Forced here because this is exactly
    // the state the previous round got backwards on: it read a null
    // `said_confidence` alone as license to say "nobody wrote anything",
    // which is false whenever `said_evidence` is engaged.
    test('PURE: has a reply on record but not yet classified — no live example, forced fixture', () => {
      const rows = [
        finding({ saidConfidence: null, saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: null, saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: null, saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: null, saidEvidence: 'thread-reply' }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '4 findings have a reply on the thread or in the pull request discussion, but have not had an answer ' +
        'recorded yet. Reported as not measured rather than as zero: counting this as zero would say nobody ' +
        'disputed these, and nothing here recorded an answer on whether anyone did.',
      );
    });

    // NO LIVE EXAMPLE as of 2026-08-08 (0 of 72 said-labelled rows are a
    // tie) — reachable in principle (`SaidLabel` has no tie value, so a tie
    // stores `said = null, said_confidence = 'split'`), forced here. Note the
    // closing clause: "were voted on" and "nothing here recorded an answer on
    // whether anyone did" CAN both be true in the same sentence (a tied vote
    // records no `said` value either), but leaving the generic claim unscoped
    // there would omit the one thing this card can positively confirm, so the
    // tied branch gets its own, more specific tail instead. Note too what the
    // tail does NOT say: not "the three checks" — three is the per-finding
    // vote count, and this window of three tied findings ran nine.
    test('PURE: tied — no live example, forced fixture', () => {
      const rows = [
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: 'split', saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '3 findings were voted on and the votes did not agree. Reported as not measured rather than as zero: ' +
        'counting this as zero would say nobody disputed these, and the votes that ran did not agree on an answer.',
      );
    });

    test('count-of-1 for each pure state', () => {
      const noEngaged = compute([finding({ saidConfidence: null, saidEvidence: 'none' })], spend()).disputedAsWrong.reason!;
      expect(noEngaged).toContain('1 finding has no reply on record, so no answer was ever recorded for it.');

      const notYetClassified = compute([finding({ saidConfidence: null, saidEvidence: 'thread-reply' })], spend()).disputedAsWrong.reason!;
      expect(notYetClassified).toContain('1 finding has a reply on the thread or in the pull request discussion, but has not had an answer recorded yet');

      const tied = compute([finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' })], spend()).disputedAsWrong.reason!;
      expect(tied).toContain('1 finding was voted on and the votes did not agree.');
      expect(tied).toContain('the votes that ran did not agree on an answer');
    });

    // `said_evidence` values that are NOT engaged (`'none'`, `'stale-signal'`,
    // and unset) must all fold into the SAME "no engaged evidence" bucket —
    // none of the three is a reply on record, and none licenses "not yet
    // classified" (that state requires a reply to classify). Getting this
    // fold wrong — e.g. reading `null` `said_evidence` as "has a reply
    // pending classification" — is exactly the kind of unearned claim this
    // line exists to avoid.
    test('stale-signal and unset said_evidence fold into "no engaged evidence", not "not yet classified"', () => {
      const rows = [
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'stale-signal' }),
        finding({ saidConfidence: null, saidEvidence: null }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toContain('3 findings have no reply on record, so no answer was ever recorded for them');
      expect(reason).not.toContain('a reply on the thread or in the pull request discussion');
    });

    // POSITIVE counting. `saidConfidence` mirrors `did_confidence`, whose
    // fuller domain (documented at `unanimous`'s domain, ~stats.ts:1630) is
    // 'unanimous'/'majority'/'split'/'single-vote'/'none' — more than the two
    // values {null, 'split'} this line's fast path assumes for a null `said`.
    // A row that matches neither positive test must not be silently absorbed
    // into "no answer was ever recorded for them", which it has not earned:
    // it goes to an explicit residual bucket instead, so the total never
    // silently drops findings the way `findings.length - tied` would have.
    //
    // The closing clause here is "cannot tell", NOT "nothing here recorded an
    // answer on whether anyone did" — a prior round left the tail gated on
    // `tied === 0` alone, which let it leak into exactly this state. A
    // `saidConfidence` of `'unanimous'` beside a null `said` is the signature
    // of a writer that graded votes and dropped the label (per the comment on
    // `unrecognized`), so this card has no basis for "no answer given" — which
    // is why the tail says it cannot tell either way rather than asserting the
    // opposite.
    // "Cannot tell" is the whole window's state HERE only because no tie is
    // present: with one, the card could confirm a check ran, and the tail names
    // it and scopes this doubt to the unrecognized rows instead (see below).
    test('a said_confidence value outside {null, split} lands in an explicit residual bucket, not "no ballot"', () => {
      const rows = [finding({ saidConfidence: 'unanimous', saidEvidence: 'none' })];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '1 finding has a stored result this card cannot read. Reported as not measured rather than as zero: ' +
        'counting this as zero would say nobody disputed these, and this card cannot tell whether the team ever gave an answer.',
      );
    });

    test('the residual bucket does not silently drop counts when mixed with named buckets', () => {
      const rows = [
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: 'unanimous', saidEvidence: 'none' }),
        finding({ saidConfidence: 'majority', saidEvidence: 'none' }),
      ];
      const o = compute(rows, spend());
      expect(o.disputedAsWrong.saidRecorded).toBe(0); // untouched — still gated on `said`, not `saidConfidence`
      const reason = o.disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '1 finding was voted on and the votes did not agree, 1 has no reply on record, so no answer was ever ' +
        'recorded for it, and 2 have a stored result this card cannot read. Reported as not measured rather ' +
        'than as zero: counting this as zero would say nobody disputed these; the votes this card can read did ' +
        'not agree on an answer, and this card cannot tell what answer the team gave for the ones whose stored ' +
        'result it cannot read.',
      );
    });

    // A tie AND an unrecognized row in the same window: the tail must render
    // BOTH facts. An earlier round let the residual clause win outright, so the
    // string asserted votes were cast and did not agree and then, in the very
    // next sentence, that it "cannot tell whether the team EVER gave an answer" —
    // asserting and denying the same proposition. Scoping the residual WITHOUT
    // naming the votes is the mirror-image defect: it drops the one thing in
    // the window this card positively knows was checked. So: votes named,
    // residual scoped to its own rows, and neither unscoped variant present.
    test('a tie beside an unrecognized row renders both facts, each scoped to its own rows', () => {
      const withTie = compute(
        [
          finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
          finding({ saidConfidence: 'unanimous', saidEvidence: 'none' }),
        ],
        spend(),
      ).disputedAsWrong.reason!;
      expect(withTie).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '1 finding was voted on and the votes did not agree and 1 has a stored result this card cannot read. ' +
        'Reported as not measured rather than as zero: counting this as zero would say nobody disputed these; ' +
        'the votes this card can read did not agree on an answer, and this card cannot tell what answer the ' +
        'team gave for the one whose stored result it cannot read.',
      );
      // The tie survives, scoped to the votes this card can read — the
      // unrecognized row beside it carries votes that ran AND agreed.
      expect(withTie).toContain('the votes this card can read did not agree on an answer');
      expect(withTie).not.toContain('the votes that ran did not agree on an answer');
      // ...the residual doubt is scoped to the rows it covers, not to the window...
      expect(withTie).toContain('cannot tell what answer the team gave for the one whose');
      // ...and neither the window-wide denial nor "no answer given" appears.
      expect(withTie).not.toContain('cannot tell whether the team ever gave an answer');
      expect(withTie).not.toContain('nothing here recorded an answer on whether anyone did');
    });

    // Bare numerals after the first fragment — "2 findings…and 3 findings…"
    // reads as two separate counts of the same population; "2 findings…and
    // 3…" reads as one window's breakdown, which is what it is.
    test('mixture: tied + no engaged evidence (bare numeral after the first fragment)', () => {
      const rows = [
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '2 findings were voted on and the votes did not agree and 3 have no reply on record, so no answer was ' +
        'ever recorded for them. Reported as not measured rather than as zero: counting this as zero would ' +
        'say nobody disputed these, and the votes that ran did not agree on an answer.',
      );
    });

    test('mixture: not-yet-classified + no engaged evidence', () => {
      const rows = [
        finding({ saidConfidence: null, saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: null, saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '2 findings have a reply on the thread or in the pull request discussion, but have not had an answer ' +
        'recorded yet and 3 have no reply on record, so no answer was ever recorded for them. Reported as ' +
        'not measured rather than as zero: counting this as zero would say nobody disputed these, and nothing ' +
        'here recorded an answer on whether anyone did.',
      );
    });

    test('mixture: all three states present at once', () => {
      const rows = [
        finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        finding({ saidConfidence: null, saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: null, saidEvidence: 'pr-discussion' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
        finding({ saidConfidence: null, saidEvidence: 'none' }),
      ];
      const reason = compute(rows, spend()).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
        '1 finding was voted on and the votes did not agree, 2 have a reply on the thread or in the pull ' +
        'request discussion, but have not had an answer recorded yet, and 3 have no reply on record, so no ' +
        'answer was ever recorded for them. Reported as not measured rather than as zero: counting this as ' +
        'zero would say nobody disputed these, and the votes that ran did not agree on an answer.',
      );
    });

    // Reachable (a window with reviews but nothing traced yet) and must not
    // crash on an empty `parts` list.
    test('zero findings traced at all does not crash', () => {
      const reason = compute([], spend(), { readBandRaised: 0, noFileAnchor: 0 }).disputedAsWrong.reason!;
      expect(reason).toBe(
        'No finding was traced in this window at all, so there is nothing to count. Reported as not measured ' +
        'rather than as zero: counting this as zero would say nobody disputed a finding, and nothing here ' +
        'recorded an answer on whether anyone did.',
      );
      // "a finding", not "these": there is no window contents for a
      // demonstrative to point at here.
      expect(reason).not.toContain('nobody disputed these');
    });

    // The removed claim: an earlier round asserted THIS CARD could not tell
    // the three states apart. That was false the moment both columns were
    // selected, so it must not reappear in any state, pure or mixed.
    test('no state claims the card cannot tell the three states apart', () => {
      const reasons = [
        compute([finding({ saidConfidence: null, saidEvidence: 'none' })], spend()).disputedAsWrong.reason!,
        compute([finding({ saidConfidence: null, saidEvidence: 'thread-reply' })], spend()).disputedAsWrong.reason!,
        compute([finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' })], spend()).disputedAsWrong.reason!,
        compute(mixedWindow(), spend()).disputedAsWrong.reason!,
      ];
      for (const reason of reasons) {
        expect(reason).not.toContain('cannot tell them apart');
        expect(reason).not.toContain('THIS CARD');
      }
    });

    // The closing "why not zero" clause must never go silent about a tie in
    // the mix. Both denials stay TRUE even with a tie present — barring them
    // is IMPLICATURE and scope, not falsehood, for both:
    //   - "nothing here recorded an answer on whether anyone did" stays true
    //     (a tied vote records no `said` value either), but it would go
    //     silent about the one thing this card can positively confirm —
    //     three votes ran and did not agree, stated in the sentence right
    //     before this one.
    //   - "cannot tell whether the team EVER gave an answer" ALSO stays true:
    //     a split vote is the graders failing to agree what answer the reply
    //     constitutes, so this card genuinely cannot tell whether an answer
    //     resulted for a tied row either — the same uncertainty as an
    //     unrecognized row, not a confirmed negative. Left unscoped, it would
    //     spread that same undifferentiated doubt over the tied row this card
    //     CAN positively confirm was checked.
    // Neither denial is "wrong" where a tie is present; both would merely
    // understate what the sentence right before them already establishes.
    // DENIALS below tracks the CURRENT wording — reword a tail and these
    // substrings stop matching anything, so they must be re-derived from the
    // new wording, not left to pass vacuously.
    test('the closing clause never denies a check happened where a tie is present', () => {
      const DENIALS = ['nothing here recorded an answer on whether anyone did', 'cannot tell whether the team ever gave an answer'];
      // Two forms, because the combined tail scopes the tie to the votes this
      // card can read (an unrecognized row in the window carries votes that ran
      // AND agreed, so the universal would over-claim). Exactly one must
      // render: naming the tie is the property, and the two forms are
      // alternatives, never both.
      const TIE_NAMED = [
        'the votes that ran did not agree on an answer',
        'the votes this card can read did not agree on an answer',
      ];
      const tiedRow = finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' });
      const withTie: Array<[string, ReviewValueFindingRow[]]> = [
        ['tie alone', [tiedRow]],
        ['tie + no ballot', [tiedRow, finding({ saidConfidence: null, saidEvidence: 'none' })]],
        ['tie + not yet classified', [tiedRow, finding({ saidConfidence: null, saidEvidence: 'thread-reply' })]],
        ['tie + unrecognized', [tiedRow, finding({ saidConfidence: 'unanimous', saidEvidence: 'none' })]],
      ];
      for (const [label, rows] of withTie) {
        const reason = compute(rows, spend()).disputedAsWrong.reason!;
        expect(
          TIE_NAMED.filter((form) => reason.includes(form)),
          `${label}: the tie must be named, in exactly one of its two forms`,
        ).toHaveLength(1);
        for (const denial of DENIALS) {
          expect(reason, `${label}: must not contain "${denial}"`).not.toContain(denial);
        }
      }

      // ...and conversely, NEITHER form of "the votes did not agree" may appear
      // where there is no tie — it would assert a check that never happened.
      const noTie = compute([finding({ saidConfidence: null, saidEvidence: 'none' })], spend()).disputedAsWrong.reason!;
      expect(noTie).toContain('nothing here recorded an answer on whether anyone did');
      for (const form of TIE_NAMED) {
        expect(noTie, `no tie: must not contain "${form}"`).not.toContain(form);
      }
    });

    // THE FULL TRUTH TABLE. Four buckets give FIFTEEN non-empty combinations,
    // not four — and the previous version of this test walked four of them while
    // claiming "all four bucket combinations" in its name, never exercising `N`
    // at all. Of the four states the closing clause was rendering falsely at the
    // time (T+U, T+N+U, T+E+U, T+N+E+U) that table reached exactly one, T+U, and
    // pinned the false rendering as the expected output.
    //
    // The combinations are GENERATED from `bucketRow`'s keys rather than hand-
    // listed, so no combination of the declared buckets can be skipped, and
    // declaring a fifth bucket here forces expectations for all 31: the key-set
    // assertion below fails until every new combination has one. The expected
    // tail per combination is written out by hand, because deriving it would
    // just restate the gate this test exists to check. T = tied,
    // N = not-yet-classified, E = no-engaged-evidence,
    // U = unrecognized `said_confidence`.
    //
    // Only (tied > 0, unrecognized > 0) selects the tail, so four tails cover
    // all fifteen: a tie in the mix ⇒ the tie is named, in whichever of its TWO
    // forms the window licenses (the universal "the votes that ran" where no
    // unrecognized row is present, the narrower "the votes this card can read"
    // where one is — see the constant below for why); an unrecognized row in the
    // mix ⇒ its doubt is voiced, window-wide where there is no tie for it to
    // contradict and scoped to its own rows where there is; neither ⇒ nothing
    // here recorded an answer. The two tie forms are DELIBERATE, not drift: do not
    // "restore consistency" by collapsing them without reading that constant —
    // collapsing them to the universal is how this clause breaks.
    //
    // WHAT THIS TABLE DOES NOT CHECK, and the reason three false states once
    // shipped green: it pins SELECTION, not TRUTH. Feed it four false constants
    // and all fifteen combinations pass, having confirmed only that each gate
    // reaches the constant written beside it. Every constant below must be
    // checked BY HAND against the condition that gates it. In particular all
    // four open with the subjunctive "counting this as zero WOULD say nobody
    // disputed these" — a caution about how a zero reads, never the assertion
    // "nobody disputed these", which the `N` bucket alone can falsify (a reply
    // is on record there and nothing has read it yet). Flatten that and the
    // table still passes.
    test('all fifteen non-empty bucket combinations render exactly one tail, and it is the true one', () => {
      const NO_ANSWER_GIVEN =
        'counting this as zero would say nobody disputed these, and nothing here recorded an answer on whether anyone did.';
      const TIED_SETTLED =
        'counting this as zero would say nobody disputed these, and the votes that ran did not agree on an answer.';
      const CANNOT_CONFIRM =
        'counting this as zero would say nobody disputed these, and this card cannot tell whether the team ever gave an answer.';
      // "the votes THIS CARD CAN READ", not "the votes that ran": this tail
      // renders only where an `unrecognized` row is also present, and such a row
      // CAN carry a `said_confidence` of `'unanimous'`/`'majority'`/
      // `'single-vote'` (~stats.ts:1367-1370) — votes that ran AND agreed. "Can"
      // is the whole point: `unrecognized` is a residual by complement and its
      // membership is not established, so the clause is written to hold whatever
      // lands there. A definite description over the whole window would not.
      // The standalone tie tail above keeps the universal, where it is sound
      // because that branch requires no unrecognized row at all.
      //
      // Singular here because every combination below contributes exactly one
      // row per bucket, so `agree()` renders "the one". The plural form is
      // pinned by the two-unrecognized-row test above.
      const TIED_AND_SCOPED_RESIDUAL =
        'counting this as zero would say nobody disputed these; the votes this card can read did not agree on an ' +
        'answer, and this card cannot tell what answer the team gave for the one whose stored result it cannot read.';
      const allTails = [NO_ANSWER_GIVEN, TIED_SETTLED, CANNOT_CONFIRM, TIED_AND_SCOPED_RESIDUAL];

      // The "must not also contain" assertions below only mean anything if no
      // tail is a substring of another. Assert that rather than assume it — the
      // combined tail deliberately reuses wording from two of the others.
      for (const tail of allTails) {
        for (const other of allTails) {
          if (tail !== other) {
            expect(other, `a tail containing another makes the exclusivity checks vacuous: "${tail}"`).not.toContain(tail);
          }
        }
      }

      const bucketRow: Record<string, () => ReviewValueFindingRow> = {
        T: () => finding({ saidConfidence: 'split', saidEvidence: 'thread-reply' }),
        N: () => finding({ saidConfidence: null, saidEvidence: 'thread-reply' }),
        E: () => finding({ saidConfidence: null, saidEvidence: 'none' }),
        U: () => finding({ saidConfidence: 'unanimous', saidEvidence: 'none' }),
      };

      const expectedTail: Record<string, string> = {
        'T': TIED_SETTLED,
        'N': NO_ANSWER_GIVEN,
        'E': NO_ANSWER_GIVEN,
        'U': CANNOT_CONFIRM,
        'T+N': TIED_SETTLED,
        'T+E': TIED_SETTLED,
        'T+U': TIED_AND_SCOPED_RESIDUAL,
        'N+E': NO_ANSWER_GIVEN,
        'N+U': CANNOT_CONFIRM,
        'E+U': CANNOT_CONFIRM,
        'T+N+E': TIED_SETTLED,
        'T+N+U': TIED_AND_SCOPED_RESIDUAL,
        'T+E+U': TIED_AND_SCOPED_RESIDUAL,
        'N+E+U': CANNOT_CONFIRM,
        'T+N+E+U': TIED_AND_SCOPED_RESIDUAL,
      };

      const buckets = Object.keys(bucketRow);
      const combinations = Array.from({ length: 2 ** buckets.length - 1 }, (_unused, i) =>
        buckets.filter((_b, bit) => (((i + 1) >> bit) & 1) === 1).join('+'),
      );
      expect(combinations).toHaveLength(15);
      // Every generated combination has a hand-written expectation, and no
      // expectation names a combination that cannot occur.
      expect([...combinations].sort()).toEqual(Object.keys(expectedTail).sort());

      for (const combination of combinations) {
        const rows = combination.split('+').map((b) => bucketRow[b]!());
        const reason = compute(rows, spend()).disputedAsWrong.reason!;
        expect(reason, combination).toContain(expectedTail[combination]!);
        for (const tail of allTails) {
          if (tail !== expectedTail[combination]) {
            expect(reason, `${combination}: must not also contain "${tail}"`).not.toContain(tail);
          }
        }
      }
    });
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
    expect(o.disputedAsWrong.unjudged).toBe(0);
  });

  test('the denominator is the LABELLED rows, not the traced ones and not the raised ones', () => {
    // 3 traced, 2 labelled, 5 raised. Three candidate denominators, and only
    // one of them is the population a `said` label can be read off.
    const o = computeReviewValue(
      [finding({ said: 'rejected-wrong' }), finding({ said: 'fixed' }), finding({ said: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 2 },
    );
    expect(o.disputedAsWrong.saidRecorded).toBe(2);
    expect(o.traceability.traced).toBe(3);
    expect(o.findingsRaised).toBe(5);
  });

  test('the `did` cross-tab counts disputed rows with no verdict — the live shape', () => {
    // Both disputed findings in production carry `did = null`.
    const o = compute(
      [
        finding({ said: 'rejected-wrong', did: null }),
        finding({ said: 'rejected-wrong', did: null }),
        finding({ said: 'fixed', did: 'ADDRESSED' }),
      ],
      spend(),
    );
    expect(o.disputedAsWrong.count).toBe(2);
    expect(o.disputedAsWrong.unjudged).toBe(2);
  });

  test('the cross-tab counts only DISPUTED rows — an unjudged row with another label is not one', () => {
    const o = compute([finding({ said: 'rejected-wrong', did: 'not' }), finding({ said: 'fixed', did: null })], spend());
    expect(o.disputedAsWrong.count).toBe(1);
    expect(o.disputedAsWrong.unjudged).toBe(0);
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
    expect(o.spend.note).toContain('not the same measurement');
    expect(o.spend.note).toContain('not a trend');
  });

  // -------------------------------------------------------------------------
  // The note is plain English, built from the same two state flags
  // (`numeratorState`, `denominatorState`) — the flags are what these assert,
  // and the full rendered sentence is pinned with `toBe` so the wording can't
  // drift without a test noticing. Six combinations are reachable in theory
  // (the movement half re-tests `numerator === 'exact'`, the same boolean the
  // numerator half already branches on, so the two halves are not independent
  // axes — see `NumeratorState`'s doc comment), but the `reviewCount === 0`
  // pair is unreachable in practice per that comment, so only one degenerate
  // case plus the four real combinations are pinned below.
  // -------------------------------------------------------------------------

  const TRAILER =
    'This is not the same measurement as the Cost panel, which divides by every problem raised rather than by the ' +
    'problems confirmed acted on, so the gap between the two numbers is not a trend. Spend here counts every ' +
    'review on these pull requests, including repeat reviews that found none of the problems counted here.';

  test('reviewCount 0 is a degenerate case: the note says there is no real figure, not a false zero', () => {
    const o = compute([], { totalCostUsd: 0, reviewCount: 0, reviewsMissingCost: 0 });
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.reviewCount).toBe(0);
    expect(o.spend.note).toBe(
      `No review on these pull requests has a recorded cost, so this shows zero rather than a real figure. ${TRAILER}`,
    );
  });

  test('exact numerator + settled denominator: the note says both sides are complete and it will not move', () => {
    // Not "settled": this card's glossary defines "settled" as "the pull
    // request has been merged or closed" (TERMS in this component file), but
    // `denominatorState === 'settled'` only requires every RAISED finding to
    // be judged — reachable on a still-open PR. Reusing "settled" here would
    // teach the glossary's PR-lifecycle meaning onto a figure that says
    // nothing about whether the PR itself has merged or closed.
    // Also not "final": a rolling window gets new reviews tomorrow, so
    // nothing about this figure is terminal — only the two flags the gate
    // actually sets (every cost recorded, every problem checked) are true.
    // "Both sides of this figure are complete" asserts exactly those two
    // flags and nothing more.
    const o = compute([finding({ did: 'ADDRESSED' })], spend());
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.denominatorState).toBe('settled');
    expect(o.spend.note).toBe(
      'Both sides of this figure are complete. Every review on these pull requests has a recorded cost, and ' +
        `every problem has been checked, so it will not move as more checking happens. ${TRAILER}`,
    );
  });

  test('floor numerator + settled denominator: the note says the real figure is AT LEAST this much', () => {
    const o = compute([finding({ did: 'ADDRESSED' })], spend({ reviewCount: 65, reviewsMissingCost: 1 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.denominatorState).toBe('settled');
    expect(o.spend.note).toBe(
      'The real figure is at least this much. 1 of 65 reviews has no recorded cost, so the real spend is at ' +
        `least the figure shown. Every problem has been checked, so that side will not change. ${TRAILER}`,
    );
  });

  test('exact numerator + will-grow denominator: the note says the real figure is AT MOST this much', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.note).toBe(
      'The real figure is at most this much. Every review has a recorded cost, but not every problem has been ' +
        `checked yet, and each one confirmed acted on brings this figure down. ${TRAILER}`,
    );
  });

  test('floor numerator + will-grow denominator: the note says treat this as a rough reading, pulled both ways', () => {
    const o = compute(mixedWindow(), spend({ reviewCount: 65, reviewsMissingCost: 1 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.note).toBe(
      'Treat this as a rough reading, not a firm number. Two things are still incomplete and they pull in ' +
        'opposite directions: 1 of 65 reviews has no recorded cost, which makes the figure look low, and not ' +
        `every problem has been checked yet, which makes it look high. ${TRAILER}`,
    );
  });

  /** Every way the note could claim the denominator still has room to move —
   *  substrings drawn from the two will-grow leaves above and checked absent
   *  from a settled note. An earlier version of this block constructed a
   *  fully-judged fixture and then asserted `toContain('can only fall')` —
   *  pinning as required behaviour a growth claim that is false at full
   *  coverage. It also banned only the literal word 'large', which "the
   *  unjudged share dominates" would have walked straight past. Asserting the
   *  STATE, and asserting the absence of growth claims as a property over a
   *  phrase set, fixes both. */
  const GROWTH_CLAIMS = ['not every problem has been checked yet', 'brings this figure down', 'at most this much', 'still incomplete', 'makes it look high'];

  test('at PARTIAL coverage the denominator is `will-grow` and the note says the figure can only fall', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.judgedCoverage).toBeLessThan(1);
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.numeratorState).toBe('exact');
    expect(o.spend.note).toContain('brings this figure down');
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
    // Both substrings: the degenerate leaf's "No review ... has a recorded
    // cost" also contains "has a recorded cost", so that phrase alone would
    // pass on the negated claim too. "Every review" is what pins the leaf.
    expect(o.spend.note).toContain('Every review');
    expect(o.spend.note).toContain('has a recorded cost');
  });

  test('a single review with no cost makes the numerator a floor, and the note never claims every review has a cost', () => {
    const o = compute(mixedWindow(), spend({ reviewCount: 65, reviewsMissingCost: 1 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.note).not.toContain('has a recorded cost');
    expect(o.spend.note).toContain('has no recorded cost');
    expect(o.spend.note).toContain('1 of 65');
  });

  test('a floor numerator and an unsettled denominator move the figure in opposite directions — so neither bound is claimed', () => {
    const o = compute(mixedWindow(), spend({ reviewsMissingCost: 2 }));
    expect(o.spend.numeratorState).toBe('floor');
    expect(o.spend.denominatorState).toBe('will-grow');
    expect(o.spend.note).toContain('opposite directions');
    // The contradiction this whole finding was about: claiming the figure can
    // only fall while also disclosing that backfilling cost raises it.
    expect(o.spend.note).not.toContain('brings this figure down');
    expect(o.spend.note).toContain('rough reading, not a firm number');
  });

  test('a floor numerator with a settled denominator is a claim the figure is AT LEAST this much, not an upper one', () => {
    const o = compute([finding({ did: 'ADDRESSED' })], spend({ reviewsMissingCost: 1 }));
    expect(o.spend.denominatorState).toBe('settled');
    expect(o.spend.note).toContain('at least this much');
    expect(o.spend.note).not.toContain('at most this much');
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
      expect(o.traceabilityNote).toContain('1 of them is explained by not being tied to a specific file');
      expect(o.traceabilityNote).toContain('remaining 2 are not explained');
      expect(o.traceabilityNote).not.toContain('fully accounted for');
    });

    test('a wholly-unexplained gap does NOT state the file-anchor cause it just denied', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 0 });
      expect(o.traceability.reconciled).toBe(false);
      expect(o.traceabilityNote).toContain('None of that gap is explained by findings that were not tied to a specific file');
      // The cause sentence must not also appear — that was the contradiction.
      expect(o.traceabilityNote).not.toContain('explained by not being tied to a specific file');
      expect(o.traceabilityNote).not.toContain('0 of them');
    });

    // RULE 1 — "nothing recorded" is not "nothing happened". `untraceable` is
    // `max(readBandRaised, traced) - traced`: a difference between two counts,
    // never a property read off any one finding. The head used to say those
    // findings "have no comment thread in the pull request, so they were never
    // checked, and never can be" — a claim about what exists on the pull
    // request, asserted from a number this note's own tail then calls
    // unreconciled. A second mechanism breaks the row-to-thread match
    // independently of file anchoring (a substantially-reworded re-review forks
    // the identity key, ~stats.ts:1980), so the gap does not even entail a
    // missing thread when it IS reconciled — only the file-less count licenses
    // that, and it is the tail that carries it.
    //
    // Pinned whole rather than by substring: the property is what the sentence
    // claims, and a substring check cannot see an over-claim in the clause it
    // does not cover.
    test('the head claims only what a count difference establishes — never that the threads are missing', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 0 });
      expect(o.traceability.untraceable).toBe(3);
      expect(o.traceabilityNote).toBe(
        'This card cannot match 3 of 6 findings raised in this window to a comment thread in the pull request. ' +
          'They have no verdict here, and this card has no way to give them one. That gap is a difference between two ' +
          'counts, not a look at any single finding: on its own it does not establish that the threads are missing. ' +
          'They are counted in "raised" and in nothing else.' +
          ' None of that gap is explained by findings that were not tied to a specific file, which is the only cause ' +
          'this card knows about — the two sources are counting differently, and the gap should be reconciled before ' +
          'this line is quoted.',
      );
      expect(o.traceabilityNote).not.toContain('no comment thread in the pull request, so');
      expect(o.traceabilityNote).not.toContain('never checked, and never can be');
    });

    test('the singular head agrees, and still claims only the count difference', () => {
      const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 0 });
      expect(o.traceability.untraceable).toBe(1);
      expect(o.traceabilityNote).toContain('cannot match 1 of 2 findings raised in this window');
      expect(o.traceabilityNote).toContain('It has no verdict here, and this card has no way to give it one.');
      expect(o.traceabilityNote).not.toContain('It has no comment thread');
    });

    // The inversion branch reported the contradiction by glossing `untraceable`
    // as "the number with no comment thread in the pull request" — the same
    // unlicensed claim as the old head, one sentence later. The INFERENCE it
    // draws survives the reweaken: more file-less findings than the gap means at
    // least one file-less finding was matched to a thread anyway, which the
    // anchoring rule forbids.
    test('the inversion branch names the gap, not a thread count it cannot observe', () => {
      const o = computeReviewValue(rows(), spend(), { readBandRaised: 6, noFileAnchor: 5 });
      expect(o.traceabilityNote).toContain('than the size of that gap (3)');
      expect(o.traceabilityNote).not.toContain('the number with no comment thread in the pull request');
      expect(o.traceabilityNote).toContain('cannot happen');
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
      expect(o.traceabilityNote).not.toContain('can eventually be checked');
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
      expect(o.traceabilityNote).toContain('has a comment thread in the pull request');
      expect(o.traceabilityNote).toContain('counting differently');
    });

    test('zero raised says there is nothing to trace rather than that everything is traceable', () => {
      const o = computeReviewValue([], spend(), { readBandRaised: 0, noFileAnchor: 0 });
      expect(o.traceabilityNote).toContain('No findings were raised');
      expect(o.traceabilityNote).not.toContain('Every finding raised in this window');
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
    expect(o.traceabilityNote).toContain('every one of them can eventually be checked');
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
  test('the reproducibility limit names the totals as usable and one finding\'s verdict as not', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.reproducibilityNote).toContain('33%');
    expect(o.reproducibilityNote).toContain('totals');
  });

  test('the scope note says unsettled pull requests are excluded rather than counted as ignored', () => {
    const o = compute(mixedWindow(), spend());
    expect(o.scopeNote).toContain('merged or closed');
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
    expect(text).toContain('12 have not been judged yet, awaiting a code change to judge against');
  });

  test('separates "not yet" from "never" when some findings have no thread', () => {
    const o = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 3 },
    );
    const text = describeJudgedCoverage(o);
    expect(text).toContain('1 awaiting a code change to judge against');
    expect(text).toContain('3 that can never be judged (no comment thread in the pull request)');
  });

  test('with a single reason the count is stated once, not on both sides of a colon', () => {
    const o = compute([finding({ did: 'ADDRESSED' }), finding({ did: null }), finding({ did: null })], spend());
    const text = describeJudgedCoverage(o);
    expect(o.unjudgeable).toBe(2);
    expect(text).toContain('2 have not been judged yet, awaiting a code change to judge against');
    expect(text).not.toContain('2 have not been judged: 2 awaiting');
  });

  test('a zero clause is omitted, not rendered as "0 awaiting a code change"', () => {
    // Every traced row judged; the only unjudged findings are untraceable.
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 5, noFileAnchor: 4 });
    const text = describeJudgedCoverage(o);
    expect(o.awaitingDiff).toBe(0);
    expect(text).not.toContain('0 awaiting');
    expect(text).toContain('4 have not been judged and never can be: none of them has a comment thread in the pull request');
  });

  test('says so plainly when everything raised has been judged', () => {
    const text = describeJudgedCoverage(compute([finding({ did: 'ADDRESSED' })], spend()));
    expect(text).toContain('every finding raised in this window has been judged');
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

  // The row's `label` is the raw database value and STAYS one: it is what the
  // React `key` prop and these tests identify a row by, and a row identified by
  // its display text would need re-keying every time the wording changed. The
  // plain-English text is applied at the render site instead.
  test('the row label is the raw key — it identifies the row, it is not what is shown', () => {
    const rows = buildDidRows(compute(mixedWindow(), spend()));
    expect(rows.map((r) => r.label)).toEqual(['ADDRESSED', 'not', 'UNKNOWN', 'SPLIT']);
  });
});

// ---------------------------------------------------------------------------
// didVerdictText — the `did` breakdown's keys used to render straight into the
// first table on the card: `ADDRESSED / not / UNKNOWN / SPLIT`, three casing
// conventions in four rows, in a mono font, directly under the glossary that
// explains the card's words. The bare `not` read as a broken cell rather than
// as content. These are object KEYS, never string literals, which is why every
// prose sweep on this branch was structurally blind to them.
// ---------------------------------------------------------------------------

describe('didVerdictText', () => {
  // Driven off DID_LABELS rather than a hand-copied list, so adding a fifth
  // verdict to the database mapper fails here until it has words to render.
  test('every live `did` verdict has plain-English text', () => {
    expect(DID_LABELS.map(didVerdictText)).toEqual(['acted on', 'not acted on', 'could not tell', 'ballots disagreed']);
  });

  // "ballots", not "checks": the caption two lines under this same table says
  // "had all three ballots agree", and a second word for the same three votes
  // is the synonym-for-a-settled-term defect this branch keeps re-finding.
  test('SPLIT uses the same word for the three votes as the caption below the table', () => {
    const caption = describeVerdictCaption(compute(mixedWindow(), spend()));
    expect(caption).toContain('ballots');
    expect(didVerdictText('SPLIT')).toContain('ballots');
  });

  // `computeReviewValue` keeps an unrecognised database value as its own
  // breakdown row rather than dropping it (pinned above at 'SOMETHING-NEW'), so
  // the render must have something to show for it. Ugly beats missing.
  test('an unmapped key falls back to itself rather than rendering blank', () => {
    expect(didVerdictText('SOMETHING-NEW')).toBe('SOMETHING-NEW');
  });
});

describe('describeDisputed', () => {
  test("renders 'not yet measured' with a reason, never a zero", () => {
    const o = compute(mixedWindow(), spend());
    const line = describeDisputed(o.disputedAsWrong, o);
    expect(line.value).toBe('not yet measured');
    expect(line.value).not.toBe('0');
    // The SERVER's sentence, passed through verbatim — not `length > 0`, which
    // a hardcoded literal satisfies just as well. This branch renders in no
    // live window, so a break in the wiring would ship silently and
    // permanently, and it would defeat the stated property that the reason
    // lives in one place and cannot drift.
    // Checked non-null first, or `toBe` would pass on two empty strings and
    // the pass-through would be pinned against nothing.
    expect(o.disputedAsWrong.reason).not.toBeNull();
    expect(line.detail).toBe(o.disputedAsWrong.reason!);
    expect(line.detail.length).toBeGreaterThan(0);
    // 'attention' is asserted here only because `ScorecardFigure` now RENDERS
    // it as a modifier class — pinned by the structural test below. It was
    // previously set by every builder and read by nobody, so this assertion
    // guarded a field with no effect on what anyone sees.
    expect(line.status).toBe('attention');
  });

  test('renders the count as a count once measured, and says it is not a rate', () => {
    const o = compute([finding({ said: 'rejected-wrong' })], spend());
    const line = describeDisputed(o.disputedAsWrong, o);
    expect(line.value).toBe('1 of 1 said-labelled finding');
    expect(line.detail).toContain('not a rate');
    // A count, never a percentage: n is 2 in production and the study that
    // produced this taxonomy said in terms that a rate over single digits
    // overstates it. No branch of this line may render one.
    expect(line.value).not.toMatch(/%/);
    expect(line.detail).not.toMatch(/%/);
  });

  // -------------------------------------------------------------------------
  // THE DENOMINATOR. `2 of 72` and `2 of 139` are different claims and the
  // headline figure at the top of the card is the raised total (139 — 135 is
  // the TRACED count, one line lower), so a bare "2" invites the second
  // reading. Every assertion below is about which
  // population the figure is over.
  // -------------------------------------------------------------------------

  test('the denominator travels with the figure — the value is never a bare count', () => {
    // The live 30d/prod shape, scaled: 6 raised, 3 labelled, 2 disputed.
    const o = computeReviewValue(
      [finding({ said: 'rejected-wrong' }), finding({ said: 'rejected-wrong' }), finding({ said: 'fixed', did: 'ADDRESSED' })],
      spend(),
      { readBandRaised: 6, noFileAnchor: 3 },
    );
    const line = describeDisputed(o.disputedAsWrong, o);
    expect(line.value).toBe('2 of 3 said-labelled findings');
    expect(line.value).not.toBe('2');
    // Never over raised, which is the number sitting at the top of the card.
    expect(line.value).not.toContain('of 6');
    expect(line.detail).toContain('it is out of the 3 said-labelled findings');
    // The raised total is still stated — just not as this figure's denominator.
    expect(line.detail).toContain('The other 3 raised findings have no said label at all');
  });

  test('the contrast clause is OMITTED when every raised finding carries a label', () => {
    // The live Test population: 2 raised, 2 traced, both labelled. "That is not
    // all 2 raised" is simply false there — the same unbranched-clause defect
    // the engagement line was corrected for, on the line next to it.
    const o = compute([finding({ said: 'fixed', did: 'UNKNOWN' }), finding({ said: 'fixed', did: 'not' })], spend());
    expect(o.disputedAsWrong.saidRecorded).toBe(o.findingsRaised);
    const line = describeDisputed(o.disputedAsWrong, o);
    expect(line.detail).not.toContain('The other');
    expect(line.detail).not.toContain('raised finding');
  });

  test('the contrast clause states only that the rest are unlabelled, never WHY', () => {
    // The gap has several causes (nothing written to read, a tied tally, no
    // thread at all) and the table cannot say which applies to a given
    // finding. Naming one is the unestablished-cause claim the coverage line
    // was corrected for.
    const o = computeReviewValue([finding({ said: 'fixed' })], spend(), { readBandRaised: 4, noFileAnchor: 2 });
    const detail = describeDisputed(o.disputedAsWrong, o).detail;
    expect(detail).toContain('have no said label at all, which is not the same as having no dispute');
    expect(detail).not.toContain('nobody wrote');
    expect(detail).not.toContain('no thread');
  });

  test('a measured zero says it is a measured zero, and does not read as the not-measured line', () => {
    const o = compute([finding({ said: 'fixed' }), finding({ said: 'ignored' })], spend());
    const line = describeDisputed(o.disputedAsWrong, o);
    expect(o.disputedAsWrong.count).toBe(0);
    expect(line.value).toBe('0 of 2 said-labelled findings');
    expect(line.value).not.toBe('not yet measured');
    expect(line.detail).toContain('This is a real zero, not a gap in the data');
    // ...and it is NOT dressed as the absence of a measurement.
    expect(line.status).toBe('neutral');
  });

  test('the value form cannot be read as "0 of 2 HAVE a said label"', () => {
    // "0 of 2 with a said label" — the engagement line's shape — parses just
    // as easily as the not-measured claim. The adjective form does not: both
    // parses of "0 of 2 said-labelled findings" mean the same thing.
    const o = compute([finding({ said: 'fixed' }), finding({ said: 'ignored' })], spend());
    expect(describeDisputed(o.disputedAsWrong, o).value).not.toContain('with a said label');
  });

  test('a denominator of 1 reads as English, and "of 0" is unreachable', () => {
    const one = compute([finding({ said: 'rejected-wrong' })], spend());
    expect(describeDisputed(one.disputedAsWrong, one).value).toBe('1 of 1 said-labelled finding');
    expect(describeDisputed(one.disputedAsWrong, one).detail).toContain('the 1 said-labelled finding');
    // `measured` IS `saidRecorded > 0`, so the measured branch can never
    // divide by an empty population — the engagement line's "no readable
    // signal" escape hatch has nothing to guard here.
    const none = compute([finding({ said: null })], spend());
    expect(none.disputedAsWrong.measured).toBe(false);
    expect(describeDisputed(none.disputedAsWrong, none).value).toBe('not yet measured');
  });

  test('the fraction cannot invert — a disputed row carries a label by definition', () => {
    for (const rows of [
      [finding({ said: 'rejected-wrong' })],
      [finding({ said: 'rejected-wrong' }), finding({ said: 'rejected-wrong' }), finding({ said: null })],
      [finding({ said: 'fixed' }), finding({ said: 'rejected-wrong' })],
    ]) {
      const d = compute(rows, spend()).disputedAsWrong;
      expect(d.count!).toBeLessThanOrEqual(d.saidRecorded);
    }
  });

  // -------------------------------------------------------------------------
  // The `did` cross-tab. Both disputed findings in production carry `did =
  // null`: the team said the finding was wrong and no diff has been judged
  // against it. Disclosed as a limitation, and only where there is one.
  // -------------------------------------------------------------------------

  test('all-unjudged reads "none of them", and claims only that no diff was judged', () => {
    const o = compute([finding({ said: 'rejected-wrong' }), finding({ said: 'rejected-wrong' })], spend());
    const caveat = describeDisputed(o.disputedAsWrong, o).caveat!;
    expect(o.disputedAsWrong.unjudged).toBe(2);
    expect(caveat).toContain('None of the 2 findings disputed here has a verdict on the diff');
    expect(caveat).toContain('cannot say whether the branch acted on any of them anyway');
    // It must NOT promote "no verdict" into "the branch ignored it".
    expect(caveat).not.toContain('ignored');
    expect(caveat).not.toContain('was not acted on');
  });

  test('one disputed and unjudged reads as English, not "1 of the 1 findings"', () => {
    const o = compute([finding({ said: 'rejected-wrong' })], spend());
    const caveat = describeDisputed(o.disputedAsWrong, o).caveat!;
    expect(caveat).toBe(
      'The finding disputed here has no verdict on the diff, so this card cannot say whether the branch acted on it anyway.',
    );
  });

  test('a partly-judged cross-tab names both parts', () => {
    const o = compute([finding({ said: 'rejected-wrong' }), finding({ said: 'rejected-wrong', did: 'not' })], spend());
    const caveat = describeDisputed(o.disputedAsWrong, o).caveat!;
    expect(o.disputedAsWrong.unjudged).toBe(1);
    expect(caveat).toContain('1 of the 2 findings disputed here has no verdict on the diff');
  });

  test('the cross-tab is OMITTED when every disputed finding has a verdict — a zero limitation is not a limitation', () => {
    const o = compute(
      [finding({ said: 'rejected-wrong', did: 'not' }), finding({ said: 'rejected-wrong', did: 'ADDRESSED' })],
      spend(),
    );
    expect(o.disputedAsWrong.unjudged).toBe(0);
    expect(describeDisputed(o.disputedAsWrong, o).caveat).toBeNull();
  });

  test('the cross-tab is OMITTED at a measured zero — there are no disputed findings to cross-tab', () => {
    const o = compute([finding({ said: 'fixed' })], spend());
    expect(o.disputedAsWrong.count).toBe(0);
    expect(o.disputedAsWrong.unjudged).toBe(0);
    expect(describeDisputed(o.disputedAsWrong, o).caveat).toBeNull();
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
    expect(line.detail).toContain('the sum shown is not complete');
    expect(line.detail).toContain('at least this much');
    expect(line.detail).toContain('1 of 65');
  });

  test('the per-item branch states the missing-cost fact ONCE, in the caveat, not also in the detail', () => {
    const o = compute(mixedWindow(), spend({ totalCostUsd: 200, reviewCount: 65, reviewsMissingCost: 1 }));
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.caveat).toContain('has no recorded cost');
    expect(line.caveat).not.toContain('has a recorded cost');
    // Said once, not twice: the detail no longer repeats it.
    expect(line.detail).not.toContain('has no recorded cost');
    const occurrences = (`${line.detail} ${line.caveat}`.match(/\b(?:has|have) no recorded cost\b/g) ?? []).length;
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
    expect(line.caveat).toContain('1 traced finding has no engagement signal');
    expect(line.caveat).toContain('3 raised findings have no thread at all');
  });

  test('silently fixed explains that these are invisible to reply-based measures', () => {
    const line = describeSilentlyFixed(compute(mixedWindow(), spend()));
    expect(line.value).toBe('1');
    expect(line.detail).toContain('nobody said a word');
  });

  // The heading read "Silently fixed" over a body beginning "Confirmed ACTED ON
  // with no reply". The figure is `did === 'ADDRESSED'`, which is exactly the
  // condition that licenses "acted on" and forbids "fixed" — the branch's own
  // vocabulary rule, and the counter-example to the ledger line claiming this
  // codebase never says "fixed". Heading and body now use one word.
  test('the heading says what the figure counts, in the same word its own body uses', () => {
    const line = describeSilentlyFixed(compute(mixedWindow(), spend()));
    expect(line.label).toBe('Acted on with no reply');
    expect(line.label).not.toContain('fixed');
    expect(line.detail).toContain('Confirmed acted on');
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
    expect(text).toContain('no median to report');
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
    expect(v.message).toContain('merged or closed');
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
      describeDisputed(o.disputedAsWrong, o),
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
    // The disputed line's own strings only exist on the MEASURED branch, and
    // every case above leaves `said` null, so without these the sweep renders
    // "not yet measured" and checks none of them. Three shapes: one of
    // everything; one where the counts differ so the fraction and the contrast
    // clause both have to agree; and one at a measured zero.
    ['everything at 1, said label present, disputed and unjudged', computeReviewValue(
      [finding({ did: null, said: 'rejected-wrong', saidEvidence: 'thread-reply', leadTimeMins: 5 })],
      { totalCostUsd: 100, reviewCount: 1, reviewsMissingCost: 1 },
      { readBandRaised: 1, noFileAnchor: 0 },
    )],
    ['1 disputed of 2 labelled of 3 raised, one unjudged', computeReviewValue(
      [finding({ did: null, said: 'rejected-wrong', saidEvidence: 'thread-reply' }), finding({ did: 'not', said: 'fixed', saidEvidence: 'thread-reply' })],
      spend({ reviewCount: 1 }),
      { readBandRaised: 3, noFileAnchor: 1 },
    )],
    ['a measured zero at a denominator of 1', computeReviewValue(
      [finding({ did: 'ADDRESSED', said: 'fixed', saidEvidence: 'thread-reply' })],
      spend({ reviewCount: 1 }),
      { readBandRaised: 2, noFileAnchor: 1 },
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
    expect(BAD_AGREEMENT.test('1 of 65 reviews have no recorded cost')).toBe(true);
    expect(BAD_AGREEMENT.test('1 finding are excluded')).toBe(true);
    expect(BAD_AGREEMENT.test('The remaining 1 are not explained')).toBe(true);
    expect(BAD_AGREEMENT.test('1 of them were recorded')).toBe(true);
    // ...and does not fire on the corrected forms.
    expect(BAD_AGREEMENT.test('1 of 65 reviews has no recorded cost')).toBe(false);
    expect(BAD_AGREEMENT.test('The remaining 1 is not explained')).toBe(false);
    expect(BAD_AGREEMENT.test('2 findings are excluded')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Individual clauses whose singular form flips a NEGATION, not just a verb —
// these cannot be caught by an agreement regex.
// ---------------------------------------------------------------------------

describe('negation survives the singular form', () => {
  test('one untraceable finding "has NO comment thread", not "has a comment thread"', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 1 });
    const text = describeJudgedCoverage(o);
    expect(text).toContain('it has no comment thread in the pull request');
    expect(text).not.toContain('it has a comment thread in the pull request');
  });

  test('many untraceable findings read "none of them has a comment thread"', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 3, noFileAnchor: 2 });
    expect(describeJudgedCoverage(o)).toContain('none of them has a comment thread in the pull request');
  });
});

// ---------------------------------------------------------------------------
// Clauses that must not reference a quantity the sentence before them denied
// ---------------------------------------------------------------------------

describe('no clause points at a figure that does not exist', () => {
  test('with no before-settle findings the after-settle clause does not cite "that median"', () => {
    const o = compute([finding({ leadTimeMins: -10 }), finding({ leadTimeMins: -20 })], spend());
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('no median to report');
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

  test('zero raised is not reported as "every finding has been judged"', () => {
    const o = computeReviewValue([], spend(), { readBandRaised: 0, noFileAnchor: 0 });
    const text = describeJudgedCoverage(o);
    expect(text).toBe('No findings were raised in this window.');
  });

  // -------------------------------------------------------------------------
  // ENTAILMENT, not agreement: does the sentence claim more than its gating
  // condition establishes? A clause can be perfectly pluralised and still
  // assert something the branch does not prove, which is why the count sweep
  // above cannot catch these.
  // -------------------------------------------------------------------------

  test('the verdict caption claims nothing about what the NON-unanimous rows were', () => {
    // `did_confidence` has five values (unanimous | majority | split |
    // single-vote | none). `unanimous` licenses no claim about the rest, and
    // a judged SPLIT row makes "every one reached only a majority" flatly
    // contradict the verdict table two lines above it.
    const oneSplit = compute([finding({ did: 'SPLIT', didConfidence: 'split' })], spend());
    expect(oneSplit.didBreakdown['SPLIT']).toBe(1);
    const caption = describeVerdictCaption(oneSplit);
    expect(caption).not.toContain('majority');
    expect(caption).toContain('No judged row had all three ballots agree');

    const mixedConfidences = compute([
      finding({ did: 'ADDRESSED', didConfidence: 'unanimous' }),
      finding({ did: 'SPLIT', didConfidence: 'split' }),
      finding({ did: 'not', didConfidence: 'single-vote' }),
    ], spend());
    const mixedCaption = describeVerdictCaption(mixedConfidences);
    expect(mixedCaption).toContain('the other 2 did not');
    expect(mixedCaption).not.toContain('majority');
  });

  test('the lead-time head is scoped to RECORDED lead times, not to every finding', () => {
    // b === 0 establishes only that no finding WITH a recorded lead time was
    // raised before settle. Claiming it of every finding is contradicted by
    // the unrecorded clause in the same sentence.
    const o = compute([
      finding({ leadTimeMins: -30 }),
      finding({ leadTimeMins: null }),
      finding({ leadTimeMins: null }),
    ], spend());
    expect(o.leadTime.beforeSettleCount).toBe(0);
    expect(o.leadTime.unrecordedCount).toBe(2);
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('No finding with a recorded lead time was raised before its PR settled');
    expect(text).not.toContain('No finding in this window was raised before its PR settled');
    // ...and the sentence that contradicted it still appears, scoped.
    expect(text).toContain('2 findings have no lead time recorded at all');
  });

  test('with NO lead time recorded anywhere, the head says that rather than asserting about settle order', () => {
    const o = compute([finding({ leadTimeMins: null }), finding({ leadTimeMins: null })], spend());
    const text = describeLeadTime(o.leadTime);
    expect(text).toContain('No finding in this window has a lead time recorded');
    expect(text).not.toContain('raised before its PR settled, so there is no median');
  });

  test('coverage does not assert a CAUSE for untraceability the card says is not established', () => {
    // reconciled === false means the traceability note two lines above says
    // in terms that the gap is not understood. Asserting "(no comment thread
    // in the pull request)" beside it claimed a cause the card had just
    // disclaimed.
    const unreconciled = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 0 },
    );
    expect(unreconciled.traceability.reconciled).toBe(false);
    const text = describeJudgedCoverage(unreconciled);
    expect(text).not.toContain('comment thread');
    expect(text).toContain('reason not established');

    // ...and when it DOES reconcile, the cause is stated.
    const reconciled = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 3 },
    );
    expect(reconciled.traceability.reconciled).toBe(true);
    expect(describeJudgedCoverage(reconciled)).toContain('no comment thread in the pull request');
  });

  test('the single-reason coverage clause also withholds an unestablished cause', () => {
    const o = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 3, noFileAnchor: 0 });
    expect(o.awaitingDiff).toBe(0);
    expect(o.traceability.reconciled).toBe(false);
    const text = describeJudgedCoverage(o);
    expect(text).toContain('for a reason this card has not established');
    expect(text).not.toContain('comment thread');
  });

  test('unrecorded cost is reported as missing data, never as $0.00 per acted-on', () => {
    // Every review on these PRs has a null cost. Dividing an unrecorded sum
    // renders "$0.00 per acted-on", which asserts the reviews were free — the
    // same error as reporting an unmeasured dispute count as 0.
    const o = compute([finding({ did: 'ADDRESSED' })], spend({ totalCostUsd: 0, reviewCount: 4, reviewsMissingCost: 4 }));
    expect(o.spend.costPerAddressed).toBeNull();
    const line = describeSpend(o.spend, o.addressed, o);
    expect(line.value).toBe('not recorded');
    expect(line.value).not.toContain('$0.00');
    expect(line.detail).toContain('missing data, not a measured zero');
  });

  test('a partially-recorded cost still yields a figure — only a WHOLLY unrecorded one does not', () => {
    const o = compute([finding({ did: 'ADDRESSED' })], spend({ totalCostUsd: 50, reviewCount: 4, reviewsMissingCost: 3 }));
    expect(o.spend.costPerAddressed).toBe(50);
    expect(describeSpend(o.spend, o.addressed, o).value).toBe('$50.00 per acted-on');
  });

  test('the disputed line claims nothing about how large n is', () => {
    const o = compute([finding({ said: 'rejected-wrong' })], spend());
    const line = describeDisputed(o.disputedAsWrong, o);
    // "n is small enough that a percentage would overstate it" is a claim
    // about a population that does not exist yet, and false at any scale.
    expect(line.detail).not.toContain('small enough');
    expect(line.detail).toContain('Reported as a count, not a rate');
  });

  // -------------------------------------------------------------------------
  // BRANCH ORDER. These three states satisfy TWO branch conditions at once, so
  // which one fires is decided by sequence rather than by the conditions
  // themselves. Nothing in the types or the conditions stops a refactor
  // reordering them, so each is pinned by the sentence only the correct order
  // produces. Every one of these was verified to fail with the branches
  // swapped before being committed.
  // -------------------------------------------------------------------------

  test('ORDER: all-costs-missing is tested BEFORE the null check, or missing data reads as no action', () => {
    // Both null causes live at once: every review lacks a cost AND nothing is
    // confirmed acted on. `costPerAddressed` is null either way, so the branch
    // that fires is purely a matter of sequence.
    const o = compute([finding({ did: 'not' })], spend({ totalCostUsd: 0, reviewCount: 4, reviewsMissingCost: 4 }));
    expect(o.addressed).toBe(0);
    expect(o.spend.costPerAddressed).toBeNull();
    expect(o.spend.reviewsMissingCost).toBe(o.spend.reviewCount);

    const line = describeSpend(o.spend, o.addressed, o);
    // Correct order describes the MISSING DATA.
    expect(line.value).toBe('not recorded');
    expect(line.detail).toContain('missing data, not a measured zero');
    // Swapped order would describe the ABSENCE OF ACTION and print a
    // measured-looking total — a card whose whole purpose is not doing that.
    expect(line.value).not.toBe('$0.00');
    expect(line.detail).not.toContain('Nothing is confirmed acted on');
  });

  test('ORDER: awaiting-a-diff is tested BEFORE the unreconciled check, or a diff-wait reads as unexplainable', () => {
    // untraceable === 0 with noFileAnchor > 0 makes `reconciled` false, while
    // the only actual reason anything is unjudged is that it awaits a code
    // change.
    const o = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 2, noFileAnchor: 1 },
    );
    expect(o.traceability.untraceable).toBe(0);
    expect(o.traceability.reconciled).toBe(false);
    expect(o.awaitingDiff).toBe(1);

    const text = describeJudgedCoverage(o);
    expect(text).toContain('awaiting a code change to judge against');
    expect(text).not.toContain('for a reason this card has not established');
  });

  test('ORDER: judged===0 is tested BEFORE the all-unanimous check, or zero rows read as unanimous', () => {
    // judged === 0 also makes `judged - unanimous === 0`, so the
    // all-unanimous branch would claim agreement across an empty set.
    const o = compute([finding({ did: null }), finding({ did: null })], spend());
    expect(o.judged).toBe(0);
    expect(o.unanimous).toBe(0);

    const caption = describeVerdictCaption(o);
    expect(caption).toBe('Shares are over the 0 JUDGED findings, not over all 2 raised.');
    expect(caption).not.toContain('Every judged row had all three ballots agree');
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
    expect(describeVerdictCaption(mixed)).toContain('the other 1 did not');
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
      describeDisputed(o.disputedAsWrong, o),
    ];
    expect(lines.filter((l) => l.status === 'attention').map((l) => l.label)).toEqual(['Disputed as factually wrong']);
  });

  // The 'attention' treatment marks "this is not a measurement". Once the said
  // sweep populates a window, the disputed line IS a measurement — including
  // when it measures zero — and keeping the accent on it would say the
  // opposite of what the data now supports.
  test("a MEASURED disputed line drops 'attention' — including at a measured zero", () => {
    const disputed = compute([finding({ said: 'rejected-wrong' })], spend());
    expect(describeDisputed(disputed.disputedAsWrong, disputed).status).toBe('neutral');
    const zero = compute([finding({ said: 'fixed' })], spend());
    expect(describeDisputed(zero.disputedAsWrong, zero).status).toBe('neutral');
  });

  test('ScorecardLine.status is actually rendered — a builder-only field would make the flag decorative', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    expect(cardSrc).toContain('review-value-figure--${line.status}');
  });

  // `didVerdictText`'s value tests above prove the map is right; only the source
  // proves the table USES it. The raw key rendered here for the whole life of
  // the card and no value test could see it, because the mapping did not exist
  // to be called.
  test('the verdict table renders the plain text, never the raw database key', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    expect(cardSrc).toContain('{didVerdictText(r.label)}');
    expect(cardSrc).not.toContain('>{r.label}<');
  });

  // `describeJudgedCoverage`'s zero-raised branch dropped the "read-band"
  // qualifier ("No findings were raised…", not "No read-band findings…").
  // The ONLY thing still scoping that sentence to critical/major problems is
  // the `a finding` glossary entry — nothing in `glossaryText`'s own test
  // suite (`tests/dashboard/card-glossary.test.ts`) knows this card declares
  // it or renders it, so deleting `TERMS` here would leave the suite green
  // on an unscoped false claim. Both pinned, source-text, same style as the
  // `ScorecardLine.status` guard above.
  test('the glossary term list still defines "a finding" — the word the zero-raised sentence relies on', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    expect(cardSrc).toContain("term: 'a finding'");
  });

  test('the glossary is not just declared but actually rendered on the panel', () => {
    const cardSrc = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/client/components/stats-review-value.tsx', import.meta.url)),
      'utf-8',
    );
    expect(cardSrc).toContain('<CardGlossary terms={TERMS} />');
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
    // A `not.toMatch(/replace\([^)]*'\\'[^\\]/)` used to sit here. It could
    // never fire: `[^)]*` cannot cross the `)` in `btrim(f->>'file')`, so it
    // did not match the regressed text either. Deleted rather than repaired —
    // the positive assertion above already fails on the collapse, and a line
    // that cannot fail reads as protection while being none.
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

// ---------------------------------------------------------------------------
// Plain-English rewrite pins. Full-string `toBe` (not `toContain`) on every
// sentence rewritten in this round, printed at n=0 (where the branch has one),
// n=1, n=2, and — for `describeJudgedCoverage` — at judged === findingsRaised,
// the "compared quantities are equal" case for that sentence.
// ---------------------------------------------------------------------------

describe('plain-English rewrite pins', () => {
  test('engagement: nothing recorded reads as absence of a record, not absence of a reply', () => {
    const o = compute([finding({ saidEvidence: 'stale-signal' })], spend());
    expect(o.engagement.engagedRate).toBeNull();
    expect(describeEngagement(o.engagement, o).detail).toBe(
      'Nothing was recorded about replies for any of these, so this card cannot say whether anyone responded.',
    );
  });

  test('disputed: a measured zero is scoped to the problems the team gave an answer on, at denominators 1 and 2', () => {
    const one = compute([finding({ said: 'fixed' })], spend());
    expect(describeDisputed(one.disputedAsWrong, one).detail).toBe(
      'This is a real zero, not a gap in the data: the one problem the team gave an answer on was not disputed ' +
        'as wrong. Reported as a count, not a rate: it is out of the 1 said-labelled finding.',
    );
    const two = compute([finding({ said: 'fixed' }), finding({ said: 'ignored' })], spend());
    expect(describeDisputed(two.disputedAsWrong, two).detail).toBe(
      'This is a real zero, not a gap in the data: none of the problems the team gave an answer on was disputed ' +
        'as wrong. Reported as a count, not a rate: it is out of the 2 said-labelled findings.',
    );
  });

  test('addressed: the judged-rate clause names its own denominator, at equal and unequal counts', () => {
    const equal = compute([finding({ did: 'ADDRESSED' })], spend());
    expect(describeAddressed(equal).detail).toContain(
      'the first counts only the problems we could check, the second is diluted by every finding not yet judged.',
    );
    const unequal = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: 'not' })],
      spend(),
      { readBandRaised: 4, noFileAnchor: 0 },
    );
    expect(describeAddressed(unequal).detail).toContain(
      'the first counts only the problems we could check, the second is diluted by every finding not yet judged.',
    );
  });

  test('empty panel: scope is severity and settle-state, worded without "settled"', () => {
    const v = buildReviewValuePanelView({ status: 'empty' });
    expect(v.message).toBe(
      'No classified findings in this window. Reviews may still have run — this table holds only critical and ' +
        'major problems on pull requests that have been merged or closed, and only once a scheduled job has ' +
        'checked them.',
    );
  });

  test('judged coverage n=0: zero raised', () => {
    const o = computeReviewValue([], spend(), { readBandRaised: 0, noFileAnchor: 0 });
    expect(describeJudgedCoverage(o)).toBe('No findings were raised in this window.');
  });

  test('judged coverage: fully judged (compared quantities equal) at n=1 and n=2', () => {
    const one = compute([finding({ did: 'ADDRESSED' })], spend());
    expect(describeJudgedCoverage(one)).toBe('1/1 findings judged (100.0%) — every finding raised in this window has been judged.');
    const two = compute([finding({ did: 'ADDRESSED' }), finding({ did: 'not' })], spend());
    expect(describeJudgedCoverage(two)).toBe('2/2 findings judged (100.0%) — every finding raised in this window has been judged.');
  });

  test('judged coverage: awaiting-a-code-change only, at n=1 and n=2', () => {
    const one = compute([finding({ did: 'ADDRESSED' }), finding({ did: null })], spend());
    expect(describeJudgedCoverage(one)).toBe('1/2 findings judged (50.0%) — 1 has not been judged yet, awaiting a code change to judge against.');
    const two = compute([finding({ did: 'ADDRESSED' }), finding({ did: null }), finding({ did: null })], spend());
    expect(describeJudgedCoverage(two)).toBe('1/3 findings judged (33.3%) — 2 have not been judged yet, awaiting a code change to judge against.');
  });

  test('judged coverage: untraceable and reconciled, at n=1 and n=2', () => {
    const one = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 1 });
    expect(describeJudgedCoverage(one)).toBe(
      '1/2 findings judged (50.0%) — 1 has not been judged and never can be: it has no comment thread in the pull request.',
    );
    const two = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 3, noFileAnchor: 2 });
    expect(describeJudgedCoverage(two)).toBe(
      '1/3 findings judged (33.3%) — 2 have not been judged and never can be: none of them has a comment thread in the pull request.',
    );
  });

  test('judged coverage: untraceable and unreconciled, at n=1 and n=2', () => {
    const one = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 2, noFileAnchor: 0 });
    expect(describeJudgedCoverage(one)).toBe(
      '1/2 findings judged (50.0%) — 1 has not been judged and never can be, for a reason this card has not established (see the caveat above).',
    );
    const two = computeReviewValue([finding({ did: 'ADDRESSED' })], spend(), { readBandRaised: 3, noFileAnchor: 0 });
    expect(describeJudgedCoverage(two)).toBe(
      '1/3 findings judged (33.3%) — 2 have not been judged and never can be, for a reason this card has not established (see the caveat above).',
    );
  });

  test('judged coverage: two reasons at once, n=4', () => {
    const o = computeReviewValue(
      [finding({ did: 'ADDRESSED' }), finding({ did: null })],
      spend(),
      { readBandRaised: 5, noFileAnchor: 3 },
    );
    expect(describeJudgedCoverage(o)).toBe(
      '1/5 findings judged (20.0%) — 4 have not been judged: 1 awaiting a code change to judge against, 3 that can never be judged (no comment thread in the pull request).',
    );
  });

  test('spend floor clause: has/have agreement at missing=1 and missing=2, using the shared "no recorded cost" phrase', () => {
    const one = compute([finding({ did: null })], spend({ totalCostUsd: 40, reviewCount: 65, reviewsMissingCost: 1 }));
    expect(describeSpend(one.spend, one.addressed, one).detail).toBe(
      '$40.00 across 65 reviews on the PRs these findings came from. Nothing is confirmed acted on in this window, ' +
        'so there is no per-item figure to report. 1 of 65 reviews has no recorded cost, so the sum shown is not ' +
        'complete: the real total is at least this much.',
    );
    const two = compute([finding({ did: null })], spend({ totalCostUsd: 40, reviewCount: 65, reviewsMissingCost: 2 }));
    expect(describeSpend(two.spend, two.addressed, two).detail).toBe(
      '$40.00 across 65 reviews on the PRs these findings came from. Nothing is confirmed acted on in this window, ' +
        'so there is no per-item figure to report. 2 of 65 reviews have no recorded cost, so the sum shown is not ' +
        'complete: the real total is at least this much.',
    );
  });
});
