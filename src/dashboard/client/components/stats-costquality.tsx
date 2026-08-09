import { costStats, qualityStats, statsWindow } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { CostStats, QualityStats, SubAgentCoverage, CostPerReadBandItem, ModelUsageEntry } from '../../stats.ts';
import { formatCost, formatPct } from '../format.ts';
import { MIN_RELIABLE_COVERAGE_PCT } from '../../coverage-thresholds.ts';
import { countOf } from '../../count-phrase.ts';
import { worstStatus, NO_MODEL_ACTIVITY_TEXT, FLAGGED_MODEL_KEY_TOOLTIP } from '../assessors.ts';

// ---------------------------------------------------------------------------
// Cost + Quality cards (Task 8) — Sections B and C. Replaces the
// `stats-slot-cost-quality` placeholder (Task 4), keeping the same outer
// `stats-slot stats-slot--{status}` wrapper and header markup so the
// loading/error border-colour CSS carries over unchanged, matching Task 6/7's
// precedent. Unlike Integrity/Config (one gating fetch each), this slot reads
// TWO independent fetches (`costStats`, `qualityStats`) that can each be in a
// different loading/error/empty/ready state — the outer wrapper's status is
// the worst of the two, via `worstStatus` (`../assessors.ts`). That module
// holds no component, so importing it here carries no cycle risk — unlike
// importing straight from stats-view.tsx, which imports THIS file's exported
// panel component (the reason this card used to hand-roll its own
// worst-of-two helper instead).
//
// Unit convention used throughout this file (tests pin this so a mismatch
// fails loudly, not silently): a value PURELY COMPUTED here (never sent by
// the server) that pairs with `%`-suffixed prose is a 0..1 FRACTION,
// formatted by CALLING `format.ts`'s `formatPct` — see the severity/read-band
// split summary (`SeverityDistributionSection`) and the verdict table
// (`VerdictTable`), both of which call it directly rather than re-deriving
// the same `x == null ? 'n/a' : (x*100).toFixed(1)+'%'` string. The ONE
// deliberate exception is the severity legend's swatch line
// (`SeverityLegend`), which rounds to 0 decimals instead of `formatPct`'s
// fixed 1 — commented at that call site, not silently inconsistent. A value
// that mirrors a server field already named `...Pct` (`orchestratorSharePctMax`,
// `coveragePct`, `belowBandPct`) is left at the server's OWN 0..100 scale and
// formatted with this file's own `formatPctValue` — feeding one of those
// straight into `formatPct` would silently re-multiply by 100. Position/width
// values destined for inline `style={{ width, left }}` are always 0..100.
//
// Three deliberate chart choices, one per the brief:
//   B1. Cost split — ONE stacked bar, exact total + a KNOWN-BIASED split
//       point (never accent — a documented instrument/coverage limitation,
//       not a confirmed finding; see the "Known instrument caveat:" tag).
//   C1. Read-band gauge — a single value positioned against a shaded danger
//       zone (<2.5) and a healthy band (3.5-4), so drift toward the danger
//       zone is visible before the value actually crosses into it.
//   C2. Severity distribution — a stacked bar with a SOLID divider between
//       the read-band (critical+major) and below-band (minor+nitpick)
//       segments. Solid, not dashed: unlike the cost split, this boundary is
//       exact ground truth (findings_list severities), not an estimate.
// ---------------------------------------------------------------------------

type PanelStatus = 'loading' | 'error' | 'empty' | 'ready';
type SectionStatus = 'ok' | 'attention' | 'neutral';

/** A server field already scaled 0..100 (name ends in `Pct`). Never route
 *  one of these through `formatPct` (format.ts), which expects a 0..1
 *  fraction and would multiply by 100 a second time. */
function formatPctValue(pct: number | null): string {
  return pct == null ? 'n/a' : `${pct.toFixed(1)}%`;
}

function formatCostOrNA(v: number | null): string {
  return v == null ? 'n/a' : formatCost(v);
}

// ---------------------------------------------------------------------------
// Cost — pure view-model builders
// ---------------------------------------------------------------------------

export interface CostSplitView {
  hasCost: boolean;
  totalCostUsd: number;
  orchestratorCostUsd: number;
  subAgentCostUsd: number;
  /** 0..100, for direct width styling. Reuses the server's own
   *  `orchestratorSharePctMax` (single source of truth) rather than
   *  recomputing it — see `subAgentPct` below for the one figure the server
   *  does not already provide. */
  orchestratorPct: number;
  /** 0..100. No `subAgentSharePctMin` field exists on the wire, so this is
   *  computed here — exact-by-construction complement of `orchestratorPct`
   *  (`subAgentCostUsdMin / totalCostUsd`), not assumed equal to
   *  `100 - orchestratorPct`. */
  subAgentPct: number;
}

