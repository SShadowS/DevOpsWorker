import { integrityStats, configReport, statsWindow } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { IntegrityStats, ModelUsageEntry, EffortMix, SubAgentModelAttributionEntry } from '../../stats.ts';
import type { ConfigReport } from '../../config-report.ts';
import { formatPct, formatCost } from '../format.ts';
import { assessModelIntegrity, assessErrorRate } from './stats-ribbon.tsx';

// ---------------------------------------------------------------------------
// Integrity panel (Task 6, fix round 1) — "is the machinery reporting the
// truth about itself." Six sections: model usage (unexpected `model_usage`
// keys, e.g. `[1m]`), model CONTAMINATION (a sub-agent running on a model
// other than its DECLARED frontmatter pin), dispatch (the roster-vs-dispatch
// mismatch), inferred effort drift, findings integrity, and error rate.
//
// Model usage and model contamination are DIFFERENT signals from DIFFERENT
// sources, not two views of the same one — fix round 1 corrected an earlier
// version of this file that conflated them. Model usage reads ONLY
// `/api/stats/integrity` (`modelUsage.flaggedKeys`, an aggregate over the
// whole row's `model_usage` column). Contamination cross-references TWO
// endpoints that are both already in hand on the client: `integrityStats`
// (windowed, OBSERVED per-sub-agent model — `subAgentModelAttribution`) and
// `configReport` (unwindowed, DECLARED frontmatter pins —
// `subAgents.groups[*].files[*].declaredModel`). The join deliberately
// happens HERE, not on the server: `stats.ts` stays free of any dependency on
// `config-report.ts`, and this component already fetches both signals for
// other reasons (`assessLevers` et al. in the ribbon do the same thing).
//
// This is the DETAILED sibling of the status ribbon's compact "Model
// integrity" and "Error rate" cards (stats-ribbon.tsx) — same underlying
// data, same severity logic (reused directly below, not reimplemented), but
// with the full breakdown a glance-level ribbon card has no room for.
//
// Per-section status is one of three, not two — this is the load-bearing
// design decision for this panel:
//   'ok'       — evaluated, healthy (green, matches --color-stage-completed)
//   'attention'— evaluated, a genuine finding (accent, named in words)
//   'neutral'  — NOT evaluated against a pass/fail bar at all. Dispatch's
//                roster mismatch is measured live at 69.1% over 30d and is
//                the ORDINARY case, not an anomaly (sub_agents undercounts
//                nondeterministically — see stats.ts `dispatchCountsForPercentile`).
//                Scoring that 'attention' would paint this panel permanently
//                amber, and a permanently-amber panel is a permanently-ignored
//                one (design-constraints.md). Effort drift is 'neutral' for a
//                different reason: it is INFERRED, not measured, so there is
//                no ground truth to score it against.
// Model contamination is 'attention' when found — deliberately NOT given the
// same 'neutral' treatment as dispatch, even though both start from the same
// undercounted `sub_agents` roster. The undercount changes what fraction of
// contamination is VISIBLE (it can only hide contamination, never invent it —
// see the note rendered with the section), not whether a found deviation is
// real. A sub-agent silently running on a different, more expensive model
// than its frontmatter pin is a genuine, actionable, non-recurring-by-design
// event — the opposite of the dispatch mismatch, which recurs by design of
// the instrument itself.
// Colour is never the only signal in any of the four states: every one
// carries literal text ("Needs attention: …", "Known instrument caveat: …",
// "Inferred, not measured: …", "unpinned").
// ---------------------------------------------------------------------------

export type SectionStatus = 'ok' | 'attention' | 'neutral';

// ---------------------------------------------------------------------------
// Pure view-model builders — unit-tested with fixture data, no rendering,
// no network. Model integrity and error rate delegate to stats-ribbon.tsx's
// `assessModelIntegrity`/`assessErrorRate` rather than re-deriving the same
// severity call twice from the same fields — this panel adds the breakdown
// table / error_max_turns note around that shared verdict, it does not
// second-guess it.
// ---------------------------------------------------------------------------

