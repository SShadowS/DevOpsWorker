import { operationalStats, statsWindow } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { OperationalStats, ToolMixEntry, ErrorCategory, ErrorClassificationSummary } from '../../stats.ts';
import { formatDurationDetailed } from '../format.ts';
import { countOf } from '../../count-phrase.ts';
import { CardGlossary } from './card-glossary.tsx';
import type { GlossaryTerm } from './card-glossary.tsx';

// This card's own short vocabulary. The underlying column is named `turns`
// (see the "Duration & turns" section below) — an operator comparing this
// card to the query behind it wants that link kept, not renamed away.
const TERMS: readonly GlossaryTerm[] = [
  { term: 'a turn', plain: 'one exchange with the model during a review' },
];

// ---------------------------------------------------------------------------
// Operational panel (Task 9) — Section E, "how is the machine actually
// running." Replaces the `stats-slot-operational` placeholder (Task 4),
// keeping the same outer `stats-slot stats-slot--{status}` wrapper and header
// markup so the loading/error/empty border-colour CSS carries over unchanged,
// matching Tasks 6/7/8's precedent. `/api/stats/operational` is a SINGLE
// fetch (unlike Task 8's cost+quality slot, which reads two) so this panel's
// status is gated directly by `operationalStats`, the same shape as
// `buildIntegrityPanelView`/`buildConfigPanelView` rather than Task 8's
// two-fetch worst-of-two (`worstStatus`, `../assessors.ts`).
//
// Five sections:
//   - Reviews per day  — a real hand-rolled bar chart (chart geometry pulled
//     into pure, tested functions: buildDailyReviewBars/buildReviewsChartView).
//     `status="neutral"`.
//   - Duration & turns — p50/p90, each with its own sample size.
//     `status="neutral"`.
//   - Tool mix         — a tool with ZERO calls this window is 'attention',
//     not 'ok': design-constraints.md is explicit that `lsp: 0` is "a
//     finding, not an empty row," and the underlying `aggregateToolMix`
//     (stats.ts) already sorts by totalCalls DESCENDING — without an
//     explicit callout, a zero-call tool sinks to the tail of a long table
//     and reads as absent rather than as a recorded, real zero. The check is
//     generic (any zero-call tool, not a hardcoded "lsp" name) so it keeps
//     working if a different tool goes quiet later.
//   - Repo breakdown   — a plain, unscored table (`perRepo` counts ALL rows,
//     unlike /api/stats/cost's cost_usd-filtered population — see
//     task-2-report.md's "Not touched" note — so no coverage caveat applies
//     here the way it does on the Cost card). `status="neutral"`.
//   - Error breakdown  — see the module doc comment on `classifyErrorMessage`
//     in stats.ts for exactly what's classified and why. `status="attention"`
//     specifically when this window recorded a rate-limit event (a real,
//     actionable capacity signal), never merely because the total error
//     count is nonzero — matching `stats-integrity.tsx`'s dispatch-mismatch
//     precedent of not scoring a chronically-nonzero, non-actionable count as
//     'attention'. An `other` (unclassified) count is disclosed as a "Known
//     instrument caveat:" note instead — it's a fact about the CLASSIFIER's
//     own coverage, not a confirmed pipeline health finding.
//
// FIX ROUND 1 HISTORY: this section originally shipped as "Rate-limit
// events," rendering an explicit "not available" statement — `stats.ts` was
// off-limits for Task 9, and neither `OperationalStats` nor
// `IntegrityStats.errorRate` broke errors out by `PipelineError` subtype.
// The team lead re-checked production data before accepting that: over 90
// days, 21 of 31 recorded errors (68%) are `RateLimitError`s with a clean,
// parseable prefix, and the remainder classify just as cleanly against the
// other two fixed-shape `PipelineError` messages — "not available"
// understated what the column actually holds. `stats.ts` was reopened for
// this task specifically to add `classifyErrorMessage`/`classifyErrors` and
// wire `OperationalStats.errorClassification` — see that file for the full
// classification design (which shapes are stable-prefix-matched, why
// `TransientAgentError`'s wrapped messages are peeled exactly one layer, and
// why an unrecognised message is conservatively `'other'`, never guessed).
// ---------------------------------------------------------------------------

