import { reviewValueStats, statsWindow } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { ReviewValueStats, ReviewValueOutcome, ReviewValueEngagement, ReviewValueDisputed, ReviewValueLeadTime, ReviewValueSpend } from '../../stats.ts';
import { formatCost, formatPct } from '../format.ts';
import { countOf, agree, itThem } from '../../count-phrase.ts';
import { CardGlossary } from './card-glossary.tsx';
import type { GlossaryTerm } from './card-glossary.tsx';

// This card's own short vocabulary. "settled" also covers describeLeadTime's
// PR-settled prose below — if a future edit removes the word "settled" from
// every sentence on this card, drop that entry too, or the glossary defines a
// word the card no longer uses.
const TERMS: readonly GlossaryTerm[] = [
  { term: 'a finding', plain: 'a problem the reviewer flagged as critical or major' },
  { term: 'settled', plain: 'the pull request has been merged or closed' },
];

// ---------------------------------------------------------------------------
// Review value — the Stats tab's fifth slot. Answers "what did PR review
// actually buy us" from `finding_outcomes` (see getReviewValueStats in
// src/dashboard/stats.ts for what that table holds and how it is windowed).
//
// Same outer `stats-slot stats-slot--{status}` wrapper and header markup as
// the four incumbent slots, so the loading/error border-colour CSS carries
// over unchanged. Unlike Cost & Quality this slot reads ONE fetch, so there is
// no `worstStatus` fold — its panel status is that single fetch's status,
// matching Integrity/Config's simpler shape.
//
// Unit convention, same as stats-costquality.tsx: a value computed as a 0..1
// FRACTION is rendered by CALLING `formatPct` (format.ts), never by
// re-deriving `(x*100).toFixed(1)+'%'` here. Every rate on the wire from
// `computeReviewValue` is already a 0..1 fraction or null — there is no
// server field on this endpoint scaled 0..100, so this file needs no
// `formatPctValue` counterpart.
//
// Three presentation rules this card exists to enforce, each a
// misreading that would otherwise be easy:
//
//  R1. NO BARE RATE. "Confirmed acted on" has two true rates with different
//      denominators (over judged rows, and over all rows raised) that differ
//      by a large factor. `describeAddressed` prints BOTH as explicit
//      `n of m` fractions with the denominator NAMED in each, and coverage
//      renders immediately beside them. A reader must not be able to carry
//      away a percentage without knowing what it was over.
//  R2. NOT MEASURED IS NOT ZERO, AND IT HAS ITS OWN DENOMINATOR. "Disputed as
//      factually wrong" reads the `said` column, which most rows will never
//      carry — a said ballot is only cast where a human wrote something. A
//      window with no labelled row renders as an explicit "not yet measured"
//      line with its reason, never as 0, which would assert nobody disputed
//      anything. A window WITH labelled rows renders a COUNT, never a rate,
//      over the rows carrying a label — not over all findings raised, which is
//      a much larger and different number sitting on the same card (R1's
//      hazard again, on the one line where the two are furthest apart).
//  R3. NO TREND ARROWS. The per-acted-on cost is not comparable with the Cost
//      panel's per-read-band-item figure (different denominators), so nothing
//      on this card compares the two directionally. The server's own
//      `spend.note` says why, and is rendered verbatim.
// ---------------------------------------------------------------------------

type PanelStatus = 'loading' | 'error' | 'empty' | 'ready';
type SectionStatus = 'ok' | 'attention' | 'neutral';

// ---------------------------------------------------------------------------
// Pure view-model builders — exported for unit testing, no JSX, no signals.
// ---------------------------------------------------------------------------

/** A headline figure and the sentence that keeps it honest. `caveat` is
 *  rendered under the figure with the shared "Known instrument caveat:" tag
 *  when present, matching stats-costquality.tsx's convention exactly. */
export interface ScorecardLine {
  label: string;
  value: string;
  detail: string;
  caveat: string | null;
  status: SectionStatus;
}

/** R1. Both denominators, both named, in one sentence each — never a lone
 *  percentage. The judged rate leads because it is the one that answers "of
 *  the findings we could check, how many were acted on"; the raised rate
 *  follows because it is what a reader would otherwise compute wrongly in
 *  their head from the two headline counts sitting next to each other. */