export interface ModelUsageSectionView {
  status: 'ok' | 'attention';
  summary: string;
  rows: ModelUsageEntry[];
}

/** The full model_usage breakdown plus the flagged-key verdict. Reuses
 *  `assessModelIntegrity` (stats-ribbon.tsx) for the summary text/severity so
 *  the ribbon's compact card and this panel's detailed table never disagree
 *  about whether today's data is flagged. */
export function buildModelUsageSectionView(data: IntegrityStats): ModelUsageSectionView {
  const a = assessModelIntegrity(data);
  return { status: a.severity, summary: a.text, rows: data.modelUsage.breakdown };
}

// ---------------------------------------------------------------------------
// Model CONTAMINATION — declared frontmatter pin vs observed model. The join
// stats.ts deliberately does not do (see module doc comment): built here from
// `IntegrityStats.subAgentModelAttribution` (observed, windowed) and
// `ConfigReport.subAgents` (declared, unwindowed).
// ---------------------------------------------------------------------------

/**
 * Flattens every DECLARED sub-agent model pin this repo knows about — both
 * `.claude/agents/*.md` frontmatter (`subAgents.groups`: pr-reviewer's 7,
 * plan-reviewer's 4, code-reviewer's 8) and the one inline `SdkAgentDefinition`
 * (`ci-waiter`) — into a single agent-name -> declared-model lookup.
 *
 * A frontmatter file with no `model:` line, AND an agent name that appears in
 * NO group or inline entry at all (e.g. the built-in `general-purpose`
 * subagent_type, which has no frontmatter file of its own — see the live
 * production reading in the fix-round-1 message) both end up mapped to
 * `null` here, on purpose: neither is "contamination", both are "nothing was
 * declared to compare this observation against".
 */
export function collectDeclaredPins(config: ConfigReport): Map<string, string | null> {
  const pins = new Map<string, string | null>();
  for (const group of config.subAgents.groups) {
    for (const file of group.files) {
      pins.set(file.file.replace(/\.md$/, ''), file.declaredModel);
    }
  }
  for (const inline of config.subAgents.inline) {
    pins.set(inline.subagentType, inline.declaredModel);
  }
  return pins;
}

export type ContaminationRowStatus = 'ok' | 'attention' | 'unpinned';

export interface AgentModelRow {
  agent: string;
  /** A pin is DECLARED, never guaranteed — frontmatter pins are known to be
   *  silently ignored, which is the whole reason this row exists. `null`
   *  means no declared pin was found for this agent at all (see
   *  `collectDeclaredPins`), not that the pin failed. */
  declaredModel: string | null;
  observed: Array<{ model: string | null; count: number }>;
  totalRuns: number;
  /** Runs observed on a model other than `declaredModel`. Always 0 for an
   *  `'unpinned'` row — there is nothing to be off of. */
  offPinRuns: number;
  status: ContaminationRowStatus;
}

/**
 * Cross-references observed per-agent model attribution against declared
 * pins. An agent with NO declared pin is reported as `'unpinned'`, never
 * folded into a contamination count — per the fix-round-1 instruction, an
 * unpinned agent (e.g. `general-purpose`) running on any model is expected
 * behaviour, not drift. An agent WITH a declared pin that shows even one run
 * on a different model is `'attention'` — unlike the dispatch mismatch, this
 * is not a documented, expected instrument fault.
 */