export function buildCostSplitView(data: CostStats): CostSplitView {
  const { totalCostUsd, orchestratorSubAgentSplit: split } = data;
  const hasCost = totalCostUsd > 0;
  return {
    hasCost,
    totalCostUsd,
    orchestratorCostUsd: split.orchestratorCostUsdMax,
    subAgentCostUsd: split.subAgentCostUsdMin,
    orchestratorPct: hasCost ? (split.orchestratorSharePctMax ?? 0) : 0,
    subAgentPct: hasCost ? (split.subAgentCostUsdMin / totalCostUsd) * 100 : 0,
  };
}

/** The structured coverage numbers, always shown next to the bar regardless
 *  of `lowCoverage` — "never render the split without its coverage." */
export function describeCoverage(coverage: SubAgentCoverage): string {
  return `${coverage.rowsWithSubAgentData}/${coverage.totalRows} rows carry sub-agent telemetry (${formatPctValue(coverage.coveragePct)})`;
}

/** A short, glance-level callout shown ONLY when `coverage.lowCoverage` is
 *  true — the full causal explanation (roster undercount AND instrumentation
 *  absence) already lives in `orchestratorSubAgentSplit.note` and is
 *  rendered verbatim elsewhere (single source of truth, matching
 *  stats-integrity.tsx's `dispatch.note` passthrough precedent); this
 *  function adds nothing to that account, it only decides WHETHER a
 *  glanceable warning belongs directly under the bar, using the boolean the
 *  server already computed rather than re-deriving the 50% threshold here.
 *  "An operator glancing at a 90d bar must not conclude 'review cost is
 *  structural, stop optimising'" (task-8-brief) is exactly the failure mode
 *  a long paragraph below the bar does not prevent on its own. */
export function buildLowCoverageHeadline(coverage: SubAgentCoverage): string | null {
  if (!coverage.lowCoverage) return null;
  return `Only ${formatPctValue(coverage.coveragePct)} of this window's rows carry sub-agent telemetry — treat the split point as unreliable. The total above is still exact.`;
}

export function formatCostPerReadBandItem(c: CostPerReadBandItem): string {
  if (c.value == null) {
    return 'n/a — no rows with both cost and findings recorded, or every eligible row had zero critical or major items';
  }
  return `${formatCost(c.value)} per critical or major item (avg cost ${formatCost(c.avgCostUsd!)} ÷ avg ${c.avgReadBandItems!.toFixed(2)} items/review, n=${c.sampleSize})`;
}

export interface ModelCostAssessment {
  status: 'ok' | 'attention';
  text: string;
}

/** Reuses the SAME `flagged` field the Integrity panel's "Model usage"
 *  section reads (server-computed via the `[1m]` pattern in stats.ts) —
 *  this does not re-derive contamination detection, only re-presents it
 *  through a cost lens ("how much did the flagged key cost"). */
export function assessModelBreakdownCost(modelBreakdown: ModelUsageEntry[]): ModelCostAssessment {
  const flagged = modelBreakdown.filter((m) => m.flagged);
  if (flagged.length === 0) {
    return { status: 'ok', text: `${countOf(modelBreakdown.length, 'model')} billed in this window, none flagged` };
  }
  const flaggedCost = flagged.reduce((s, m) => s + m.totalCostUsd, 0);
  return {
    status: 'attention',
    text: `${countOf(flagged.length, 'flagged model')} costing ${formatCost(flaggedCost)}: ${flagged.map((m) => m.model).join(', ')} — see the Integrity panel's Model usage section`,
  };
}

// ---------------------------------------------------------------------------
// Quality — read-band gauge (avg read-band items vs danger/healthy zones)
// ---------------------------------------------------------------------------

/** Below this, a review is surfacing too few critical/major findings on
 *  average — a genuine, actionable finding (task-8-brief: "shaded danger
 *  zone below 2.5"). */
export const READ_BAND_DANGER_MAX = 2.5;
/** "Healthy is ≈3.5-4" (task-8-brief) — a target BAND, not a hard pass/fail
 *  line; values above 4 are not flagged as unhealthy, there is simply no
 *  named ceiling. */
export const READ_BAND_HEALTHY_RANGE: readonly [number, number] = [3.5, 4];
/** Display-scale upper bound for the gauge only — a judgement call (mirrors
 *  `BAR_MAX_COMMITS` in stats-ribbon.tsx), not a measured figure. Chosen so
 *  the wide danger zone (0-2.5) reads as the dominant lower half of the
 *  scale and the healthy band still has visible width, rather than being
 *  compressed to a sliver by an arbitrarily large ceiling. A value above
 *  this is clamped for the marker's POSITION only — the exact value is
 *  always in the accompanying text, never silently rounded. */
export const READ_BAND_GAUGE_SCALE_MAX = 5;

