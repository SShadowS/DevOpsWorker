import { driftStats, integrityStats, configReport, statsWindow } from '../stats-store.ts';
import type { FetchState, StatsWindow } from '../stats-store.ts';
import type { DriftStats, IntegrityStats, HeadUnresolvedReason, ImageShaClass } from '../../stats.ts';
import type { ConfigReport, LeverStatus } from '../../config-report.ts';

// ---------------------------------------------------------------------------
// Status ribbon (Task 5) — "the reason this entire feature exists." Four
// independent indicators: deployment drift, model integrity, active levers,
// error rate. Each renders from its OWN fetch's loading/error/empty/ready
// cycle rather than gating on the worst of all three underlying endpoints —
// the drift comparison is worth reading even when the window holds zero PR
// reviews, so it must not vanish behind a generic "no data" message just
// because /api/stats/integrity came back empty for this window.
//
// 'ok' | 'attention' is a fifth state, reachable only once a card's data is
// ready. --color-accent is spent ONLY for 'attention' — see
// design-constraints.md: "the one place in the feature where spending it is
// correct — but only on genuine drift, not on chrome or on the healthy
// state." Every 'attention' state also carries a text explanation: colour is
// the second signal here, never the only one.
// ---------------------------------------------------------------------------

export type RibbonStatus = 'loading' | 'error' | 'empty' | 'ok' | 'attention';

// ---------------------------------------------------------------------------
// Pure logic — unit-tested with fixture data, no rendering, no network.
// ---------------------------------------------------------------------------

/** Words for a non-sha `image_sha` state. Distinguishes the three non-value
 *  states the design constraints require read as words, never as a blank or
 *  a fake sha: `'unknown'` (plain `docker compose build`), `''` (raw
 *  `docker build` skipping the arg), and `null`/`'not-recorded'` (row
 *  predates the feature — every row in production today). `'sha'` is only
 *  in the parameter type so the caller (`buildProvenanceRow`, whose
 *  `classification === 'sha' && value` guard is not narrow enough for TS to
 *  exclude it in the `else` branch) does not need an unsafe cast; it is
 *  unreachable in practice — a real sha always renders through the sha
 *  branch instead — and returns an empty string defensively rather than
 *  throwing if it is ever hit. */
export function describeNonShaState(classification: ImageShaClass): string {
  switch (classification) {
    case 'unknown':
      return 'not recorded (plain docker compose build, no BUILD_SHA)';
    case 'empty':
      return 'not recorded (docker build without the BUILD_SHA arg)';
    case 'not-recorded':
      return 'no build provenance recorded yet';
    case 'sha':
      return '';
  }
}

/** Words for why HEAD could not be resolved from the bind-mounted `.git`. */
export function describeHeadUnresolved(reason: HeadUnresolvedReason): string {
  switch (reason) {
    case 'not-mounted':
      return 'not observable (.git not mounted)';
    case 'not-a-directory':
      return 'not observable (.git is not a directory — worktree?)';
    case 'command-failed':
      return 'not observable (git command failed)';
    case 'timeout':
      return 'not observable (git timed out)';
    case 'empty-output':
      return 'not observable (git returned no output)';
  }
}

/** `null` reads as "distance unknown", never as 0 — a coerced 0 would read
 *  as "in sync" and is the exact lie this ribbon exists to prevent (see
 *  `computeCommitsBehindHead` in stats.ts). `0` itself reads as "in sync",
 *  a real, positive fact distinct from "we could not check". */
export function formatDistance(commitsBehindHead: number | null): string {
  if (commitsBehindHead == null) return 'distance unknown';
  if (commitsBehindHead === 0) return 'in sync';
  return `${commitsBehindHead} commit${commitsBehindHead === 1 ? '' : 's'} behind`;
}

/** One row of the three-sha provenance table. `display` is either a real
 *  short sha (`isSha: true`, render in `--font-mono`) or a human word for a
 *  non-sha state (`isSha: false`) — never a blank standing in for either.
 *  `barPosition` is decorative only (0 = far behind, 1 = at HEAD); `null`
 *  means "do not draw a dot", used whenever the value/distance itself is
 *  unknown so the bar never implies a position we have not measured. */