export type OperationalSectionStatus = 'ok' | 'attention' | 'neutral';

// ---------------------------------------------------------------------------
// Reviews per day — chart geometry (pure, unit-tested, no rendering).
//
// The server's `reviewsPerDay.series` only contains days with at least one
// review (`GROUP BY date_trunc('day', created_at)` in `getOperationalStats`,
// stats.ts) — a day with zero reviews is simply ABSENT from the array, not
// present with `count: 0`. Rendering that array as-is (e.g. one bar per
// series entry, in order) would silently compress a 30-day window down to
// however many days happened to have activity, misrepresenting adjacent bars
// as consecutive days when they might be a week apart.
//
// `buildDailyReviewBars` re-expands the series to one entry per CALENDAR day
// from the window's `since` date to today, zero-filling any day absent from
// the series — the same zero-fill convention `aggregateToolMix` and
// `dispatchCountsForPercentile` already use server-side for exactly the same
// reason (a missing key is a real zero, not missing data). Confirmed against
// live production data before building this: a 30-day query returned data
// for 21 of 30 calendar days, with every gap falling on what reads as a
// non-workday — a real, informative pattern this chart would otherwise hide.
// ---------------------------------------------------------------------------

export interface DailyReviewBar {
  /** yyyy-mm-dd, matching the server's own `date` string format exactly. */
  date: string;
  count: number;
  /** 0..100, scaled against the window's own peak day — a display concern
   *  only. The exact count is always in the bar's `title`/aria text, never
   *  only implied by height. */
  heightPct: number;
}

const DAY_MS = 86_400_000;

/** Both `since` (an ISO instant) and a `Date` are reduced to their UTC
 *  calendar date before comparison — the server's `date` strings have no
 *  time component, so comparing on anything narrower than a whole day risks
 *  a spurious off-by-one from timezone or sub-day skew between the server's
 *  request-time `now()` and this function's own `now` parameter. */
function toUtcYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A date-ONLY string (`YYYY-MM-DD`, no time component) is specified to
 *  parse as UTC midnight (ECMA-262's Date Time String Format) — slicing to
 *  just the date part before parsing turns any ISO instant (with or without
 *  a time-of-day) into that same, unambiguous UTC-midnight anchor. */
function utcMidnight(dateInput: string): number {
  return new Date(dateInput.slice(0, 10)).getTime();
}

/**
 * Re-expands a sparse day/count series into one entry per calendar day
 * covering the window, zero-filling gaps. `now` is injectable (defaults to
 * the real clock) purely so tests are deterministic — see the module doc
 * comment for why zero-fill is correct here, not a cosmetic choice.
 *
 * The FIRST bar can reflect a partial day: `since` is a rolling timestamp
 * (now − windowDays), not a midnight boundary, so the calendar day it falls
 * in may have fewer than 24 hours of eligible reviews. This is disclosed in
 * prose next to the chart, not hidden — a real characteristic of any rolling
 * window, not a defect in this function.
 */
export function buildDailyReviewBars(
  series: OperationalStats['reviewsPerDay']['series'],
  since: string,
  now: Date = new Date(),
): DailyReviewBar[] {
  const counts = new Map(series.map((s) => [s.date, s.count]));
  const start = utcMidnight(since);
  const end = utcMidnight(toUtcYMD(now));
  const days: Array<{ date: string; count: number }> = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const date = toUtcYMD(new Date(t));
    days.push({ date, count: counts.get(date) ?? 0 });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));
  return days.map((d) => ({ ...d, heightPct: (d.count / maxCount) * 100 }));
}

export interface ReviewsChartView {
  bars: DailyReviewBar[];
  totalDays: number;
  zeroDays: number;
  averageText: string;
  firstDate: string | null;
  lastDate: string | null;
}