export function describeAddressed(o: ReviewValueOutcome): ScorecardLine {
  if (o.judged === 0) {
    return {
      label: 'Confirmed acted on',
      value: `${o.addressed}`,
      detail:
        `No finding in this window has been judged yet (0 of ${o.findingsRaised} raised), so there is no rate to ` +
        'report — not a rate of zero.',
      caveat: null,
      status: 'neutral',
    };
  }
  return {
    label: 'Confirmed acted on',
    value: `${o.addressed} of ${o.judged} judged`,
    detail:
      `${formatPct(o.addressedRateOfJudged)} of JUDGED findings (${o.addressed}/${o.judged}) · ` +
      `${formatPct(o.addressedRateOfRaised)} of ALL findings raised (${o.addressed}/${o.findingsRaised}). ` +
      'Both are true and they measure different things: the first counts only the problems we could check, ' +
      'the second is diluted by every finding not yet judged.',
    caveat: null,
    status: 'neutral',
  };
}

/** Coverage — how much of the window has been judged at all. Rendered
 *  immediately beside the acted-on figure (R1), not in a footnote. */
export function describeJudgedCoverage(o: ReviewValueOutcome): string {
  // Zero raised is not "everything has been judged" — there is nothing to
  // judge. Rendered "0/0 findings judged (n/a) — every finding raised in this
  // window has been judged", which is vacuously true and reads as
  // reassurance.
  if (o.findingsRaised === 0) return 'No findings were raised in this window.';
  const head = `${o.judged}/${o.findingsRaised} findings judged (${formatPct(o.judgedCoverage)})`;
  if (o.unjudgeable === 0) return `${head} — every finding raised in this window has been judged.`;
  // "Not yet" and "never" are different facts and are never summed into one
  // number here: `awaitingDiff` will eventually be judged, `untraceable`
  // never will be. Each clause is omitted at zero rather than rendered as
  // "0 awaiting a code change", which reads as a category that exists and is
  // empty when it is simply not the reason anything here is unjudged.
  // Entailment: the "no comment thread" CAUSE is only established when the
  // gap reconciles against the file-less count. When it does not, the
  // traceability note two lines above says in terms that the gap is not
  // understood — and this line was asserting a cause for it anyway, in the
  // same breath.
  const untraceableReason = o.traceability.reconciled ? 'no comment thread in the pull request' : 'reason not established — see the caveat above';
  const parts: string[] = [];
  if (o.awaitingDiff > 0) parts.push(`${o.awaitingDiff} awaiting a code change to judge against`);
  if (o.traceability.untraceable > 0) {
    parts.push(`${o.traceability.untraceable} that can never be judged (${untraceableReason})`);
  }
  // With ONE reason the count is not worth stating twice — "28 have not been
  // judged: 28 awaiting a code change" says the same number either side of a
  // colon. Each single-reason case gets its own sentence rather than one
  // template with the reason slotted in: "all that can never be judged" is
  // not English.
  const n = o.unjudgeable;
  if (parts.length === 1) {
    // The two singular/plural forms differ by more than a verb here — the
    // negation moves. `agree(n, 'it has', 'none of them has') + ' a comment
    // thread'` rendered "it HAS a comment thread" at n=1, the exact opposite
    // of the fact, which is why these are written out rather than assembled.
    // ORDER IS LOAD-BEARING: `untraceable === 0` with `noFileAnchor > 0`
    // makes `reconciled` false while the only real reason anything is
    // unjudged is that it is awaiting a code change. Testing the unreconciled
    // case first would call a plain wait unexplainable. Pinned by "ORDER:
    // awaiting-a-diff is tested BEFORE the unreconciled check".
    if (o.awaitingDiff > 0) {
      return `${head} — ${n} ${agree(n, 'has', 'have')} not been judged yet, awaiting a code change to judge against.`;
    }
    if (!o.traceability.reconciled) {
      return `${head} — ${n} ${agree(n, 'has', 'have')} not been judged and never can be, for a reason this card has not established (see the caveat above).`;
    }
    return `${head} — ${n} ${agree(n, 'has', 'have')} not been judged and never can be: ` +
      (n === 1 ? 'it has no comment thread in the pull request.' : 'none of them has a comment thread in the pull request.');
  }
  // Both parts non-empty here, so `n` is at least 2 and the plural is safe —
  // asserted by a test rather than left to this comment.
  return `${head} — ${n} have not been judged: ${parts.join(', ')}.`;
}