export interface ProvenanceRow {
  label: string;
  display: string;
  isSha: boolean;
  distanceText: string;
  barPosition: number | null;
}

/** Commits are clamped to this many for the decorative bar's scale only —
 *  the exact number is still shown in `distanceText` regardless of how far
 *  off-scale it is. A judgement call, not a measured figure. */
const BAR_MAX_COMMITS = 30;

function distanceToBarPosition(commitsBehindHead: number): number {
  const clamped = Math.min(Math.max(commitsBehindHead, 0), BAR_MAX_COMMITS);
  return 1 - clamped / BAR_MAX_COMMITS;
}

export function buildHeadRow(head: DriftStats['head']): ProvenanceRow {
  if (head.value) {
    return { label: 'HEAD', display: head.value, isSha: true, distanceText: '', barPosition: 1 };
  }
  return { label: 'HEAD', display: describeHeadUnresolved(head.reason!), isSha: false, distanceText: '', barPosition: null };
}

export function buildProvenanceRow(
  label: string,
  classification: ImageShaClass,
  value: string | null,
  commitsBehindHead: number | null,
): ProvenanceRow {
  if (classification === 'sha' && value) {
    return {
      label,
      display: value,
      isSha: true,
      distanceText: formatDistance(commitsBehindHead),
      barPosition: commitsBehindHead == null ? null : distanceToBarPosition(commitsBehindHead),
    };
  }
  return {
    label,
    display: describeNonShaState(classification),
    isSha: false,
    distanceText: '',
    barPosition: null,
  };
}

export function buildProvenanceRows(drift: DriftStats): ProvenanceRow[] {
  return [
    buildHeadRow(drift.head),
    buildProvenanceRow('spawned image', drift.spawnedImage.mostRecentSha.classification, drift.spawnedImage.mostRecentSha.value, drift.spawnedImage.mostRecentSha.commitsBehindHead),
    buildProvenanceRow('compose services', drift.composeService.classification, drift.composeService.value, drift.composeService.commitsBehindHead),
  ];
}

export interface DriftAssessment {
  severity: 'ok' | 'attention';
  warning: string | null;
}

/**
 * "Needs attention" unless the ribbon can POSITIVELY confirm the running
 * compose services match HEAD — silence/unknown is treated the same as
 * drift, never as sync, because unverifiable silence is exactly what let
 * the 2026-08-01 incident run for four hours. Keyed on `composeService`
 * specifically (not `spawnedImage`, which is informational only here) — the
 * long-running watcher/dashboard containers are what silently ran stale
 * code, not a one-shot spawned review container.
 */
export function assessDrift(drift: DriftStats): DriftAssessment {
  if (!drift.head.value) {
    return { severity: 'attention', warning: 'HEAD is not observable — deployment drift cannot be verified.' };
  }
  if (drift.composeService.classification !== 'sha') {
    return { severity: 'attention', warning: 'Running compose services carry no build provenance — cannot verify they match HEAD.' };
  }
  const behind = drift.composeService.commitsBehindHead;
  if (behind == null) {
    return {
      severity: 'attention',
      warning: "Compose services' build sha is not in the mounted history — distance unknown, sync cannot be confirmed.",
    };
  }
  if (behind > 0) {
    return {
      severity: 'attention',
      warning: `Compose services are ${behind} commit${behind === 1 ? '' : 's'} behind HEAD — config may be inert.`,
    };
  }
  return { severity: 'ok', warning: null };
}

export interface SimpleAssessment {
  severity: 'ok' | 'attention';
  text: string;
}

/** Flags contamination-pattern model keys (the specific `[1m]` long-context
 *  premium-tier suffix data-shapes.md calls out) — a real cost-attribution
 *  bug, not a stylistic nit, so any flagged key is 'attention'. */