export const READ_BAND_DANGER_ZONE_PCT = (READ_BAND_DANGER_MAX / READ_BAND_GAUGE_SCALE_MAX) * 100;
export const READ_BAND_HEALTHY_ZONE_START_PCT = (READ_BAND_HEALTHY_RANGE[0] / READ_BAND_GAUGE_SCALE_MAX) * 100;
export const READ_BAND_HEALTHY_ZONE_END_PCT = (READ_BAND_HEALTHY_RANGE[1] / READ_BAND_GAUGE_SCALE_MAX) * 100;

export type ReadBandLevel = 'danger' | 'watch' | 'healthy' | 'unknown';

/** Three levels, not two — this is the reason the gauge exists rather than a
 *  binary pass/fail dot. `'watch'` (>=2.5, <3.5) is the band between danger
 *  and healthy: not yet a confirmed finding, but distinctly NOT healthy
 *  either. Without it, a value like today's live ~2.96-3.0 would have to be
 *  rounded into 'healthy' (false reassurance) or 'danger' (false alarm) —
 *  exactly the "make sure the design reads correctly at that value" case
 *  task-8-brief calls out by name. */
export function classifyReadBandLevel(avgReadBandItems: number | null): ReadBandLevel {
  if (avgReadBandItems == null) return 'unknown';
  if (avgReadBandItems < READ_BAND_DANGER_MAX) return 'danger';
  if (avgReadBandItems < READ_BAND_HEALTHY_RANGE[0]) return 'watch';
  return 'healthy';
}

/** 0..100 marker position on the gauge track. Clamped to the scale's bounds
 *  — see `READ_BAND_GAUGE_SCALE_MAX`'s doc comment for why the clamp is
 *  positional only. */
export function readBandGaugePosition(value: number): number {
  const clamped = Math.min(Math.max(value, 0), READ_BAND_GAUGE_SCALE_MAX);
  return (clamped / READ_BAND_GAUGE_SCALE_MAX) * 100;
}

export interface ReadBandCoverage {
  rowsWithFindings: number;
  totalRows: number;
  coveragePct: number | null;
  lowCoverage: boolean;
}

/** What fraction of the window's reviews actually have `findings_list`
 *  recorded — the population the gauge's `avgReadBandItems` is itself
 *  averaged over (`readBandSampleSize`), against the window's total
 *  (`sampleSize`). `totalRows === 0` (zero-denominator: not reachable in
 *  practice once the panel is `'ready'` — `classifyWindowedResponse`
 *  already routes a zero-row window to `'empty'` before this runs — but
 *  this function is pure and must not divide by zero for a caller that
 *  hands it one anyway) reads as `coveragePct: null`, never `NaN` or a
 *  fake `0%`/`100%`. */
export function computeReadBandCoverage(readBandSampleSize: number, sampleSize: number): ReadBandCoverage {
  const coveragePct = sampleSize > 0 ? (readBandSampleSize / sampleSize) * 100 : null;
  return {
    rowsWithFindings: readBandSampleSize,
    totalRows: sampleSize,
    coveragePct,
    lowCoverage: coveragePct != null && coveragePct < MIN_RELIABLE_COVERAGE_PCT,
  };
}

/** The structured coverage numbers, always shown next to the gauge —
 *  mirrors `describeCoverage` (cost split) exactly: coverage is disclosed
 *  regardless of whether it happens to be low this window. */
export function describeReadBandCoverage(coverage: ReadBandCoverage): string {
  return `${coverage.rowsWithFindings}/${coverage.totalRows} reviews in this window carry findings data (${formatPctValue(coverage.coveragePct)})`;
}

/** A short, glance-level callout shown ONLY when `coverage.lowCoverage` is
 *  true — mirrors `buildLowCoverageHeadline` (cost split). Derives purely
 *  from the already-computed boolean/percentage, not a re-derivation of the
 *  50% threshold at the call site. */
export function buildReadBandLowCoverageHeadline(coverage: ReadBandCoverage): string | null {
  if (!coverage.lowCoverage) return null;
  return `Only ${formatPctValue(coverage.coveragePct)} of this window's reviews carry findings data — the average above reflects that subset, not the full window. This is a recently added kind of data; older reviews have none recorded.`;
}