export function buildAgentModelRows(
  entries: SubAgentModelAttributionEntry[],
  declaredPins: Map<string, string | null>,
): AgentModelRow[] {
  const byAgent = new Map<string, Array<{ model: string | null; count: number }>>();
  for (const e of entries) {
    const list = byAgent.get(e.agent) ?? [];
    list.push({ model: e.model, count: e.count });
    byAgent.set(e.agent, list);
  }
  const rows: AgentModelRow[] = [];
  for (const [agent, observed] of byAgent) {
    const totalRuns = observed.reduce((s, o) => s + o.count, 0);
    const declaredModel = declaredPins.get(agent) ?? null;
    if (declaredModel == null) {
      rows.push({ agent, declaredModel: null, observed, totalRuns, offPinRuns: 0, status: 'unpinned' });
      continue;
    }
    const offPinRuns = observed.filter((o) => o.model !== declaredModel).reduce((s, o) => s + o.count, 0);
    rows.push({ agent, declaredModel, observed, totalRuns, offPinRuns, status: offPinRuns > 0 ? 'attention' : 'ok' });
  }
  return rows.sort((a, b) => a.agent.localeCompare(b.agent));
}

export function formatObservedBreakdown(observed: Array<{ model: string | null; count: number }>): string {
  return observed.map((o) => `${o.model ?? '(unknown)'}: ${o.count}`).join(' · ');
}

/** The four states this section can be in — one more than the generic
 *  `SectionStatus` because, unlike every other section, this one depends on
 *  a SECOND fetch (`configReport`) that can independently be loading or
 *  errored even while `integrityStats` (which gates the rest of the panel)
 *  is ready. */
export type ContaminationSectionStatus = 'loading' | 'error' | 'ok' | 'attention';

export interface ContaminationSectionView {
  status: ContaminationSectionStatus;
  /** Set only for 'loading'/'error' — the declared-pin side is unavailable. */
  message: string | null;
  summary: string | null;
  rows: AgentModelRow[] | null;
  undercountNote: string | null;
}

/**
 * A `configReport` load failure renders as `'error'` (styled the same as
 * `'attention'` — see `ContaminationSection`), not silently as `'ok'`:
 * mirrors `assessDrift`'s established precedent in stats-ribbon.tsx
 * ("unverifiable silence is exactly what let the 2026-08-01 incident run for
 * four hours") — if declared pins cannot be fetched, contamination cannot be
 * ruled out, and that must not read as "no contamination found".
 */
export function buildContaminationSectionView(
  entries: SubAgentModelAttributionEntry[],
  undercountNote: string,
  configState: FetchState<ConfigReport>,
): ContaminationSectionView {
  switch (configState.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading declared model pins…', summary: null, rows: null, undercountNote: null };
    case 'error':
      return {
        status: 'error',
        message: `Cannot verify — declared configuration failed to load: ${configState.message}`,
        summary: null, rows: null, undercountNote: null,
      };
    case 'empty':
      // /api/config is unwindowed and never reports 'empty' (loadConfigReport
      // only ever sets loading/error/ready) — kept for exhaustiveness against
      // the shared FetchState<T> union, same rationale as buildDriftCard's
      // 'empty' branch in stats-ribbon.tsx.
      return {
        status: 'error',
        message: 'Cannot verify — declared configuration unexpectedly reported empty.',
        summary: null, rows: null, undercountNote: null,
      };
    case 'ready': {
      const declaredPins = collectDeclaredPins(configState.data);
      const rows = buildAgentModelRows(entries, declaredPins);
      const pinnedRows = rows.filter((r) => r.status !== 'unpinned');
      const contaminated = pinnedRows.filter((r) => r.status === 'attention');
      const totalOffPinRuns = contaminated.reduce((s, r) => s + r.offPinRuns, 0);
      const totalPinnedRuns = pinnedRows.reduce((s, r) => s + r.totalRuns, 0);
      const summary =
        pinnedRows.length === 0
          ? 'No pinned sub-agent runs recorded in this window.'
          : contaminated.length === 0
            ? `n=${totalPinnedRuns} · all ${pinnedRows.length} pinned sub-agent(s) ran only on their declared model`
            : `${totalOffPinRuns}/${totalPinnedRuns} runs across ${contaminated.length} of ${pinnedRows.length} pinned sub-agent(s) ran on a model other than their declared pin`;
      return { status: contaminated.length > 0 ? 'attention' : 'ok', message: null, summary, rows, undercountNote };
    }
  }
}