export function assessModelIntegrity(integrity: IntegrityStats): SimpleAssessment {
  const flagged = integrity.modelUsage.flaggedKeys;
  if (flagged.length === 0) {
    return { severity: 'ok', text: `n=${integrity.sampleSize} · no flagged model keys` };
  }
  return {
    severity: 'attention',
    text: `${flagged.length} flagged model key(s): ${flagged.map((m) => m.model).join(', ')}`,
  };
}

/** Eval-only levers (`PR_REVIEW_NO_POST` and friends) are not expected to be
 *  active in normal production operation — one left on by accident is a
 *  silent behaviour change (e.g. `NO_POST=1` would mean nothing gets
 *  posted). Any active lever is therefore 'attention', named explicitly. */
export function assessLevers(levers: LeverStatus[]): SimpleAssessment {
  const active = levers.filter((l) => l.state === 'active');
  if (active.length === 0) {
    return { severity: 'ok', text: `0/${levers.length} eval levers active` };
  }
  return {
    severity: 'attention',
    text: `${active.length}/${levers.length} eval levers active: ${active.map((l) => l.key).join(', ')}`,
  };
}

/** A round, documented bar — not tuned to any observed value — mirroring
 *  `MIN_RELIABLE_COVERAGE_PCT`'s precedent in stats.ts. */
export const ERROR_RATE_ATTENTION_THRESHOLD = 0.1;

/** Small samples say so: a 7d window can hold a handful of reviews, where a
 *  single error swings the rate wildly. `lowSample` (from the endpoint's own
 *  `WindowMeta`) gates the wording, never the number itself — the rate is
 *  still shown, just annotated as unreliable rather than omitted. */
export function assessErrorRate(errorRate: IntegrityStats['errorRate'], lowSample: boolean): SimpleAssessment {
  if (errorRate.total === 0) {
    return { severity: 'ok', text: 'no reviews recorded in this window' };
  }
  const pct = errorRate.rate == null ? 'n/a' : `${(errorRate.rate * 100).toFixed(1)}%`;
  const sampleNote = lowSample ? `small sample, n=${errorRate.total}` : `n=${errorRate.total}`;
  const attention = errorRate.rate != null && errorRate.rate > ERROR_RATE_ATTENTION_THRESHOLD;
  return { severity: attention ? 'attention' : 'ok', text: `${errorRate.count}/${errorRate.total} errored — ${pct} (${sampleNote})` };
}

// ---------------------------------------------------------------------------
// Per-card view models — fold a FetchState into the one shape the component
// renders, so every loading/error/empty branch is exhaustively handled in
// one place per card rather than repeated in JSX.
// ---------------------------------------------------------------------------

export interface DriftCardView {
  status: RibbonStatus;
  message: string | null;
  rows: ProvenanceRow[] | null;
  warning: string | null;
}

export function buildDriftCard(state: FetchState<DriftStats>): DriftCardView {
  switch (state.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading…', rows: null, warning: null };
    case 'error':
      return { status: 'error', message: `Failed to load: ${state.message}`, rows: null, warning: null };
    case 'empty':
      // Not reachable in practice — classifyDriftResponse never returns
      // 'empty' (see stats-store.ts) — kept for exhaustiveness against the
      // shared FetchState<T> union.
      return { status: 'empty', message: 'No data recorded in this window.', rows: null, warning: null };
    case 'ready': {
      const { severity, warning } = assessDrift(state.data);
      return { status: severity, message: null, rows: buildProvenanceRows(state.data), warning };
    }
  }
}

export interface SimpleCardView {
  status: RibbonStatus;
  text: string;
}

function simpleCardFromFetch<T>(state: FetchState<T>, assess: (data: T) => SimpleAssessment): SimpleCardView {
  switch (state.status) {
    case 'loading':
      return { status: 'loading', text: 'Loading…' };
    case 'error':
      return { status: 'error', text: `Failed to load: ${state.message}` };
    case 'empty':
      return { status: 'empty', text: 'No data recorded in this window.' };
    case 'ready': {
      const a = assess(state.data);
      return { status: a.severity, text: a.text };
    }
  }
}