export interface ReadBandGaugeView {
  level: ReadBandLevel;
  value: number | null;
  /** 0..100, or `null` when there is no value to place on the track. */
  position: number | null;
  sampleSize: number;
  /** From the endpoint's own `WindowMeta.lowSample` (whole-window row
   *  count) — deliberately DISTINCT from `coverage.lowCoverage` below, the
   *  same way the cost card keeps `WindowMeta.lowSample` and
   *  `orchestratorSubAgentSplit.coverage.lowCoverage` separate. A window can
   *  be `lowSample: false` (plenty of total rows, e.g. 334 over 30d) and
   *  still `coverage.lowCoverage: true` (few of those rows carry
   *  `findings_list`) at the same time — exactly today's live 30d reading. */
  lowSample: boolean;
  /** What fraction of the window's reviews the average is actually computed
   *  over. Fix round 1: this was missing entirely — the gauge rendered
   *  `avgReadBandItems` as if it summarised the whole window, when it can
   *  reflect as little as ~23% of it (76 of 334 rows on the live 30d
   *  window). */
  coverage: ReadBandCoverage;
  text: string;
}

/** The words for each read-band level — shared by the visible summary text and the gauge's aria-label
 *  (see `ReadBandGauge` in this file), so a screen-reader user gets the same clause a sighted user
 *  reads instead of the bare enum key spliced into a sentence. Mirrors Task 6's precedent that an
 *  aria-label and its adjacent visible text must render the same clause from one source of truth. */
export function describeReadBandLevel(level: ReadBandLevel): string {
  switch (level) {
    case 'danger':
      return 'in the danger zone (below 2.5) — reviews are surfacing too few critical or major findings on average';
    case 'watch':
      return 'below the healthy band (3.5-4) and approaching the danger zone (below 2.5)';
    case 'healthy':
      return 'within or above the healthy band (3.5-4)';
    case 'unknown':
      return 'no findings data to classify';
  }
}

export function buildReadBandGaugeView(quality: QualityStats): ReadBandGaugeView {
  const { avgReadBandItems, readBandSampleSize, lowSample, sampleSize } = quality;
  const level = classifyReadBandLevel(avgReadBandItems);
  const position = avgReadBandItems == null ? null : readBandGaugePosition(avgReadBandItems);
  const valueText = avgReadBandItems == null ? 'n/a' : avgReadBandItems.toFixed(2);
  const levelText = describeReadBandLevel(level);
  return {
    level,
    value: avgReadBandItems,
    position,
    sampleSize: readBandSampleSize,
    lowSample,
    coverage: computeReadBandCoverage(readBandSampleSize, sampleSize),
    text: `avg critical or major findings per review: ${valueText} — ${levelText} (n=${readBandSampleSize})`,
  };
}

// ---------------------------------------------------------------------------
// Quality — severity distribution with a read-band/below-band divider
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'nitpick'] as const;
export type SeverityKey = (typeof SEVERITY_ORDER)[number];

export interface SeveritySegmentView {
  key: SeverityKey;
  count: number;
  /** 0..1 fraction of the window's total findings, or `null` when there are
   *  no findings at all to divide by. Pairs with `formatPct` (format.ts). */
  pct: number | null;
}

/** Ordered critical -> major -> minor -> nitpick, matching read-band order,
 *  so the divider always lands between index 1 and 2. */
export function buildSeveritySegments(dist: Record<string, number>): SeveritySegmentView[] {
  const total = SEVERITY_ORDER.reduce((s, k) => s + (dist[k] ?? 0), 0);
  return SEVERITY_ORDER.map((key) => {
    const count = dist[key] ?? 0;
    return { key, count, pct: total > 0 ? count / total : null };
  });
}

export interface ReadBandSplitView {
  readBandCount: number;
  belowBandCount: number;
  total: number;
  readBandRate: number | null;
  belowBandRate: number | null;
}

/** Per-FINDING split (severityDistribution counts individual findings) —
 *  deliberately distinct from `QualityStats.belowBandCount`/`belowBandPct`,
 *  which count ROWS (a whole review with zero critical/major findings). The
 *  two must never be conflated: a review with one critical and five minor
 *  findings counts toward read-band here but is NOT a "below-band row." */
export function buildReadBandSplitView(dist: Record<string, number>): ReadBandSplitView {
  const readBandCount = (dist['critical'] ?? 0) + (dist['major'] ?? 0);
  const belowBandCount = (dist['minor'] ?? 0) + (dist['nitpick'] ?? 0);
  const total = readBandCount + belowBandCount;
  return {
    readBandCount,
    belowBandCount,
    total,
    readBandRate: total > 0 ? readBandCount / total : null,
    belowBandRate: total > 0 ? belowBandCount / total : null,
  };
}

// ---------------------------------------------------------------------------
// Panel-level views — one FetchState in, one thing to render out. Mirrors
// `buildIntegrityPanelView`/`buildConfigPanelView`'s shape.
// ---------------------------------------------------------------------------

export interface CostPanelView {
  status: PanelStatus;
  message: string | null;
  data: CostStats | null;
}