/** The `did` breakdown as ordered rows. Zero-count labels are KEPT: a missing
 *  `SPLIT` row would read as "ballots always agree", which is not what a zero
 *  means. Rate is over judged rows, never over all rows — the denominator is
 *  stated in the table's own caption at the call site. */
export function buildDidRows(o: ReviewValueOutcome): Array<{ label: string; count: number; rate: number | null }> {
  return Object.entries(o.didBreakdown).map(([label, count]) => ({
    label,
    count,
    rate: o.judged > 0 ? count / o.judged : null,
  }));
}

export function describeSilentlyFixed(o: ReviewValueOutcome): ScorecardLine {
  return {
    label: 'Silently fixed',
    value: `${o.silentlyFixed}`,
    detail:
      'Confirmed acted on with no reply on the thread and nothing in the PR discussion — the code changed and ' +
      'nobody said a word. These are invisible to any measure of review value based on replies alone.',
    caveat: null,
    status: 'neutral',
  };
}

/** The headline fraction and the rate MUST share a denominator. They used to
 *  not: the headline read `engaged of findingsRaised` while the rate divided
 *  by `engaged + silent`, which are equal only while nothing is unrecorded and
 *  nothing is untraceable — neither of which holds in production. Same defect
 *  `describeAddressed` exists to prevent, so it gets the same treatment: the
 *  headline states the denominator it actually used, and every population that
 *  is NOT in that denominator is named separately. */
export function describeEngagement(e: ReviewValueEngagement, o: ReviewValueOutcome): ScorecardLine {
  const denominator = e.engaged + e.silent;
  // The contrast clause is CONDITIONAL. Unbranched, it rendered "That is not
  // all 2 raised" on a window where it was exactly all 2 raised — the same
  // unbranched-clause-on-a-branching-figure shape as the spend caveat this
  // round already fixed, introduced by the fix for the denominator mismatch.
  const contrast =
    denominator < o.findingsRaised
      ? ` That is not all ${o.findingsRaised} raised: engagement is read off a finding's own thread.`
      : '';
  const detail =
    e.engagedRate == null
      ? 'Nothing was recorded about replies for any of these, so this card cannot say whether anyone responded.'
      : `${e.engaged} drew a written response (thread reply or PR discussion), ${e.silent} drew none — ` +
        `${formatPct(e.engagedRate)} of the ${countOf(denominator, 'finding')} where engagement could be read.${contrast}`;
  const missing: string[] = [];
  if (e.unrecorded > 0) {
    missing.push(
      `${countOf(e.unrecorded, 'traced finding')} ${agree(e.unrecorded, 'carries', 'carry')} no engagement signal ` +
      'this code classifies — in neither bucket, not folded into "no reply"',
    );
  }
  if (o.traceability.untraceable > 0) {
    const u = o.traceability.untraceable;
    missing.push(`${countOf(u, 'raised finding')} ${agree(u, 'has', 'have')} no thread at all to read engagement from`);
  }
  return {
    label: 'Human engagement',
    // States its OWN denominator, not the raised total. "0 of 0 with a
    // readable signal" is not a reading — it is the absence of one, and the
    // fraction form implies a population that does not exist.
    value: denominator === 0 ? 'no readable signal' : `${e.engaged} of ${denominator} with a readable signal`,
    detail,
    caveat: missing.length > 0 ? `${missing.join('; ')}.` : null,
    status: 'neutral',
  };
}

/** R2. Never a count when nothing measured it, and never a bare count when
 *  something did. The not-measured reason comes from the server
 *  (`disputedAsWrong.reason`) rather than being restated here, so there is one
 *  place it can drift from what a null `said` actually means.
 *
 *  Takes the whole outcome, not just the disputed sub-object, for the same
 *  reason `describeEngagement` does: the sentence has to name the denominator
 *  it did NOT use, and `findingsRaised` is the number a reader would otherwise
 *  divide by from the headline figure at the top of the card. */