export function buildReviewsChartView(
  reviewsPerDay: OperationalStats['reviewsPerDay'],
  windowDays: number,
  since: string,
  sampleSize: number,
  now: Date = new Date(),
): ReviewsChartView {
  const bars = buildDailyReviewBars(reviewsPerDay.series, since, now);
  const zeroDays = bars.filter((b) => b.count === 0).length;
  const averageText = reviewsPerDay.average == null
    ? 'n/a'
    : `${reviewsPerDay.average.toFixed(1)} reviews/day average over the ${windowDays}-day window (n=${sampleSize})`;
  return {
    bars,
    totalDays: bars.length,
    zeroDays,
    averageText,
    firstDate: bars[0]?.date ?? null,
    lastDate: bars.length > 0 ? bars[bars.length - 1]!.date : null,
  };
}

/** The zero-days clause ("N of M calendar {day, days}", the noun agreeing
 *  with M, singular exactly when M is 1) shared VERBATIM between the chart's
 *  `aria-label` (screen reader) and its visible note (sighted user): two
 *  channels stating the same fact, which must render the same grammar for
 *  the same values. One function producing the shared clause makes that a
 *  construction guarantee: the two call sites cannot drift apart the way two
 *  hand-synced strings could. */
export function describeZeroDaysClause(zeroDays: number, totalDays: number): string {
  return `${zeroDays} of ${countOf(totalDays, 'calendar day')}`;
}

/** Each bar's tooltip. Not one of the ten count-agreement defect sites — the
 *  ternary it replaces (`review${b.count === 1 ? '' : 's'}`) already had
 *  correct behaviour at every count — swapped to the helper purely for
 *  consistency with the rest of this card's counted prose, renders
 *  identically to the ternary it replaces (see the tests below). */
export function describeBarTitle(date: string, count: number): string {
  return `${date}: ${countOf(count, 'review')}`;
}

// ---------------------------------------------------------------------------
// Duration & turns — both are percentile pairs with their own sample size,
// which can differ from the window's total row count (constraint: "every
// statistic shows its window and its sample size ... do not assume one n
// covers the card"). No separate low-sample threshold is computed for these
// two specifically: unlike `sub_agents`/`findings_list` (recently-added
// instrumentation columns with a real historical gap, per Tasks 2/6/8),
// `duration_ms`/`turns` are populated on nearly every completed review —
// measured live at 99.1% (30d) / 97.2% (90d), not literally 100%; the small
// gap is rows that error out before these fields are ever written, not a
// genuine instrumentation gap the way `sub_agents`/`findings_list` have —
// so their `sampleSize` is expected to closely track the window's total
// `sampleSize` in practice, disclosed as a plain number, not a computed
// coverage percentage like the Cost/Quality cards use for their genuinely
// gappy columns.
// ---------------------------------------------------------------------------

function formatMsOrNA(ms: number | null): string {
  return ms == null ? 'n/a' : formatDurationDetailed(ms);
}

export interface PercentilePairView {
  medianText: string;
  p90Text: string;
  sampleSize: number;
}

export function buildDurationSectionView(duration: OperationalStats['duration']): PercentilePairView {
  return { medianText: formatMsOrNA(duration.medianMs), p90Text: formatMsOrNA(duration.p90Ms), sampleSize: duration.sampleSize };
}

/** No unit conversion needed (turns is a plain count) — deliberately NOT
 *  rounded, matching `DispatchSection`'s `medianText`/`p90Text` precedent in
 *  stats-integrity.tsx (`percentile_cont` can return a fractional value even
 *  over an integer column; that fraction is real, not a display artefact to
 *  hide). */
export function buildTurnsSectionView(turns: OperationalStats['turns']): PercentilePairView {
  return {
    medianText: turns.median == null ? 'n/a' : `${turns.median}`,
    p90Text: turns.p90 == null ? 'n/a' : `${turns.p90}`,
    sampleSize: turns.sampleSize,
  };
}

/** The note under the duration/turns figures — three independent sample
 *  sizes, each of which can be 1. */
export function describeDurationTurnsSampleNote(durationSampleSize: number, turnsSampleSize: number, totalSampleSize: number): string {
  return (
    `Duration computed over ${countOf(durationSampleSize, 'row')} with duration recorded; turns over ${countOf(turnsSampleSize, 'row')} ` +
    `with turns recorded — each may differ from this window's ${countOf(totalSampleSize, 'total row')}.`
  );
}