export function buildCostPanelView(state: FetchState<CostStats>): CostPanelView {
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

export interface QualityPanelView {
  status: PanelStatus;
  message: string | null;
  data: QualityStats | null;
}

export function buildQualityPanelView(state: FetchState<QualityStats>): QualityPanelView {
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
// Rendering — Cost card
// ---------------------------------------------------------------------------

function CostSection({ title, status, children }: { title: string; status: SectionStatus; children: any }) {
  return (
    <div class={`cost-section cost-section--${status}`}>
      <h5 class="cost-section__title">{title}</h5>
      <div class="cost-section__body">{children}</div>
    </div>
  );
}

function CostSplitSection({ data }: { data: CostStats }) {
  const view = buildCostSplitView(data);
  const headline = buildLowCoverageHeadline(data.orchestratorSubAgentSplit.coverage);
  return (
    <CostSection title="Orchestrator vs sub-agent split" status="neutral">
      {!view.hasCost ? (
        <p class="cost-section__empty">No cost recorded in this window.</p>
      ) : (
        <>
          <div
            class="cost-bar"
            role="img"
            aria-label={`Cost split: ${formatCost(view.orchestratorCostUsd)} orchestrator at most, ${formatCost(view.subAgentCostUsd)} sub-agent at least, of ${formatCost(view.totalCostUsd)} total`}
          >
            <div class="cost-bar__segment cost-bar__segment--orchestrator" style={{ width: `${view.orchestratorPct}%` }} />
            <div class="cost-bar__segment cost-bar__segment--subagent" style={{ width: `${view.subAgentPct}%` }} />
            {/* Dashed, not solid — the boundary itself is a biased estimate,
                never an exact figure (see the note below). The bar's outer
                edges (0 and the full width) ARE exact: totalCostUsd is a
                real sum, not a split. */}
            <div class="cost-bar__uncertain-boundary" aria-hidden="true" style={{ left: `${view.orchestratorPct}%` }} />
          </div>
          <p class="cost-section__summary">
            Total <strong>{formatCost(view.totalCostUsd)}</strong> (exact) — orchestrator{' '}
            <strong>{formatCost(view.orchestratorCostUsd)}</strong> (≤ {view.orchestratorPct.toFixed(1)}%) · sub-agent{' '}
            <strong>{formatCost(view.subAgentCostUsd)}</strong> (≥ {view.subAgentPct.toFixed(1)}%)
          </p>
          <p class="cost-section__summary">Coverage: {describeCoverage(data.orchestratorSubAgentSplit.coverage)}</p>
          {headline && (
            <p class="cost-section__note">
              <strong class="cost-tag cost-tag--caveat">Known instrument caveat: </strong>
              {headline}
            </p>
          )}
          <p class="cost-section__note">
            <strong class="cost-tag cost-tag--caveat">Known instrument caveat: </strong>
            {data.orchestratorSubAgentSplit.note}
          </p>
        </>
      )}
    </CostSection>
  );
}

/** The Cost card's sampling note.
 *
 *  `monthlyProjection.basis` is a NOUN PHRASE ("linear extrapolation of the 30d
 *  window total"), kept as one so the payload field stays composable and the
 *  sentence is built in exactly one place — HERE, not at the field. Appending
 *  it after a full stop rendered a subjectless lowercase fragment — "…150
 *  total rows. linear extrapolation of the 30d window total." */
export function describeCostSampleNote(d: {
  costSampleSize: number;
  sampleSize: number;
  monthlyProjection: { basis: string };
}): string {
  return `Median, P90 and average are computed over ${countOf(d.costSampleSize, 'row')} with cost ` +
    `recorded, which may differ from this window's ${countOf(d.sampleSize, 'row')} in total. ` +
    `Monthly projection is a ${d.monthlyProjection.basis}.`;
}

function CostOverviewSection({ data }: { data: CostStats }) {
  return (
    <CostSection title="Cost overview" status="neutral">
      <dl class="cost-dl">
        <dt>Median</dt>
        <dd>{formatCostOrNA(data.medianCostUsd)}</dd>
        <dt>P90</dt>
        <dd>{formatCostOrNA(data.p90CostUsd)}</dd>
        <dt>Average</dt>
        <dd>{formatCostOrNA(data.avgCostUsd)}</dd>
        <dt>Total this window</dt>
        <dd>{formatCost(data.totalCostUsd)}</dd>
        <dt>Monthly projection</dt>
        <dd>{formatCostOrNA(data.monthlyProjection.value)}</dd>
      </dl>
      <p class="cost-section__note">{describeCostSampleNote(data)}</p>
    </CostSection>
  );
}

/**
 * I-1: this is the decisive cost metric on the whole card, and it used to
 * render a bare `n=X` with no coverage disclosure — while the Quality card's
 * read-band gauge, over the SAME eligible population (live: 76/1081 at 90d,
 * 76/334 at 30d — the two sample sizes match because in production no row
 * carries findings without also carrying cost), discloses `Coverage: 76/1081
 * (7.0%)` plus a "Known instrument caveat:" headline 130 lines below. Reuses
 * `computeReadBandCoverage`/`describeReadBandCoverage`/
 * `buildReadBandLowCoverageHeadline` verbatim rather than writing a second
 * coverage computation that could drift from the gauge's own.
 */
function CostPerItemSection({ data }: { data: CostStats }) {
  const c = data.costPerReadBandItem;
  const coverage = computeReadBandCoverage(c.sampleSize, data.sampleSize);
  const lowCoverageHeadline = buildReadBandLowCoverageHeadline(coverage);
  return (
    <CostSection title="Cost per critical or major item" status="neutral">
      <p class="cost-section__summary">{formatCostPerReadBandItem(c)}</p>
      <p class="cost-section__note">Eligible rows carry both cost and findings ({c.sampleSize} in this window).</p>
      <p class="cost-section__summary">Coverage: {describeReadBandCoverage(coverage)}</p>
      {lowCoverageHeadline && (
        <p class="cost-section__note">
          <strong class="cost-tag cost-tag--caveat">Known instrument caveat: </strong>
          {lowCoverageHeadline}
        </p>
      )}
    </CostSection>
  );
}

function ModelCostTable({ rows }: { rows: ModelUsageEntry[] }) {
  if (rows.length === 0) return <p class="cost-section__empty">{NO_MODEL_ACTIVITY_TEXT}</p>;
  return (
    <table class="cost-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Rows</th>
          <th>Cost</th>
          <th>Output tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.model} class={r.flagged ? 'cost-table__row--flagged' : ''}>
            <td class="cost-table__mono">
              {r.model}
              {r.flagged && (
                <span class="cost-table__flag" title={FLAGGED_MODEL_KEY_TOOLTIP}> ⚠ flagged</span>
              )}
            </td>
            <td>{r.rows}</td>
            <td>{formatCost(r.totalCostUsd)}</td>
            <td>{r.totalOutputTokens.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModelBreakdownSection({ data }: { data: CostStats }) {
  const a = assessModelBreakdownCost(data.modelBreakdown);
  return (
    <CostSection title="Cost by model" status={a.status}>
      <p class="cost-section__summary">
        {a.status === 'attention' && <strong class="cost-tag cost-tag--attention">Needs attention: </strong>}
        {a.text}
      </p>
      <ModelCostTable rows={data.modelBreakdown} />
      {/* I-2: this table and the Integrity panel's "Model usage" table are
          both `aggregateModelUsage` over the same window predicate — same
          columns, same `flagged` chip, same title in spirit. Without this
          note a reader has no way to tell they are not two independent
          measurements; the page would otherwise assert the same `[1m]`
          finding three times without ever saying so. */}
      <p class="cost-section__note">
        Same model-cost breakdown as the Integrity panel's "Model usage" table — shown here through a cost lens,
        not a second, independent measurement.
      </p>
    </CostSection>
  );
}

function PerRepoCostTable({ rows }: { rows: CostStats['perRepo'] }) {
  if (rows.length === 0) return <p class="cost-section__empty">No repo cost data recorded in this window.</p>;
  return (
    <table class="cost-table">
      <thead>
        <tr>
          <th>Repo</th>
          <th>Reviews</th>
          <th>Median cost</th>
          <th>Total cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.repoKey}>
            <td class="cost-table__mono">{r.repoKey}</td>
            <td>{r.count}</td>
            <td>{formatCostOrNA(r.medianCostUsd)}</td>
            <td>{formatCostOrNA(r.totalCostUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PerRepoCostSection({ data }: { data: CostStats }) {
  return (
    <CostSection title="Cost by repo" status="neutral">
      <PerRepoCostTable rows={data.perRepo} />
      {/* I-3: this "Reviews" column counts only rows with cost recorded
          (cost_usd IS NOT NULL); the Operational panel's own per-repo
          "Reviews" column counts every row regardless of cost. The two can
          legitimately disagree for the same repo (measured live at 90d, 5
          of 8 repos differ) — the Operational panel already discloses this
          on its side; this is the other half of that same disclosure. */}
      <p class="cost-section__note">
        "Reviews" here counts only rows with cost recorded — the Operational panel's own per-repo "Reviews" column
        counts every row, so the two can legitimately disagree for the same repo.
      </p>
    </CostSection>
  );
}

function CostCardBody({ data }: { data: CostStats }) {
  return (
    <div class="cost-card__body">
      {data.lowSample && (
        <p class="cost-panel__low-sample">
          Small sample: n={data.sampleSize} in this window — every statistic below is a small-sample reading.
        </p>
      )}
      <CostSplitSection data={data} />
      <CostOverviewSection data={data} />
      <CostPerItemSection data={data} />
      <ModelBreakdownSection data={data} />
      <PerRepoCostSection data={data} />
    </div>
  );
}

function CostCard({ view }: { view: CostPanelView }) {
  return (
    <div class="cost-card">
      <h4 class="cost-card__title">Cost</h4>
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>{view.message}</p>
      ) : (
        <CostCardBody data={view.data!} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rendering — Quality card
// ---------------------------------------------------------------------------

function QualitySection({ title, status, children }: { title: string; status: SectionStatus; children: any }) {
  return (
    <div class={`quality-section quality-section--${status}`}>
      <h5 class="quality-section__title">{title}</h5>
      <div class="quality-section__body">{children}</div>
    </div>
  );
}

function ReadBandGauge({ view }: { view: ReadBandGaugeView }) {
  const lowCoverageHeadline = buildReadBandLowCoverageHeadline(view.coverage);
  return (
    <QualitySection title="Critical or major findings per review" status={view.level === 'danger' ? 'attention' : 'neutral'}>
      {view.value == null ? (
        <p class="quality-section__empty">No findings data recorded in this window.</p>
      ) : (
        <>
          <div
            class="read-band-gauge__track"
            role="img"
            aria-label={`Average critical or major findings per review: ${view.value.toFixed(2)}, ${describeReadBandLevel(view.level)}`}
          >
            <div
              class="read-band-gauge__zone read-band-gauge__zone--danger"
              aria-hidden="true"
              style={{ left: '0%', width: `${READ_BAND_DANGER_ZONE_PCT}%` }}
            />
            <div
              class="read-band-gauge__zone read-band-gauge__zone--healthy"
              aria-hidden="true"
              style={{ left: `${READ_BAND_HEALTHY_ZONE_START_PCT}%`, width: `${READ_BAND_HEALTHY_ZONE_END_PCT - READ_BAND_HEALTHY_ZONE_START_PCT}%` }}
            />
            <div class={`read-band-gauge__marker read-band-gauge__marker--${view.level}`} aria-hidden="true" style={{ left: `${view.position}%` }} />
          </div>
          <div class="read-band-gauge__scale-labels" aria-hidden="true">
            <span class="read-band-gauge__scale-label" style={{ left: '0%' }}>0</span>
            <span class="read-band-gauge__scale-label" style={{ left: `${READ_BAND_DANGER_ZONE_PCT}%` }}>2.5 danger</span>
            <span class="read-band-gauge__scale-label" style={{ left: `${READ_BAND_HEALTHY_ZONE_START_PCT}%` }}>3.5</span>
            <span class="read-band-gauge__scale-label" style={{ left: `${READ_BAND_HEALTHY_ZONE_END_PCT}%` }}>4 healthy</span>
          </div>
        </>
      )}
      <p class="quality-section__summary">
        {view.level === 'danger' && <strong class="quality-tag quality-tag--attention">Needs attention: </strong>}
        {view.text}
      </p>
      <p class="quality-section__summary">Coverage: {describeReadBandCoverage(view.coverage)}</p>
      {lowCoverageHeadline && (
        <p class="quality-section__note">
          <strong class="quality-tag quality-tag--caveat">Known instrument caveat: </strong>
          {lowCoverageHeadline}
        </p>
      )}
      {/* Deferred #8: the panel-wide "Small sample: n=X ... every statistic
          below is a small-sample reading" banner (QualityCardBody, above
          this section) already covers this gauge — a second, narrower
          "Small sample this window" note here duplicated it every time
          `lowSample` was true. Deleted rather than the panel-wide one: the
          panel-wide banner is the one that actually says "every statistic
          below", so it is the more complete of the two. */}
    </QualitySection>
  );
}

function SeverityBar({ segments }: { segments: SeveritySegmentView[] }) {
  return (
    <div
      class="severity-bar"
      role="img"
      aria-label={`Severity distribution: ${segments.map((s) => `${s.key} ${s.count}`).join(', ')}`}
    >
      {segments.map((s) => (
        <div key={s.key} class={`severity-bar__segment severity-bar__segment--${s.key}`} style={{ width: `${(s.pct ?? 0) * 100}%` }} />
      ))}
    </div>
  );
}

function SeverityLegend({ segments }: { segments: SeveritySegmentView[] }) {
  return (
    <p class="severity-bar__legend">
      {segments.map((s, i) => (
        <span key={s.key} class="severity-bar__legend-item">
          <span class={`severity-bar__swatch severity-bar__swatch--${s.key}`} aria-hidden="true" />
          {/* Deliberately 0 decimals, not `formatPct` (fixed at 1) — four
              legend items already share one crowded line; an extra decimal
              per item adds width without adding a decision-relevant digit
              here (unlike the split summary below, where the two rates are
              the whole point of the sentence). */}
          {s.key} {s.count} ({s.pct == null ? 'n/a' : `${(s.pct * 100).toFixed(0)}%`})
          {i === 1 && <span class="severity-bar__legend-divider-note"> │ critical or major ends here</span>}
        </span>
      ))}
    </p>
  );
}

function SeverityDistributionSection({ data }: { data: QualityStats }) {
  const segments = buildSeveritySegments(data.severityDistribution);
  const split = buildReadBandSplitView(data.severityDistribution);
  return (
    <QualitySection title="Findings by severity" status="neutral">
      {split.total === 0 ? (
        <p class="quality-section__empty">No findings recorded in this window.</p>
      ) : (
        <>
          <SeverityBar segments={segments} />
          <SeverityLegend segments={segments} />
          <p class="quality-section__summary">
            Critical or major: <strong>{split.readBandCount}</strong> ({formatPct(split.readBandRate)}) · minor/nitpick:{' '}
            <strong>{split.belowBandCount}</strong> ({formatPct(split.belowBandRate)})
          </p>
        </>
      )}
    </QualitySection>
  );
}

function BelowBandRowsSection({ data }: { data: QualityStats }) {
  return (
    <QualitySection title="Reviews with zero critical or major findings" status="neutral">
      <p class="quality-section__summary">
        {data.belowBandCount} of {countOf(data.readBandSampleSize, 'review')} with findings recorded surfaced zero critical or major
        findings ({formatPctValue(data.belowBandPct)}).
      </p>
      <p class="quality-section__note">
        Counted by review, not by individual problem: a review with one critical problem and five minor ones counts
        toward the critical or major total above, but is not one of the reviews with zero critical or major findings counted here.
      </p>
    </QualitySection>
  );
}

// Named `verdictDistribution` in the payload, headed "Recommendation" on screen.
// The values are `pr_reviews.recommendation` (free text, z.string()), and the
// Review-value card's own verdict column (stats-review-value.tsx's did-breakdown
// table) heads an unrelated quantity — the `did` outcome. One word for two
// quantities in mono font on two cards reads as one thing. The table's own
// empty state below already names recommendations rather than that other
// quantity, in matching wording.
function VerdictTable({ dist }: { dist: Record<string, number> }) {
  const total = Object.values(dist).reduce((s, n) => s + n, 0);
  const rows = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p class="quality-section__empty">No recommendations recorded in this window.</p>;
  return (
    <table class="quality-table">
      <thead>
        <tr>
          <th>Recommendation</th>
          <th>Count</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([verdict, count]) => (
          <tr key={verdict}>
            <td class="quality-table__mono">{verdict}</td>
            <td>{count}</td>
            <td>{formatPct(total > 0 ? count / total : null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VerdictDistributionSection({ data }: { data: QualityStats }) {
  return (
    <QualitySection title="Recommendation distribution" status="neutral">
      <VerdictTable dist={data.verdictDistribution} />
    </QualitySection>
  );
}

function QualityCardBody({ data }: { data: QualityStats }) {
  return (
    <div class="quality-card__body">
      {data.lowSample && (
        <p class="quality-panel__low-sample">
          Small sample: n={data.sampleSize} in this window — every statistic below is a small-sample reading.
        </p>
      )}
      <ReadBandGauge view={buildReadBandGaugeView(data)} />
      <SeverityDistributionSection data={data} />
      <BelowBandRowsSection data={data} />
      <VerdictDistributionSection data={data} />
    </div>
  );
}

function QualityCard({ view }: { view: QualityPanelView }) {
  return (
    <div class="quality-card">
      <h4 class="quality-card__title">Quality</h4>
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>{view.message}</p>
      ) : (
        <QualityCardBody data={view.data!} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel — the real body replacing the `stats-slot-cost-quality` placeholder.
// ---------------------------------------------------------------------------

export function CostQualityPanel() {
  const costView = buildCostPanelView(costStats.value);
  const qualityView = buildQualityPanelView(qualityStats.value);
  // `worstStatus` takes `SlotSourceInfo[]` ({label, status, message}), not
  // bare statuses — the two-argument worst-of-two helper this replaced took
  // a shape this call site alone needed; adapting the call site (rather than
  // giving `worstStatus` a second signature) keeps the shared helper single-shaped.
  const overall = worstStatus([
    { label: 'Cost', status: costView.status, message: costView.message ?? '' },
    { label: 'Quality', status: qualityView.status, message: qualityView.message ?? '' },
  ]);
  const window = statsWindow.value;
  return (
    <section id="stats-slot-cost-quality" class={`stats-slot stats-slot--${overall}`} aria-label="Cost and Quality">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Cost &amp; Quality</h3>
        <span class="stats-slot__window" title="Time window this section reads">{window}</span>
      </div>
      <div class="cost-quality-grid">
        <CostCard view={costView} />
        <QualityCard view={qualityView} />
      </div>
    </section>
  );
}