export function describeDisputed(d: ReviewValueDisputed, o: ReviewValueOutcome): ScorecardLine {
  if (!d.measured) {
    return {
      label: 'Disputed as factually wrong',
      value: 'not yet measured',
      // Non-null exactly here, by the same construction that makes `count` and
      // `unjudged` non-null on the other branch — `reason` is null once
      // measured, because its clauses are only true while nothing is. Passed
      // through verbatim, never restated: this is the one place the sentence
      // exists, and a test pins the pass-through so a literal cannot be
      // substituted for it unnoticed.
      detail: d.reason!,
      caveat: null,
      status: 'attention',
    };
  }
  // `measured` is exactly `saidRecorded > 0`, so from here the denominator is
  // at least 1: the "n of m" form below can never render "of 0", and the
  // engagement line's "no readable signal" escape hatch is not needed. `count`
  // and `unjudged` are non-null on this branch by the same construction, and
  // `count <= saidRecorded` (a disputed row carries a label by definition), so
  // the fraction cannot invert either.
  const count = d.count!;
  const unjudged = d.unjudged!;

  // Conditional, and for the reason the engagement line's contrast clause is:
  // at equal quantities "that is not all N raised" is simply false, and the
  // Test population renders exactly that case today (2 raised, both labelled).
  // It states only that the remainder carry no label — NOT why. The gap has
  // several causes (nothing written, a tied tally, no thread at all) and this
  // card cannot tell which applies to any given finding, so naming one would
  // be the unestablished-cause claim the coverage line was corrected for.
  const unlabelled = o.findingsRaised - d.saidRecorded;
  const contrast =
    unlabelled > 0
      ? ` The other ${countOf(unlabelled, 'raised finding')} ${agree(unlabelled, 'carries', 'carry')} no said label ` +
        'at all, which is not the same as carrying no dispute.'
      : '';

  // A measured zero must not look like the not-measured line one paragraph
  // earlier in this same function. The value string already differs ("0 of 2
  // said-labelled findings" vs "not yet measured"), but the distinction is the
  // whole point of the line, so it is said in words too.
  // "Checked" is reserved for a `did` verdict elsewhere on this card (the
  // `describeAddressed` contrast, `describeJudgedCoverage`, the empty-panel
  // scope note) — reusing it here for the SAID-labelled population would
  // teach the reader "checked" means two different things a paragraph apart.
  const zeroClause =
    count === 0
      ? `This is a real zero, not a gap in the data: none of the ${agree(d.saidRecorded, 'problem', 'problems')} ` +
        'the team gave an answer on was disputed as wrong. '
      : '';

  return {
    label: 'Disputed as factually wrong',
    // The denominator travels WITH the figure, exactly as it does on the
    // acted-on line. A bare "2" sits on a card whose headline number is the
    // raised total, and 2-of-72 and 2-of-139 are different claims.
    //
    // "said-labelled findings", NOT the engagement line's "N of M with a said
    // label" shape: that one is ambiguous at zero. "0 of 2 with a said label"
    // parses just as easily as "0 of 2 HAVE a said label" — which is the
    // not-measured claim this very line exists to distinguish a real zero
    // from. With the qualifier as an adjective on the noun, both parses mean
    // the same thing and neither is the wrong one.
    value: `${count} of ${countOf(d.saidRecorded, 'said-labelled finding')}`,
    // Entailment: this used to assert "n is small enough that a percentage
    // would overstate what it can support" — a claim about the size of a
    // population, and one that becomes false at scale. Reporting it as a count
    // is a deliberate policy (the spec: "must show the count, never a rate"),
    // so the sentence states the policy and the denominator, and claims
    // nothing about how big n happens to be.
    detail:
      `${zeroClause}Reported as a count, not a rate: the denominator is the ` +
      `${countOf(d.saidRecorded, 'finding')} carrying a said label.${contrast}`,
    // The `did` cross-tab, disclosed only when there is something to disclose.
    // At `unjudged === 0` there is no limitation to state and the clause would
    // be a category that exists and is empty. It claims only what a null `did`
    // establishes — that no diff was judged against the finding — and in
    // particular does NOT say the branch ignored it.
    caveat: unjudged > 0 ? describeDisputedUnjudged(count, unjudged) : null,
    status: 'neutral',
  };
}