// ---------------------------------------------------------------------------
// Tool mix — the one scored section on this panel. See the module doc
// comment for why a zero-call tool is 'attention', not merely un-highlighted.
// ---------------------------------------------------------------------------

export interface ToolMixRowView extends ToolMixEntry {
  isZero: boolean;
}

export interface ToolMixSectionView {
  status: 'ok' | 'attention';
  summary: string;
  rows: ToolMixRowView[];
}

export function buildToolMixSectionView(toolMix: ToolMixEntry[]): ToolMixSectionView {
  const rows = toolMix.map((t) => ({ ...t, isZero: t.totalCalls === 0 }));
  if (rows.length === 0) {
    return { status: 'ok', summary: 'No tool activity recorded in this window.', rows };
  }
  const zero = rows.filter((r) => r.isZero);
  if (zero.length === 0) {
    // I-5: "none at zero calls" used to read as coverage this section does
    // not have. `tool_calls[toolName]` (agent-stream.ts) only ever creates a
    // key on a real call and always increments by +1 — no row this codebase
    // writes can contain a zero-count key (verified live: 329 rows, 34
    // distinct keys, zero entries at value 0, ever). A tool that never fires
    // is ABSENT from tool_calls, not present at zero, so this table can only
    // ever speak to tools that were called at least once — it cannot detect
    // (and must not imply it detects) a tool that has gone silent, `lsp`
    // being the live example the plan names by name.
    return {
      status: 'ok',
      summary:
        `None of the ${countOf(rows.length, 'observed tool')} had zero calls in this window. A tool that is never called ` +
        'has no recorded activity at all, so it cannot appear here — this table can only speak to ' +
        'tools that fired at least once, not to ones that have gone silent.',
      rows,
    };
  }
  // Currently UNREACHABLE in production for the reason given in the
  // zero-length branch above: a real tool_calls row cannot contain a
  // zero-count key. Kept, not deleted — it is correct defensive rendering
  // if that invariant ever changes (e.g. a future writer starts recording
  // explicit zeros), and every branch here is still exercised directly by
  // fixture-fed unit tests (buildToolMixSectionView is a pure function, not
  // wired to the live shape it can never receive).
  return {
    status: 'attention',
    summary:
      `${zero.length} of ${countOf(rows.length, 'tool')} had ZERO calls in this window: ${zero.map((z) => z.tool).join(', ')} ` +
      '— an expected tool that never fired is a finding, not an empty row.',
    rows,
  };
}

/** The note under the tool-mix table — states the denominator the average is
 *  divided by. */
export function describeToolMixAverageNote(sampleSize: number): string {
  return (
    `Average per review is divided by all ${countOf(sampleSize, 'review')} in this window, not just the reviews that ` +
    "called a given tool — a rarely-used tool reads as a correspondingly low average, never one inflated by " +
    'dividing only by the reviews that used it.'
  );
}

// ---------------------------------------------------------------------------
// Repo breakdown — a plain, unscored table (see the module doc comment for
// why it carries no coverage caveat the way the Cost card's per-repo table
// does).
// ---------------------------------------------------------------------------

/** The note under the repo breakdown table — two independent counts, either
 *  of which can be 1 (a window with exactly one repo, or exactly one review). */
export function describeRepoBreakdownNote(repoCount: number, sampleSize: number): string {
  return (
    `${countOf(repoCount, 'repo')} across ${countOf(sampleSize, 'review')} in this window — every row counts here ` +
    "(unlike the Cost card's per-repo table, scoped to rows with cost recorded)."
  );
}

// ---------------------------------------------------------------------------
// Error breakdown (fix round 1) — a report of what `pr_reviews.error`
// actually classifies as, not a second error-RATE judgement (that already
// exists on the Integrity panel's "Error rate" section, cross-referenced
// below rather than duplicated).
// ---------------------------------------------------------------------------

const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  'rate-limit': 'Rate limit',
  'no-result': 'No result',
  'schema-validation': 'Schema validation',
  other: 'Other / unclassified',
};

