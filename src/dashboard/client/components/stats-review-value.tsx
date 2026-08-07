import { reviewValueStats, statsWindow } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { ReviewValueStats, ReviewValueOutcome, ReviewValueEngagement, ReviewValueDisputed, ReviewValueLeadTime, ReviewValueSpend } from '../../stats.ts';
import { formatCost, formatPct } from '../format.ts';

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
//  R2. NOT MEASURED IS NOT ZERO. "Disputed as factually wrong" needs the
//      `said` column, which nothing populates yet. It renders as an explicit
//      "not yet measured" line with its one-line reason — never as 0, which
//      would assert nobody disputed anything.
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
      'Both are true and they measure different things: the first is the hit rate among findings we could check, ' +
      'the second is diluted by every finding not yet judged.',
    caveat: null,
    status: 'neutral',
  };
}

/** Coverage — how much of the window has been judged at all. Rendered
 *  immediately beside the acted-on figure (R1), not in a footnote. */
export function describeJudgedCoverage(o: ReviewValueOutcome): string {
  const head = `${o.judged}/${o.findingsRaised} findings judged (${formatPct(o.judgedCoverage)})`;
  if (o.unjudgeable === 0) return `${head} — every finding raised in this window has a verdict.`;
  // "Not yet" and "never" are different facts and are never summed into one
  // number here: `awaitingDiff` will eventually be judged, `untraceable`
  // never will be.
  const parts = [`${o.awaitingDiff} awaiting a diff to judge against`];
  if (o.traceability.untraceable > 0) {
    parts.push(`${o.traceability.untraceable} that can never be judged (no inline thread)`);
  }
  return `${head} — ${o.unjudgeable} carry no verdict: ${parts.join(', ')}.`;
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
  const detail =
    e.engagedRate == null
      ? 'No finding in this window carries an engagement signal either way.'
      : `${e.engaged} drew a written response (thread reply or PR discussion), ${e.silent} drew none — ` +
        `${formatPct(e.engagedRate)} of the ${denominator} finding(s) where engagement could be read. ` +
        `That is not all ${o.findingsRaised} raised: engagement is read off a finding's own thread.`;
  const missing: string[] = [];
  if (e.unrecorded > 0) {
    missing.push(`${e.unrecorded} traced finding(s) carry no engagement signal this code classifies — in neither bucket, not folded into "no reply"`);
  }
  if (o.traceability.untraceable > 0) {
    missing.push(`${o.traceability.untraceable} raised finding(s) have no thread at all to read engagement from`);
  }
  return {
    label: 'Human engagement',
    // States its OWN denominator, not the raised total.
    value: `${e.engaged} of ${denominator} with a readable signal`,
    detail,
    caveat: missing.length > 0 ? `${missing.join('; ')}.` : null,
    status: 'neutral',
  };
}

/** R2. Never a count when nothing measured it. The reason comes from the
 *  server (`disputedAsWrong.reason`) rather than being restated here, so
 *  there is one place to change when the `said` phase lands. */
export function describeDisputed(d: ReviewValueDisputed): ScorecardLine {
  if (!d.measured) {
    return {
      label: 'Disputed as factually wrong',
      value: 'not yet measured',
      detail: d.reason,
      caveat: null,
      status: 'attention',
    };
  }
  return {
    label: 'Disputed as factually wrong',
    value: `${d.count}`,
    detail: `A count, never a rate — n is small enough that a percentage would overstate what it can support. Measured over ${d.saidRecorded} finding(s) carrying a said label.`,
    caveat: null,
    status: 'neutral',
  };
}

export function describeSpend(s: ReviewValueSpend, addressed: number, o: ReviewValueOutcome): ScorecardLine {
  // The floor disclosure belongs to the TOTAL, so it is said wherever the
  // total is shown — including the branch where there is no per-item figure at
  // all and `s.note` (which is about the per-item figure) must not render.
  const floorClause =
    s.numeratorState === 'floor'
      ? ` ${s.reviewsMissingCost} of ${s.reviewCount} review(s) carry no recorded cost, so this total is a FLOOR, not a complete sum.`
      : '';

  if (s.costPerAddressed == null) {
    // No per-item figure exists here, so the per-item caveat must not render.
    // It used to: `label`/`value`/`detail` branched and `caveat` did not,
    // leaving "Treat it as an upper bound" with no referent beside a total
    // that is a floor — a reader landed on the exact inverse of the truth.
    return {
      label: 'Total spend this window',
      value: formatCost(s.totalCostUsd),
      detail:
        `${formatCost(s.totalCostUsd)} across ${s.reviewCount} review(s) on the PRs these findings came from. ` +
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
    detail:
      `${formatCost(s.totalCostUsd)} across ${s.reviewCount} review(s) → ${formatCost(s.costPerAddressed)} ` +
      `per confirmed acted-on finding (${formatCost(s.totalCostUsd)} ÷ ${addressed}).${floorClause}`,
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

/** Optional and small, per the brief. The two populations are reported
 *  SEPARATELY and never averaged together: a negative lead time means the
 *  review landed after the PR had already settled, which is not a slow lead
 *  time, it is a different event. */
export function describeLeadTime(l: ReviewValueLeadTime): string {
  const med = l.medianMinsBeforeSettle == null ? 'n/a' : `${Math.round(l.medianMinsBeforeSettle)} min`;
  const after =
    l.afterSettleCount === 0
      ? ''
      : ` ${l.afterSettleCount} finding(s) were raised AFTER the PR settled (a cherry-pick or post-merge review) and are excluded from that median rather than averaged into it — they have no lead time to measure.`;
  const unrecorded = l.unrecordedCount === 0 ? '' : ` ${l.unrecordedCount} finding(s) have no lead time recorded.`;
  return `Median ${med} from finding posted to PR settled, over the ${l.beforeSettleCount} finding(s) raised before the PR settled.${after}${unrecorded}`;
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
          'No classified findings in this window. Reviews may still have run — this table only holds read-band findings on PRs that have settled, classified by the outcome sweep.',
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
            with its measured size, not a rule of thumb. */}
        <p class="review-value-section__note">
          <strong class="review-value-tag review-value-tag--caveat">Known instrument caveat: </strong>
          {o.traceabilityNote}
        </p>
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
      <p class="review-value-section__note">
        Shares are over the {o.judged} JUDGED finding(s), not over all {o.findingsRaised} raised. {o.unanimous} of the
        judged rows had all three ballots agree; the rest reached only a majority.
      </p>
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
      <ScorecardFigure line={describeDisputed(o.disputedAsWrong)} />
    </ReviewValueSection>
  );
}

function SpendSection({ o }: { o: ReviewValueOutcome }) {
  // The missing-cost disclosure now lives INSIDE describeSpend's `detail`, on
  // both branches. It used to be a separate paragraph here, which put "the
  // numerator is exact" (in the caveat) two lines above "the total above is a
  // floor" (here) — a direct contradiction, both live at the same time.
  return (
    <ReviewValueSection title="Spend" status="attention">
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
          Small sample: n={data.sampleSize} finding(s) in this window — every statistic below is a small-sample
          reading.
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
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>{view.message}</p>
      ) : (
        <ReviewValueBody data={view.data!} />
      )}
    </section>
  );
}