export interface DispatchSectionView {
  status: 'neutral';
  medianText: string;
  p90Text: string;
  avgRosterText: string;
  mismatchText: string;
  caveat: string;
}

/** Always `'neutral'` by construction — see the module doc comment. The
 *  mismatch rate is reported in full (never hidden or rounded away) but
 *  never drives colour. */
export function buildDispatchSectionView(dispatch: IntegrityStats['dispatch']): DispatchSectionView {
  return {
    status: 'neutral',
    medianText: dispatch.medianDispatch == null ? 'n/a' : `${dispatch.medianDispatch}`,
    p90Text: dispatch.p90Dispatch == null ? 'n/a' : `${dispatch.p90Dispatch}`,
    avgRosterText: dispatch.avgRosterCount == null ? 'n/a' : dispatch.avgRosterCount.toFixed(1),
    mismatchText: `${dispatch.mismatchCount}/${dispatch.dispatchSampleSize} (${formatPct(dispatch.mismatchRate)})`,
    caveat:
      "Known instrument caveat, not a new problem: sub_agents undercounts tool_calls->'Agent' " +
      'nondeterministically (see dispatchCountsForPercentile in stats.ts). A high mismatch rate is ' +
      'the ordinary case here, not a sign anything broke — use the dispatch median/p90 above, never ' +
      'roster size, as "how many agents ran".',
  };
}

export interface EffortDriftSectionView {
  status: 'neutral';
  bandsText: string;
  overall: EffortMix;
  earlierHalf: EffortMix;
  laterHalf: EffortMix;
  note: string;
}

/** Always `'neutral'` — there is no effort column to score this against, so
 *  there is no pass/fail bar to evaluate, only a proxy to disclose. */
export function buildEffortDriftSectionView(inferredEffort: IntegrityStats['inferredEffort']): EffortDriftSectionView {
  const [hiLo, hiHi] = inferredEffort.bands.high;
  const [loLo, loHi] = inferredEffort.bands.low;
  return {
    status: 'neutral',
    bandsText: `high ${hiLo.toLocaleString()}–${hiHi.toLocaleString()} tokens · low ${loLo.toLocaleString()}–${loHi.toLocaleString()} tokens`,
    overall: inferredEffort.drift.overall,
    earlierHalf: inferredEffort.drift.earlierHalf,
    laterHalf: inferredEffort.drift.laterHalf,
    note: inferredEffort.note,
  };
}

export function formatEffortMix(mix: EffortMix): string {
  return `high ${mix.high} · low ${mix.low} · other ${mix.other} · unknown ${mix.unknown}`;
}

export interface FindingsIntegritySectionView {
  status: 'ok' | 'attention';
  text: string;
}

/**
 * Unlike the dispatch mismatch, a `findings_count` / `findings_list` length
 * disagreement is NOT a documented, expected instrument fault (see
 * data-shapes.md: "if it does, that disagreement is an integrity signal, not
 * something to silently reconcile") — so ANY mismatch here is 'attention',
 * not a standing caveat. Zero compared rows (neither column populated for
 * any row this window) reads as 'ok' — there's nothing to disagree about.
 */
export function assessFindingsIntegrity(findingsIntegrity: IntegrityStats['findingsIntegrity']): FindingsIntegritySectionView {
  const { comparedRows, mismatchCount, mismatchRate } = findingsIntegrity;
  if (comparedRows === 0) {
    return { status: 'ok', text: 'No rows in this window have both findings_count and findings_list recorded.' };
  }
  const text = `${mismatchCount}/${comparedRows} rows disagree — ${formatPct(mismatchRate)} (findings_count vs findings_list length)`;
  return { status: mismatchCount > 0 ? 'attention' : 'ok', text };
}

export interface ErrorRateSectionView {
  status: 'ok' | 'attention';
  text: string;
  note: string;
}

/** Delegates severity/text to `assessErrorRate` (stats-ribbon.tsx) — same
 *  reuse rationale as `buildModelUsageSectionView`. Adds the one thing the
 *  ribbon's one-line card has no room for: stating explicitly that "error"
 *  is not narrowed to one failure cause. */