/** The disputed-but-unjudged clause. Split out so its three forms are readable
 *  side by side: the singular reads as English rather than "the 1 findings",
 *  and the all-of-them case says "none of them" rather than "N of N", which
 *  invites the reader to check the arithmetic instead of the claim. Only ever
 *  called with `unjudged >= 1`, so no branch here describes an empty set. */
function describeDisputedUnjudged(count: number, unjudged: number): string {
  if (unjudged === count) {
    return count === 1
      ? 'The finding disputed here carries no verdict on the diff, so this card cannot say whether the branch acted ' +
        'on it anyway.'
      : `None of the ${count} findings disputed here carries a verdict on the diff, so this card cannot say whether ` +
        'the branch acted on any of them anyway.';
  }
  return (
    `${unjudged} of the ${countOf(count, 'finding')} disputed here ${agree(unjudged, 'carries', 'carry')} no verdict ` +
    `on the diff, so this card cannot say whether the branch acted on ${itThem(unjudged)} anyway.`
  );
}

export function describeSpend(s: ReviewValueSpend, addressed: number, o: ReviewValueOutcome): ScorecardLine {
  // The floor disclosure belongs to the TOTAL, so it is said wherever the
  // total is shown — including the branch where there is no per-item figure at
  // all and `s.note` (which is about the per-item figure) must not render.
  const floorClause =
    s.numeratorState === 'floor'
      ? ` ${s.reviewsMissingCost} of ${countOf(s.reviewCount, 'review')} ${agree(s.reviewsMissingCost, 'has', 'have')} no recorded cost, so the sum shown is not complete: the real total is at least this much.`
      : '';

  const noCostRecorded = s.reviewCount > 0 && s.reviewsMissingCost === s.reviewCount;

  // ORDER IS LOAD-BEARING: this must be tested BEFORE `costPerAddressed ==
  // null`. Both conditions hold at once when every review lacks a cost AND
  // nothing is acted on, and the null check would then describe missing data
  // as an absence of action, under a measured-looking "$0.00". Pinned by
  // "ORDER: all-costs-missing is tested BEFORE the null check" — verified to
  // fail with the two blocks swapped, not merely written.
  if (noCostRecorded) {
    // Distinct from "nothing acted on": here there IS a denominator, but no
    // numerator was ever recorded. "$0.00" would read as a measured zero.
    return {
      label: 'Total spend this window',
      value: 'not recorded',
      detail:
        `None of the ${countOf(s.reviewCount, 'review')} on the PRs these findings came from carries a recorded ` +
        'cost, so there is no spend to report and no per-item figure to derive from it. This is missing data, not a ' +
        'measured zero.',
      caveat: null,
      status: 'attention',
    };
  }

  if (s.costPerAddressed == null) {
    // No per-item figure exists here, so the per-item caveat must not render.
    // It used to: `label`/`value`/`detail` branched and `caveat` did not,
    // leaving "Treat it as an upper bound" with no referent beside a total
    // that is a floor — a reader landed on the exact inverse of the truth.
    return {
      label: 'Total spend this window',
      value: formatCost(s.totalCostUsd),
      detail:
        `${formatCost(s.totalCostUsd)} across ${countOf(s.reviewCount, 'review')} on the PRs these findings came from. ` +
        `Nothing is confirmed acted on in this window, so there is no per-item figure to report.${floorClause}`,
      caveat: null,
      status: 'neutral',
    };
  }

  return {
    // Names the DENOMINATOR, not the section it sits in — "Spend" would just
    // repeat the section title above it, and the whole risk with this figure
    // is a reader forgetting what it was divided by.
    label: 'Cost per confirmed acted-on finding',
    value: `${formatCost(s.costPerAddressed)} per acted-on`,
    // No `floorClause` here: on this branch the caveat below states the same
    // fact with its counts, and stating it in both put the missing-cost point
    // three times inside ~130 words. The no-per-item branch above keeps it,
    // because there the caveat is null and this is the only place it is said.
    detail:
      `${formatCost(s.totalCostUsd)} across ${countOf(s.reviewCount, 'review')} → ${formatCost(s.costPerAddressed)} ` +
      `per confirmed acted-on finding (${formatCost(s.totalCostUsd)} ÷ ${addressed}).`,
    // Coverage restated INSIDE the caveat, not only beside the acted-on line:
    // this is the number a reader is most likely to quote out of context, and
    // whether the denominator can still move is the whole question.
    caveat: `${s.note} Judged coverage right now: ${o.judged}/${o.findingsRaised} (${formatPct(o.judgedCoverage)}).`,
    // 'neutral', NOT 'attention': this IS a measurement, just an unsettled
    // one, and the `--attention` figure treatment is reserved for a figure
    // that is not a measurement at all. The unsettledness is already carried
    // by the SECTION's own attention border (SpendSection) plus the caveat
    // below the figure — rendering the dollar value itself in the
    // absence-of-measurement style would say something false about it.
    status: 'neutral',
  };
}