/** Fixed display order — rate-limit first (it's the dominant category in
 *  production, per the fix round's own finding), `other` last (it's the
 *  catch-all, not a named failure mode). */
const ERROR_CATEGORY_ORDER: readonly ErrorCategory[] = ['rate-limit', 'no-result', 'schema-validation', 'other'];

export interface ErrorCategoryRowView {
  key: ErrorCategory;
  label: string;
  count: number;
  /** Already truncated server-side (`classifyErrors`, stats.ts) — never the
   *  full raw error string. `null` means this category had zero occurrences
   *  this window, not "an exemplar exists but was omitted." */
  exemplar: string | null;
}

export interface ErrorBreakdownSectionView {
  /** 'attention' specifically when a rate-limit event occurred this window —
   *  see the module doc comment for why `other > 0` is a caveat note
   *  instead, not a second path to 'attention'. */
  status: 'ok' | 'attention';
  summary: string;
  rows: ErrorCategoryRowView[];
  otherCount: number;
}

export function buildErrorBreakdownSectionView(errorClassification: ErrorClassificationSummary): ErrorBreakdownSectionView {
  const rows = ERROR_CATEGORY_ORDER.map((key) => ({
    key,
    label: ERROR_CATEGORY_LABELS[key],
    count: errorClassification.categories[key],
    exemplar: errorClassification.exemplars[key] ?? null,
  }));
  const rateLimitCount = errorClassification.categories['rate-limit'];
  const otherCount = errorClassification.categories.other;
  const summary = errorClassification.total === 0
    ? '0 errors recorded in this window — a real, verified reading, not "we cannot tell."'
    : `${countOf(errorClassification.total, 'error')} recorded in this window: ${rateLimitCount} rate-limit, ` +
      `${errorClassification.categories['no-result']} no-result, ${errorClassification.categories['schema-validation']} ` +
      `schema-validation, ${otherCount} unclassified.`;
  return { status: rateLimitCount > 0 ? 'attention' : 'ok', summary, rows, otherCount };
}

/** The "Known instrument caveat" note under the error breakdown table —
 *  `otherCount` is a fact about the classifier's own coverage, not a
 *  pipeline-health finding (see the module doc comment). */
export function describeOtherErrorsCaveat(otherCount: number): string {
  return (
    `${countOf(otherCount, 'error')} matched none of the three known failure shapes this classifier recognises — a ` +
    "fact about this classifier's own coverage (it may need a new pattern), not necessarily a claim that the " +
    'pipeline itself got less reliable. A growing count here is the signal to watch.'
  );
}

// ---------------------------------------------------------------------------
// Panel-level view — one FetchState in, one thing to render out. Mirrors
// `buildQualityPanelView`/`buildConfigPanelView`'s shape exactly (single
// gating fetch, four-branch exhaustive switch).
// ---------------------------------------------------------------------------

export type OperationalPanelStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface OperationalPanelView {
  status: OperationalPanelStatus;
  message: string | null;
  data: OperationalStats | null;
}