export function buildErrorRateSectionView(errorRate: IntegrityStats['errorRate'], lowSample: boolean): ErrorRateSectionView {
  const a = assessErrorRate(errorRate, lowSample);
  return {
    status: a.severity,
    text: a.text,
    note: '"Error" here is any pipeline error recorded on the row — including error_max_turns and every '
      + 'other PipelineError subtype (RevisionExhaustedError, ExternalServiceError, …) — not narrowed to one cause.',
  };
}

// ---------------------------------------------------------------------------
// Panel-level view — one FetchState in, one thing to render out.
// ---------------------------------------------------------------------------

export type IntegrityPanelStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface IntegrityPanelView {
  status: IntegrityPanelStatus;
  message: string | null;
  modelUsage: ModelUsageSectionView | null;
  contamination: ContaminationSectionView | null;
  dispatch: DispatchSectionView | null;
  effortDrift: EffortDriftSectionView | null;
  findingsIntegrity: FindingsIntegritySectionView | null;
  errorRate: ErrorRateSectionView | null;
  lowSample: boolean;
  sampleSize: number | null;
}

/** The single switch that turns the two fetch states this panel reads
 *  (`integrityStats`, which gates every section, and `configReport`, which
 *  ONLY the contamination section additionally depends on) into everything
 *  the panel renders. Pure — exported for unit testing. Exhaustive over
 *  `integrityState`'s four variants, matching `describeFetchState`'s pattern
 *  in stats-view.tsx; `configState` is threaded through to
 *  `buildContaminationSectionView`, which is itself exhaustive over its own
 *  four states. */
