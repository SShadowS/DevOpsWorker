import { driftStats, ribbonIntegrityStats, configReport, statsWindow } from '../stats-store.ts';
import type { FetchState, StatsWindow } from '../stats-store.ts';
import type { DriftStats, IntegrityStats, HeadUnresolvedReason, ImageShaClass } from '../../stats.ts';
import type { ConfigReport } from '../../config-report.ts';
import { buildContaminationAvailability } from '../model-contamination.ts';
import { assessModelIntegrity, assessLevers, assessErrorRate } from '../assessors.ts';
import type { SimpleAssessment } from '../assessors.ts';
import { countOf } from '../../count-phrase.ts';

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
//
// Task 4 (Prod|Test control): this ribbon reads `ribbonIntegrityStats`, NOT
// the shared `integrityStats` the Integrity panel reads — `integrityStats`
// follows the Prod/Test toggle now (stats-store.ts), and the ribbon sits
// directly above panels that DO follow it. A ribbon that silently flipped to
// Test data underneath a "production only" label would be exactly the
// ambiguous-reading failure this tab exists to catch. `ribbonIntegrityStats`
// is always production, regardless of the toggle — see its doc comment in
// stats-store.ts. `configReport`/`driftStats` need no equivalent: both are
// already population-independent.
//
// Fix round 2 (task-6): "Model integrity" now folds in model CONTAMINATION
// (a sub-agent running on a model other than its declared frontmatter pin),
// not just the `[1m]`-flagged-key pattern it originally covered — the plan
// specifies four indicators, and contamination IS model integrity, not a
// fifth thing. This makes the card depend on TWO fetches (`integrityStats`
// AND `configReport`, the latter shared with the "Active levers" card below)
// — see `assessModelIntegrity`/`buildModelIntegrityCard`.
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
  return `${countOf(commitsBehindHead, 'commit')} behind`;
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
    return { severity: 'attention', warning: 'Running compose services have no build provenance — cannot verify they match HEAD.' };
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
      warning: `Compose services are ${countOf(behind, 'commit')} behind HEAD — config may be inert.`,
    };
  }
  return { severity: 'ok', warning: null };
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

/**
 * Unlike the other three cards, this one depends on TWO fetches
 * (`integrityState` for the observed side, `configState` for declared pins —
 * fix round 2), so it cannot use the generic single-source
 * `simpleCardFromFetch` helper below. `integrityState` still gates the
 * card's own loading/error/empty exactly as before.
 *
 * `configState.status === 'loading'` holds the WHOLE card at `'loading'`
 * (fix round 3) rather than computing a provisional verdict from the
 * flagged-key half alone — matching every other ribbon card, which stays
 * loading until ITS OWN source resolves. The round-2 version rendered a
 * premature `'ok'`/`'attention'` here; if flagged keys were clean and
 * contamination later resolved positive, that reads as a green-to-amber
 * flip on the card whose entire job is catching model-cost drift. `'error'`
 * is a DIFFERENT, deliberately NOT-loading state: a config fetch that has
 * definitively failed still forces `'attention'` via `assessModelIntegrity`
 * ("cannot verify" — Finding 1 from fix round 2 stays intact, only the
 * in-flight case changed here).
 */
export function buildModelIntegrityCard(
  integrityState: FetchState<IntegrityStats>,
  configState: FetchState<ConfigReport>,
): SimpleCardView {
  switch (integrityState.status) {
    case 'loading':
      return { status: 'loading', text: 'Loading…' };
    case 'error':
      return { status: 'error', text: `Failed to load: ${integrityState.message}` };
    case 'empty':
      return { status: 'empty', text: 'No data recorded in this window.' };
    case 'ready': {
      const contamination = buildContaminationAvailability(integrityState.data.subAgentModelAttribution.entries, configState);
      if (contamination.status === 'loading') {
        return { status: 'loading', text: 'Loading…' };
      }
      const a = assessModelIntegrity(integrityState.data, contamination);
      return { status: a.severity, text: a.text };
    }
  }
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
          {/* Task 10 fix: a `barPosition: null` row (today, EVERY production
              "spawned image" row — image_sha is always null) used to still
              render this track, just with no dot in it. A track with nothing
              plotted on it reads as an unfinished/loading progress bar, not
              as "there is no position to show" — the opposite of what
              `describeNonShaState`'s text already says next to it. Omitting
              the track entirely (rather than rendering an empty one) is the
              fix: the row still has its label and word-based value, it just
              has no decorative element implying a measurement that was never
              taken. */}
          {row.barPosition != null && (
            <span class="status-ribbon__bar" aria-hidden="true">
              <span class="status-ribbon__bar-dot" style={{ left: `${row.barPosition * 100}%` }} />
            </span>
          )}
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
 *
 * Task 4: the scope note above the cards is the ribbon's own "this is always
 * production" label — it has to work at a glance, not on inspection, since
 * the Prod/Test control below this ribbon governs every panel BELOW it, but
 * not this one. It is chrome, not a caveat, so it is deliberately NOT one of
 * this tab's five caveat tags ("Needs attention:", "Cannot verify:", etc.) —
 * minting a sixth would blur the one vocabulary this tab relies on to keep
 * its epistemic states distinguishable.
 */
export function StatsRibbon() {
  const integrity = ribbonIntegrityStats.value;
  const config = configReport.value;
  const window = statsWindow.value;
  return (
    <>
      <p class="status-ribbon__scope-note">
        <span class="status-ribbon__scope-badge">production only</span>
        This ribbon always reports production — it does not change when the Prod/Test control below is set to Test.
      </p>
      <section class="status-ribbon" aria-label="Status ribbon">
        <DriftCard />
        <SimpleCard label="Model integrity" view={buildModelIntegrityCard(integrity, config)} window={window} />
        <SimpleCard label="Active levers" view={buildLeversCard(config)} />
        <SimpleCard label="Error rate" view={buildErrorRateCard(integrity)} window={window} />
      </section>
    </>
  );
}