/** Caption under the verdict table. Was inline JSX, and its "the rest reached
 *  only a majority" was wrong for TWO independent reasons — recording both,
 *  because fixing only the first still leaves a false sentence:
 *   1. it describes an empty set whenever every judged row was unanimous; and
 *   2. more seriously, the remainder is not majority AT ALL. `unanimous` is
 *      one value of `did_confidence`, which also holds `majority`, `split`,
 *      `single-vote` and `none` — so no count of unanimous rows licenses any
 *      statement about what the others were.
 *  Pulled out of JSX so it is swept and tested like every other string here. */
export function describeVerdictCaption(o: ReviewValueOutcome): string {
  const scope =
    `Shares are over the ${countOf(o.judged, 'JUDGED finding')}, not over all ${o.findingsRaised} raised.`;
  // ORDER IS LOAD-BEARING: judged === 0 also makes `judged - unanimous === 0`,
  // so the all-unanimous branch below would claim agreement across an empty
  // set. Pinned by "ORDER: judged===0 is tested BEFORE the all-unanimous
  // check".
  if (o.judged === 0) return scope;
  // `unanimous` counts ONE value of `did_confidence`, whose domain also holds
  // `majority`, `split`, `single-vote` and `none`. So it licenses no claim
  // about the remainder — "the rest reached only a majority" asserted
  // something this number cannot support, two lines under a verdict table
  // that can read `SPLIT 1 100.0%`, which is the very reading `DID_LABELS`
  // keeps a zero `SPLIT` row to prevent. The remainder is therefore described
  // only as NOT unanimous; the table above carries what they actually were.
  const notUnanimous = o.judged - o.unanimous;
  if (notUnanimous === 0) return `${scope} Every judged row had all three ballots agree.`;
  if (o.unanimous === 0) return `${scope} No judged row had all three ballots agree.`;
  return (
    `${scope} ${o.unanimous} of the ${countOf(o.judged, 'judged row')} had all three ballots agree; ` +
    `the other ${notUnanimous} did not.`
  );
}

/** Optional and small, per the brief. The two populations are reported
 *  SEPARATELY and never averaged together: a negative lead time means the
 *  review landed after the PR had already settled, which is not a slow lead
 *  time, it is a different event.
 *
 *  There is a THIRD population, and every sentence below is scoped around it:
 *  findings whose lead time is not recorded at all. `beforeSettleCount === 0`
 *  therefore licenses only "no finding WE CAN SEE was raised before its PR
 *  settled" — the unqualified version was live for a round, in a sentence the
 *  unrecorded clause beside it then contradicted. */