export function buildIntegrityPanelView(
  integrityState: FetchState<IntegrityStats>,
  configState: FetchState<ConfigReport>,
): IntegrityPanelView {
  const empty: Omit<IntegrityPanelView, 'status' | 'message'> = {
    modelUsage: null, contamination: null, dispatch: null, effortDrift: null, findingsIntegrity: null, errorRate: null,
    lowSample: false, sampleSize: null,
  };
  switch (integrityState.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading…', ...empty };
    case 'error':
      return { status: 'error', message: `Failed to load: ${integrityState.message}`, ...empty };
    case 'empty':
      return { status: 'empty', message: 'No data recorded in this window.', ...empty };
    case 'ready': {
      const d = integrityState.data;
      return {
        status: 'ready',
        message: null,
        modelUsage: buildModelUsageSectionView(d),
        contamination: buildContaminationSectionView(d.subAgentModelAttribution.entries, d.subAgentModelAttribution.note, configState),
        dispatch: buildDispatchSectionView(d.dispatch),
        effortDrift: buildEffortDriftSectionView(d.inferredEffort),
        findingsIntegrity: assessFindingsIntegrity(d.findingsIntegrity),
        errorRate: buildErrorRateSectionView(d.errorRate, d.lowSample),
        lowSample: d.lowSample,
        sampleSize: d.sampleSize,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function attentionPrefix(status: SectionStatus): { tag: string; class: string } | null {
  if (status === 'attention') return { tag: 'Needs attention: ', class: 'integrity-section__tag--attention' };
  return null;
}

interface IntegritySectionProps {
  title: string;
  status: SectionStatus;
  /** A short badge next to the title, e.g. "Inferred" — design-constraints.md
   *  #4: inferred values must never be allowed to look measured. */
  badge?: string;
  // Matches the existing `children: any` convention (agent-output-tabs.tsx)
  // rather than introducing a stricter preact type not used elsewhere.
  children: any;
}

function IntegritySection({ title, status, badge, children }: IntegritySectionProps) {
  return (
    <div class={`integrity-section integrity-section--${status}`}>
      <div class="integrity-section__header">
        <h4 class="integrity-section__title">{title}</h4>
        {badge && <span class="integrity-section__badge">{badge}</span>}
      </div>
      <div class="integrity-section__body">{children}</div>
    </div>
  );
}

function ModelUsageTable({ rows }: { rows: ModelUsageEntry[] }) {
  if (rows.length === 0) {
    return <p class="integrity-section__empty">No model_usage recorded in this window.</p>;
  }
  return (
    <table class="integrity-table">
      <thead>
        <tr><th>Model</th><th>Rows</th><th>Cost</th><th>Output tokens</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.model} class={r.flagged ? 'integrity-table__row--flagged' : ''}>
            <td class="integrity-table__model">
              {r.model}
              {r.flagged && (
                <span class="integrity-table__flag" title="Matches the [1m] premium long-context contamination pattern"> ⚠ flagged</span>
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

function ModelUsageSection({ view }: { view: ModelUsageSectionView }) {
  const prefix = attentionPrefix(view.status);
  return (
    <IntegritySection title="Model usage" status={view.status}>
      <p class="integrity-section__summary">
        {prefix && <strong class={`integrity-section__tag ${prefix.class}`}>{prefix.tag}</strong>}
        {view.summary}
      </p>
      <ModelUsageTable rows={view.rows} />
    </IntegritySection>
  );
}

function ContaminationTable({ rows }: { rows: AgentModelRow[] }) {
  if (rows.length === 0) {
    return <p class="integrity-section__empty">No sub-agent model attribution recorded in this window.</p>;
  }
  return (
    <table class="integrity-table">
      <thead>
        <tr><th>Sub-agent</th><th>Declared pin</th><th>Observed</th><th>Off-pin runs</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.agent} class={r.status === 'attention' ? 'integrity-table__row--flagged' : ''}>
            <td class="integrity-table__model">{r.agent}</td>
            <td>
              {r.declaredModel == null
                ? <span class="integrity-section__empty">unpinned</span>
                : <span class="integrity-table__model">declared: {r.declaredModel}</span>}
            </td>
            <td>{formatObservedBreakdown(r.observed)}</td>
            <td>
              {r.status === 'unpinned' ? 'n/a' : `${r.offPinRuns}/${r.totalRuns}`}
              {r.status === 'attention' && (
                <span class="integrity-table__flag" title="Ran on a model other than its declared pin"> ⚠ off-pin</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ContaminationSection({ view }: { view: ContaminationSectionView }) {
  if (view.status === 'loading' || view.status === 'error') {
    return (
      <IntegritySection title="Model contamination (declared pin vs observed)" status={view.status === 'error' ? 'attention' : 'neutral'}>
        <p class="integrity-section__summary">
          {view.status === 'error' && <strong class="integrity-section__tag integrity-section__tag--attention">Needs attention: </strong>}
          {view.message}
        </p>
      </IntegritySection>
    );
  }
  const prefix = attentionPrefix(view.status);
  return (
    <IntegritySection title="Model contamination (declared pin vs observed)" status={view.status}>
      <p class="integrity-section__summary">
        {prefix && <strong class={`integrity-section__tag ${prefix.class}`}>{prefix.tag}</strong>}
        {view.summary}
      </p>
      <ContaminationTable rows={view.rows!} />
      <p class="integrity-section__note">{view.undercountNote}</p>
    </IntegritySection>
  );
}

function DispatchSection({ view }: { view: DispatchSectionView }) {
  return (
    <IntegritySection title="Dispatch (tool_calls -> 'Agent' is authoritative)" status="neutral">
      <p class="integrity-section__summary">
        median <strong>{view.medianText}</strong> · p90 <strong>{view.p90Text}</strong> · avg roster size <strong>{view.avgRosterText}</strong>
      </p>
      <p class="integrity-section__summary">
        roster mismatch: <strong>{view.mismatchText}</strong>
      </p>
      <p class="integrity-section__note">
        <strong class="integrity-section__tag integrity-section__tag--caveat">Known instrument caveat: </strong>
        {view.caveat}
      </p>
    </IntegritySection>
  );
}

function EffortDriftSection({ view }: { view: EffortDriftSectionView }) {
  return (
    <IntegritySection title="Inferred effort drift" status="neutral" badge="Inferred">
      <p class="integrity-section__summary">{view.bandsText}</p>
      <table class="integrity-table">
        <thead><tr><th></th><th>High</th><th>Low</th><th>Other</th><th>Unknown</th></tr></thead>
        <tbody>
          <tr><td>Overall</td><td>{view.overall.high}</td><td>{view.overall.low}</td><td>{view.overall.other}</td><td>{view.overall.unknown}</td></tr>
          <tr><td>Earlier half</td><td>{view.earlierHalf.high}</td><td>{view.earlierHalf.low}</td><td>{view.earlierHalf.other}</td><td>{view.earlierHalf.unknown}</td></tr>
          <tr><td>Later half</td><td>{view.laterHalf.high}</td><td>{view.laterHalf.low}</td><td>{view.laterHalf.other}</td><td>{view.laterHalf.unknown}</td></tr>
        </tbody>
      </table>
      <p class="integrity-section__note">
        <strong class="integrity-section__tag integrity-section__tag--caveat">Inferred, not measured: </strong>
        {view.note}
      </p>
    </IntegritySection>
  );
}

function FindingsIntegritySection({ view }: { view: FindingsIntegritySectionView }) {
  const prefix = attentionPrefix(view.status);
  return (
    <IntegritySection title="Findings integrity" status={view.status}>
      <p class="integrity-section__summary">
        {prefix && <strong class={`integrity-section__tag ${prefix.class}`}>{prefix.tag}</strong>}
        {view.text}
      </p>
    </IntegritySection>
  );
}

function ErrorRateSection({ view }: { view: ErrorRateSectionView }) {
  const prefix = attentionPrefix(view.status);
  return (
    <IntegritySection title="Error rate" status={view.status}>
      <p class="integrity-section__summary">
        {prefix && <strong class={`integrity-section__tag ${prefix.class}`}>{prefix.tag}</strong>}
        {view.text}
      </p>
      <p class="integrity-section__note">{view.note}</p>
    </IntegritySection>
  );
}

/**
 * The Integrity panel — replaces the `stats-slot-integrity` placeholder
 * `<StatsSlot>` (Task 4) with the real body, keeping the same outer
 * `stats-slot stats-slot--{status}` wrapper and header markup so the
 * loading/error/empty border-colour CSS carries over unchanged (per
 * task-4-report.md's contract). The generic `<ul class="stats-slot__sources">`
 * + placeholder note it used to render is replaced entirely by the six
 * sections below when ready — that swap is explicitly sanctioned by Task
 * 4's own report ("Replace that `<ul>` + note with the real panel body").
 *
 * Reads TWO signals — `integrityStats` (windowed, gates the whole panel's
 * loading/error/empty state, unchanged from before fix round 1) and
 * `configReport` (unwindowed, only the contamination section depends on it —
 * both already fetched once by `loadAllStats()`/`loadConfigReport()` in
 * stats-store.ts for other panels, so this adds no new network call).
 */
export function StatsIntegrityPanel() {
  const view = buildIntegrityPanelView(integrityStats.value, configReport.value);
  const window = statsWindow.value;
  return (
    <section id="stats-slot-integrity" class={`stats-slot stats-slot--${view.status}`} aria-label="Integrity">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Integrity</h3>
        <span class="stats-slot__window" title="Time window this section reads">{window}</span>
      </div>
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>
          {view.message}
        </p>
      ) : (
        <div class="integrity-panel">
          {view.lowSample && (
            <p class="integrity-panel__low-sample">
              Small sample: n={view.sampleSize} in this window — every statistic below is a small-sample reading.
            </p>
          )}
          <ModelUsageSection view={view.modelUsage!} />
          <ContaminationSection view={view.contamination!} />
          <DispatchSection view={view.dispatch!} />
          <EffortDriftSection view={view.effortDrift!} />
          <FindingsIntegritySection view={view.findingsIntegrity!} />
          <ErrorRateSection view={view.errorRate!} />
        </div>
      )}
    </section>
  );
}