export function buildOperationalPanelView(state: FetchState<OperationalStats>): OperationalPanelView {
  switch (state.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading…', data: null };
    case 'error':
      return { status: 'error', message: `Failed to load: ${state.message}`, data: null };
    case 'empty':
      return { status: 'empty', message: 'No data recorded in this window.', data: null };
    case 'ready':
      return { status: 'ready', message: null, data: state.data };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function OperationalSection({ title, status, children }: {
  title: string;
  status: OperationalSectionStatus;
  // Matches the existing `children: any` convention (stats-integrity.tsx,
  // stats-config.tsx) rather than introducing a stricter preact type not
  // used elsewhere.
  children: any;
}) {
  return (
    <div class={`operational-section operational-section--${status}`}>
      <h4 class="operational-section__title">{title}</h4>
      <div class="operational-section__body">{children}</div>
    </div>
  );
}

function ReviewsPerDayChart({ view }: { view: ReviewsChartView }) {
  if (view.bars.length === 0) {
    return <p class="operational-section__empty">No daily review data in this window.</p>;
  }
  return (
    <>
      <div
        class="operational-chart"
        role="img"
        aria-label={`Reviews per day: ${view.averageText}. ${describeZeroDaysClause(view.zeroDays, view.totalDays)} had zero reviews recorded.`}
      >
        <div class="operational-chart__bars">
          {view.bars.map((b) => (
            <div
              key={b.date}
              class={`operational-chart__bar ${b.count === 0 ? 'operational-chart__bar--zero' : ''}`}
              style={{ height: `${b.heightPct}%` }}
              title={describeBarTitle(b.date, b.count)}
            />
          ))}
        </div>
        <div class="operational-chart__axis" aria-hidden="true">
          <span>{view.firstDate}</span>
          <span>{view.lastDate}</span>
        </div>
      </div>
      <p class="operational-section__summary">{view.averageText}</p>
      <p class="operational-section__note">
        {describeZeroDaysClause(view.zeroDays, view.totalDays)} shown had zero reviews recorded — rendered as a
        zero-height (muted) bar, not omitted. The first bar may reflect a partial day: the window's start is a
        rolling timestamp, not midnight.
      </p>
    </>
  );
}

function ReviewsPerDaySection({ data }: { data: OperationalStats }) {
  const view = buildReviewsChartView(data.reviewsPerDay, data.windowDays, data.since, data.sampleSize);
  return (
    <OperationalSection title="Reviews per day" status="neutral">
      <ReviewsPerDayChart view={view} />
    </OperationalSection>
  );
}

function DurationTurnsSection({ data }: { data: OperationalStats }) {
  const duration = buildDurationSectionView(data.duration);
  const turns = buildTurnsSectionView(data.turns);
  return (
    <OperationalSection title="Duration &amp; turns per review" status="neutral">
      <dl class="operational-dl">
        <dt>Duration — median</dt>
        <dd>{duration.medianText}</dd>
        <dt>Duration — p90</dt>
        <dd>{duration.p90Text}</dd>
        <dt>Turns — median</dt>
        <dd>{turns.medianText}</dd>
        <dt>Turns — p90</dt>
        <dd>{turns.p90Text}</dd>
      </dl>
      <p class="operational-section__note">
        {describeDurationTurnsSampleNote(duration.sampleSize, turns.sampleSize, data.sampleSize)}
      </p>
    </OperationalSection>
  );
}

function ToolMixTable({ rows }: { rows: ToolMixRowView[] }) {
  if (rows.length === 0) {
    return <p class="operational-section__empty">No tool activity recorded in this window.</p>;
  }
  return (
    <table class="operational-table">
      <thead>
        <tr><th>Tool</th><th>Total calls</th><th>Avg / review</th><th>Reviews using</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.tool} class={r.isZero ? 'operational-table__row--flagged' : ''}>
            <td class="operational-table__mono">
              {r.tool}
              {r.isZero && <span class="operational-table__flag" title="Zero calls recorded this window"> ⚠ zero calls</span>}
            </td>
            <td>{r.totalCalls}</td>
            {/* Two decimals, not one: many tools sit well under 1 call/review
                (e.g. a tool used once every several reviews), and a single
                decimal would round a genuinely rare-but-present tool down to
                "0.0" — visually indistinguishable from the zero-call row this
                section exists to call out. */}
            <td>{r.avgPerReview.toFixed(2)}</td>
            <td>{r.reviewsUsing}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ToolMixSection({ data }: { data: OperationalStats }) {
  const view = buildToolMixSectionView(data.toolMix);
  return (
    <OperationalSection title="Tool mix" status={view.status}>
      <p class="operational-section__summary">
        {view.status === 'attention' && <strong class="operational-tag operational-tag--attention">Needs attention: </strong>}
        {view.summary}
      </p>
      <ToolMixTable rows={view.rows} />
      <p class="operational-section__note">
        {describeToolMixAverageNote(data.sampleSize)}
      </p>
    </OperationalSection>
  );
}

function RepoBreakdownTable({ rows }: { rows: OperationalStats['perRepo'] }) {
  if (rows.length === 0) {
    return <p class="operational-section__empty">No repo data recorded in this window.</p>;
  }
  return (
    <table class="operational-table">
      <thead>
        <tr><th>Repo</th><th>Reviews</th><th>Median duration</th><th>Median turns</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.repoKey}>
            <td class="operational-table__mono">{r.repoKey}</td>
            <td>{r.count}</td>
            <td>{formatMsOrNA(r.medianDurationMs)}</td>
            <td>{r.medianTurns ?? 'n/a'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepoBreakdownSection({ data }: { data: OperationalStats }) {
  return (
    <OperationalSection title="Repo breakdown" status="neutral">
      <RepoBreakdownTable rows={data.perRepo} />
      <p class="operational-section__note">
        {describeRepoBreakdownNote(data.perRepo.length, data.sampleSize)}
      </p>
    </OperationalSection>
  );
}

function ErrorBreakdownTable({ rows }: { rows: ErrorCategoryRowView[] }) {
  return (
    <table class="operational-table">
      <thead>
        <tr><th>Category</th><th>Count</th><th>Example</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} class={r.key === 'rate-limit' && r.count > 0 ? 'operational-table__row--flagged' : ''}>
            <td>
              {r.label}
              {r.key === 'rate-limit' && r.count > 0 && (
                <span class="operational-table__flag" title="A rate-limit event blocks review throughput"> ⚠ rate-limited</span>
              )}
            </td>
            <td>{r.count}</td>
            <td class="operational-table__exemplar">
              {r.exemplar ?? <span class="operational-section__empty">none this window</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** See stats.ts's module doc comment above `ErrorCategory` for exactly what
 *  each bucket matches. Cross-references the Integrity panel's "Error rate"
 *  section rather than duplicating it — that section reports the error RATE
 *  (count/total, thresholded at 10% — `ERROR_RATE_ATTENTION_THRESHOLD`,
 *  stats-ribbon.tsx); this one reports error CATEGORY, a different axis. */
function ErrorBreakdownSection({ data }: { data: OperationalStats }) {
  const view = buildErrorBreakdownSectionView(data.errorClassification);
  return (
    <OperationalSection title="Error breakdown" status={view.status}>
      <p class="operational-section__summary">
        {view.status === 'attention' && <strong class="operational-tag operational-tag--attention">Needs attention: </strong>}
        {view.summary}
      </p>
      <ErrorBreakdownTable rows={view.rows} />
      {view.otherCount > 0 && (
        <p class="operational-section__note">
          <strong class="operational-tag operational-tag--caveat">Known instrument caveat: </strong>
          {describeOtherErrorsCaveat(view.otherCount)}
        </p>
      )}
      <p class="operational-section__note">
        See the{' '}
        <a class="operational-section__link" href="#stats-slot-integrity">Integrity panel's "Error rate" section</a>{' '}
        for the undifferentiated error RATE this window — this table is a breakdown by category, not a second rate.
      </p>
    </OperationalSection>
  );
}

/**
 * The Operational panel — replaces the `stats-slot-operational` placeholder
 * `<StatsSlot>` (Task 4) with the real body, keeping the same outer
 * `stats-slot stats-slot--{status}` wrapper and header markup so the
 * loading/error border-colour CSS carries over unchanged, matching Tasks
 * 6/7/8's precedent.
 */
export function OperationalPanel() {
  const view = buildOperationalPanelView(operationalStats.value);
  const window = statsWindow.value;
  return (
    <section id="stats-slot-operational" class={`stats-slot stats-slot--${view.status}`} aria-label="Operational">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Operational</h3>
        <span class="stats-slot__window" title="Time window this section reads">{window}</span>
      </div>
      <CardGlossary terms={TERMS} />
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>
          {view.message}
        </p>
      ) : (
        <div class="operational-panel">
          {view.data!.lowSample && (
            <p class="operational-panel__low-sample">
              Small sample: n={view.data!.sampleSize} in this window — every statistic below is a small-sample reading.
            </p>
          )}
          <ReviewsPerDaySection data={view.data!} />
          <DurationTurnsSection data={view.data!} />
          <ToolMixSection data={view.data!} />
          <RepoBreakdownSection data={view.data!} />
          <ErrorBreakdownSection data={view.data!} />
        </div>
      )}
    </section>
  );
}