export function describeLeadTime(l: ReviewValueLeadTime): string {
  const b = l.beforeSettleCount;
  const a = l.afterSettleCount;
  const u = l.unrecordedCount;
  const known = b + a;

  // Everything below is scoped to findings whose lead time is RECORDED.
  // `beforeSettleCount === 0` establishes only that none of those was raised
  // before its PR settled — it says nothing about the `u` findings whose lead
  // time is null (`prSettledAt` null, or the column simply unset). An earlier
  // version promoted it to "No finding in this window was raised before its PR
  // settled", a universal claim the very next clause then contradicted by
  // admitting the code does not know for some of them.
  if (known === 0) {
    return u === 0
      ? 'No findings in this window, so there is no lead time to report.'
      : `No finding in this window has a lead time recorded, so there is none to report — ` +
        `${countOf(u, 'finding')} ${agree(u, 'is', 'are')} missing one.`;
  }

  const med = l.medianMinsBeforeSettle == null ? 'n/a' : `${Math.round(l.medianMinsBeforeSettle)} min`;
  const head =
    b === 0
      ? 'No finding with a recorded lead time was raised before its PR settled, so there is no median to report.'
      : `Median ${med} from finding posted to PR settled, over the ${countOf(b, 'finding')} raised before the PR settled.`;

  // "excluded from the median above" needs a median to be excluded from; with
  // no before-settle findings there is none, and the clause pointed at
  // something the previous sentence had just said does not exist.
  const after =
    a === 0
      ? ''
      : ` ${countOf(a, 'finding')} ${agree(a, 'was', 'were')} raised AFTER the PR settled (a cherry-pick or ` +
        `post-merge review); ${agree(a, 'it has', 'they have')} no lead time to measure` +
        (b === 0 ? '.' : `, and ${agree(a, 'is', 'are')} excluded from the median above rather than averaged into it.`);

  const unrecorded =
    u === 0
      ? ''
      : ` ${countOf(u, 'finding')} ${agree(u, 'has', 'have')} no lead time recorded at all, and ` +
        `${agree(u, 'is', 'are')} in neither count above.`;

  return `${head}${after}${unrecorded}`;
}

export interface ReviewValuePanelView {
  status: PanelStatus;
  message: string | null;
  data: ReviewValueStats | null;
}

/** Mirrors `buildCostPanelView`/`buildQualityPanelView` exactly. The `'empty'`
 *  wording is this endpoint's own: an empty window here means no CLASSIFIED
 *  FINDINGS, which is a different fact from no reviews — the generic "No data
 *  recorded in this window" would send a reader looking for a broken reviewer
 *  when the real answer is that the classifier has not run over this window. */