export function buildModelIntegrityCard(state: FetchState<IntegrityStats>): SimpleCardView {
  return simpleCardFromFetch(state, assessModelIntegrity);
}

export function buildLeversCard(state: FetchState<ConfigReport>): SimpleCardView {
  return simpleCardFromFetch(state, (d) => assessLevers(d.evalLevers));
}

export function buildErrorRateCard(state: FetchState<IntegrityStats>): SimpleCardView {
  return simpleCardFromFetch(state, (d) => assessErrorRate(d.errorRate, d.lowSample));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ProvenanceTable({ rows }: { rows: ProvenanceRow[] }) {
  return (
    <div class="status-ribbon__provenance">
      {rows.map((row) => (
        <div class="status-ribbon__provenance-row" key={row.label}>
          <span class="status-ribbon__provenance-label">{row.label}</span>
          <span class={`status-ribbon__provenance-value ${row.isSha ? 'status-ribbon__sha' : ''}`}>{row.display}</span>
          <span class="status-ribbon__bar" aria-hidden="true">
            {row.barPosition != null && (
              <span class="status-ribbon__bar-dot" style={{ left: `${row.barPosition * 100}%` }} />
            )}
          </span>
          {row.distanceText && <span class="status-ribbon__distance">{row.distanceText}</span>}
        </div>
      ))}
    </div>
  );
}

function DriftCard() {
  const view = buildDriftCard(driftStats.value);
  return (
    <div class={`status-ribbon__item status-ribbon__item--${view.status}`} role="group" aria-label="Deployment drift">
      <h3 class="status-ribbon__item-label">Deployment drift</h3>
      {view.rows ? <ProvenanceTable rows={view.rows} /> : <p class="status-ribbon__item-text">{view.message}</p>}
      {view.warning && <p class="status-ribbon__warning">⚠ {view.warning}</p>}
    </div>
  );
}

interface SimpleCardProps {
  label: string;
  view: SimpleCardView;
  /** Omit for unwindowed data (active levers) — the omission itself is the
   *  correct signal, matching `StatsSlot`'s `window` prop in stats-view.tsx.
   *  Model integrity and error rate ARE windowed (both read from
   *  `IntegrityStats`, scoped to the shared `statsWindow`), so every
   *  statistic here still shows the window it reads — constraint #2. */
  window?: StatsWindow;
}

function SimpleCard({ label, view, window }: SimpleCardProps) {
  return (
    <div class={`status-ribbon__item status-ribbon__item--${view.status}`} role="group" aria-label={label}>
      <div class="status-ribbon__item-header">
        <h3 class="status-ribbon__item-label">{label}</h3>
        {window && <span class="status-ribbon__window" title="Time window this indicator reads">{window}</span>}
      </div>
      <p class="status-ribbon__item-text">
        {view.status === 'attention' && <strong class="status-ribbon__attention-tag">Needs attention: </strong>}
        {view.text}
      </p>
    </div>
  );
}

/**
 * The status ribbon — persistent, directly under the tabs, above everything
 * else in the Stats & Config tab. Reads its source signals directly (no
 * props drilling, matching the rest of the tab's data-access pattern).
 * Deployment drift and active levers are deliberately unwindowed (the shas
 * are not time-series data, and `/api/config` has no window param at all);
 * model integrity and error rate are, and show it.
 */
export function StatsRibbon() {
  const integrity = integrityStats.value;
  const window = statsWindow.value;
  return (
    <section class="status-ribbon" aria-label="Status ribbon">
      <DriftCard />
      <SimpleCard label="Model integrity" view={buildModelIntegrityCard(integrity)} window={window} />
      <SimpleCard label="Active levers" view={buildLeversCard(configReport.value)} />
      <SimpleCard label="Error rate" view={buildErrorRateCard(integrity)} window={window} />
    </section>
  );
}