export function buildReviewValuePanelView(state: FetchState<ReviewValueStats>): ReviewValuePanelView {
  switch (state.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading…', data: null };
    case 'error':
      return { status: 'error', message: `Failed to load: ${state.message}`, data: null };
    case 'empty':
      return {
        status: 'empty',
        message:
          'No classified findings in this window. Reviews may still have run — this table holds only critical and major problems on pull requests that have been merged or closed, and only once a scheduled job has checked them.',
        data: null,
      };
    case 'ready':
      return { status: 'ready', message: null, data: state.data };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ReviewValueSection({ title, status, children }: { title: string; status: SectionStatus; children: any }) {
  return (
    <div class={`review-value-section review-value-section--${status}`}>
      <h5 class="review-value-section__title">{title}</h5>
      <div class="review-value-section__body">{children}</div>
    </div>
  );
}

/** `line.status` drives a modifier class. It used to be set by every builder
 *  and read by nobody, so all six figures rendered identically — and the one
 *  line that most needs to look unlike a measured figure ("Disputed as
 *  factually wrong: not yet measured") looked exactly like one. */
function ScorecardFigure({ line }: { line: ScorecardLine }) {
  return (
    <div class={`review-value-figure review-value-figure--${line.status}`}>
      <div class="review-value-figure__value">{line.value}</div>
      <div class="review-value-figure__label">{line.label}</div>
      <p class="review-value-section__summary">{line.detail}</p>
      {line.caveat && (
        <p class="review-value-section__note">
          <strong class="review-value-tag review-value-tag--caveat">Known instrument caveat: </strong>
          {line.caveat}
        </p>
      )}
    </div>
  );
}

function RaisedAndActedOnSection({ o }: { o: ReviewValueOutcome }) {
  const addressed = describeAddressed(o);
  const didRows = buildDidRows(o);
  return (
    <ReviewValueSection title="Findings raised, and what happened to them" status="neutral">
      <div class="review-value-figure review-value-figure--neutral">
        <div class="review-value-figure__value">{o.findingsRaised}</div>
        <div class="review-value-figure__label">Read-band findings raised</div>
        <p class="review-value-section__summary">{o.scopeNote}</p>
        {/* The spec's fourth stated limit, rendered rather than buried — and
            with its measured size, not a rule of thumb. The caveat LABEL only
            appears when there is actually a caveat: with no gap the note says
            everything is traceable, and labelling that "Known instrument
            caveat" announced a limitation while denying one. */}
        {o.traceability.untraceable > 0 ? (
          <p class="review-value-section__note">
            <strong class="review-value-tag review-value-tag--caveat">Known instrument caveat: </strong>
            {o.traceabilityNote}
          </p>
        ) : (
          <p class="review-value-section__summary">{o.traceabilityNote}</p>
        )}
      </div>
      <ScorecardFigure line={addressed} />
      <p class="review-value-section__summary">Coverage: {describeJudgedCoverage(o)}</p>
      <table class="review-value-table">
        <thead>
          <tr>
            <th>Verdict</th>
            <th>Count</th>
            <th>Share of judged</th>
          </tr>
        </thead>
        <tbody>
          {didRows.map((r) => (
            <tr key={r.label}>
              <td class="review-value-table__mono">{r.label}</td>
              <td>{r.count}</td>
              <td>{formatPct(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="review-value-section__note">{describeVerdictCaption(o)}</p>
      <p class="review-value-section__note">
        <strong class="review-value-tag review-value-tag--caveat">Known instrument caveat: </strong>
        {o.reproducibilityNote}
      </p>
    </ReviewValueSection>
  );
}

function ResponseSection({ o }: { o: ReviewValueOutcome }) {
  return (
    <ReviewValueSection title="What the team said" status="neutral">
      <ScorecardFigure line={describeSilentlyFixed(o)} />
      <ScorecardFigure line={describeEngagement(o.engagement, o)} />
      <ScorecardFigure line={describeDisputed(o.disputedAsWrong, o)} />
    </ReviewValueSection>
  );
}

function SpendSection({ o }: { o: ReviewValueOutcome }) {
  // The missing-cost disclosure now lives INSIDE describeSpend's `detail`. It
  // used to be a separate paragraph here, which put "the numerator is exact"
  // (in the caveat) two lines above "the total above is a floor" (here) — a
  // direct contradiction, both live at the same time.
  //
  // Status is DERIVED, not hardcoded 'attention'. The attention treatment is
  // this panel's mark for "something here is unsettled"; a window with a
  // complete cost sum and full judged coverage has nothing unsettled, and
  // drawing the accent border round a plain total there spent the signal on
  // the one case that does not need it.
  const unsettled = o.spend.numeratorState === 'floor' || o.spend.denominatorState === 'will-grow';
  return (
    <ReviewValueSection title="Spend" status={unsettled ? 'attention' : 'neutral'}>
      <ScorecardFigure line={describeSpend(o.spend, o.addressed, o)} />
    </ReviewValueSection>
  );
}

function LeadTimeSection({ o }: { o: ReviewValueOutcome }) {
  return (
    <ReviewValueSection title="Lead time" status="neutral">
      <p class="review-value-section__summary">{describeLeadTime(o.leadTime)}</p>
    </ReviewValueSection>
  );
}

function ReviewValueBody({ data }: { data: ReviewValueStats }) {
  const o = data.outcome;
  return (
    <div class="review-value-card__body">
      {data.lowSample && (
        <p class="review-value-panel__low-sample">
          Small sample: n={countOf(data.sampleSize, 'finding')} in this window — every statistic below is a
          small-sample reading.
        </p>
      )}
      <RaisedAndActedOnSection o={o} />
      <ResponseSection o={o} />
      <SpendSection o={o} />
      <LeadTimeSection o={o} />
    </div>
  );
}

export function ReviewValuePanel() {
  const view = buildReviewValuePanelView(reviewValueStats.value);
  const window = statsWindow.value;
  return (
    <section id="stats-slot-review-value" class={`stats-slot stats-slot--${view.status}`} aria-label="Review value">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Review value</h3>
        <span class="stats-slot__window" title="Time window this section reads">{window}</span>
      </div>
      <CardGlossary terms={TERMS} />
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>{view.message}</p>
      ) : (
        <ReviewValueBody data={view.data!} />
      )}
    </section>
  );
}
