import { useEffect, useState } from 'preact/hooks';
import {
  statsWindow, statsPopulation, costStats, qualityStats, integrityStats, operationalStats,
  reviewValueStats, configReport, statsLastLoadedAt, statsRefreshing,
  setStatsWindow, setStatsPopulation, loadAllStats, STATS_WINDOWS, STATS_POPULATIONS,
  STATS_SECTIONS, parseStatsWindow, parseStatsPopulation,
  activeSection, setSection,
} from '../stats-store.ts';
import type { FetchState, StatsSection } from '../stats-store.ts';
import type { Population, PopulationMeta, IntegrityStats, OperationalStats, CostStats, QualityStats, ReviewValueStats } from '../../stats.ts';
import type { ConfigReport } from '../../config-report.ts';
import { getRouteParams, updateRouteParams } from '../url-route.ts';
import { formatRelativeTime } from '../format.ts';
import { StatsRibbon } from './stats-ribbon.tsx';
import { StatsIntegrityPanel, integritySectionStatuses } from './stats-integrity.tsx';
import { ConfigPanel, configSectionStatuses } from './stats-config.tsx';
import { CostQualityPanel, costSectionStatuses, qualitySectionStatuses } from './stats-costquality.tsx';
import { ReviewValuePanel, reviewValueSectionStatuses } from './stats-review-value.tsx';
import { OperationalPanel, operationalSectionStatuses } from './stats-operational.tsx';
import { ReflectionCard, listState as reflectionListState, loadReflections } from './reflection-card.tsx';
import { sectionAttentionCount } from '../assessors.ts';
import { countOf } from '../../count-phrase.ts';

// ---------------------------------------------------------------------------
// Shell for the Stats & Config tab (Task 4). Owns: the third tab's panel
// container, the shared window selector, and data fetching for all six
// endpoints with loading/empty/error states. All five panels — Ribbon (Task
// 5), Integrity (Task 6), Config (Task 7), Cost & Quality (Task 8), and
// Operational (Task 9) — have each been replaced by their own component
// (`stats-ribbon.tsx`, `stats-integrity.tsx`, `stats-config.tsx`,
// `stats-costquality.tsx`, `stats-operational.tsx`); the generic
// `<StatsSlot>` placeholder this file used to render for every not-yet-built
// panel is gone (its last user was the Operational slot). `describeFetchState`/
// `worstStatus`/`SlotSourceInfo` used to live below, exported and
// unit-tested as general-purpose `FetchState` classification helpers with no
// caller left in this tab (flagged in task-9-report.md as a Task 10 prune
// candidate, deferred because removing tested, still-correct code was a
// bigger call than that task's stated scope). Task 3 (follow-up) settled the
// "prune or keep" question the earlier report left open, and it split
// differently per symbol, not uniformly: `worstStatus` had genuinely
// acquired a second consumer by then (`stats-costquality.tsx`'s own
// worst-of-two, previously hand-rolled to dodge a circular import) and moved
// to `../assessors.ts`, taking its supporting types `SlotSourceInfo`/
// `SlotStatus` with it. `describeFetchState` had not — still zero
// production callers — and was deleted along with its tests rather than
// carried forward under a new path.
//
// Prod|Test population control (this task): the four population-aware
// endpoints (cost/quality/integrity/operational) all report the SAME
// `otherPopulationCount` for a given window+population — `stats.ts`'s
// `countInWindowForPopulation` is one blanket `pr_reviews` count with no
// per-endpoint column scoping, so the number cannot legitimately differ
// across them. That is what lets `PopulationDisclosure` below render ONE
// shared sentence for the whole tab from whichever of the four signals has
// settled first, rather than requiring `stats-integrity.tsx` /
// `stats-costquality.tsx` / `stats-operational.tsx` to each render their own
// copy of the identical fact — those three files are out of this task's
// file scope, and four identical sentences would say nothing four repeats of
// one sentence didn't already say. `pickPopulationMeta` is the pure,
// unit-tested seam that picks the first ready one.
// ---------------------------------------------------------------------------

/**
 * Names how many rows of the OTHER population were excluded from the
 * current view — zero is a real, sayable reading ("No test runs in this
 * window."), never silence, per this tab's own reason for existing: a
 * silent filter is the invisible-control problem it was built to catch.
 * Pure — exported for unit testing. Exact strings are pinned by
 * stats-view.test.ts; do not reword without updating both.
 */
export function describePopulationExclusion(population: Population, otherCount: number): string {
  if (population === 'prod') {
    return otherCount === 0
      ? 'No test runs in this window.'
      : `${countOf(otherCount, 'test run')} excluded from this window.`;
  }
  return otherCount === 0
    ? 'Showing test runs only. No production reviews in this window.'
    : `Showing test runs only. ${countOf(otherCount, 'production review')} excluded from this window.`;
}

/**
 * Picks the population/otherCount reading the shared disclosure banner
 * shows. Those four population-aware endpoints report an IDENTICAL count for
 * a given window+population (see the module doc comment above), so any one
 * of them that has settled to `'ready'` is authoritative — this just takes
 * the first one, in a fixed order, rather than requiring all four to agree
 * before showing anything.
 *
 * `/api/stats/review-value` is population-aware too but must NEVER be passed
 * here: its `otherPopulationCount` counts `finding_outcomes` ROWS, not
 * `pr_reviews` rows, so it is a different quantity that happens to share a
 * field name. Feeding it in would make this banner report a finding count as
 * a review count depending purely on which fetch resolved first.
 *
 * `null` means none of the four has resolved yet
 * (still loading, or all failed) — the caller renders nothing rather than a
 * stale or guessed number. Pure — exported for unit testing.
 */
export function pickPopulationMeta(...states: FetchState<PopulationMeta>[]): PopulationMeta | null {
  for (const s of states) {
    if (s.status === 'ready') return s.data;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section sub-navigation — the tab grew to seven stacked panels (~4 screens
// of scroll), so the panels are grouped into four sections behind a
// segmented switcher. The ribbon stays global above it, but the ribbon alone
// is NOT what makes hiding five of seven panels safe: it covers four
// indicators (drift, model integrity, levers, error rate), not every
// attention state a hidden panel can render. What closes that gap is the
// badges: every section button carries a badge folded from the SAME section
// statuses its panels render (`attentionBySection` below), so an alarm in a
// hidden panel is visible on the button that reaches it — the reader knows
// WHERE to click, not just that something is off.
// ---------------------------------------------------------------------------

export type { StatsSection };

const SECTION_LABEL: Record<StatsSection, string> = {
  health: 'Health',
  value: 'Cost & value',
  reflection: 'Reflection',
  config: 'Config',
};

// `activeSection`/`setSection` now live in stats-store.ts (imported above),
// not here — a panel file (stats-config.tsx, stats-costquality.tsx) needs to
// reach them for the cross-section "jump there" links, and this file already
// imports every panel component, so the shared state had to move to the leaf
// both sides can import without a cycle. See stats-store.ts's own comment at
// their definition for the full reasoning.

/**
 * The per-section attention counts behind the section buttons' badges.
 *
 * Structural, not editorial: each panel exports the list of section statuses
 * its ready body renders (`integritySectionStatuses` and friends), each
 * computed by the SAME pure view builders that panel's own JSX renders with
 * — the badge must never disagree with the panels it points at, and can
 * never claim a status no panel draws. This function only groups those
 * lists by section — the one place the section-to-panels mapping exists,
 * matching the JSX below — and folds them with `sectionAttentionCount`
 * (assessors.ts). A new attention state inside any existing panel section is
 * therefore routed to its badge with no change here. (The earlier version
 * hand-picked two assessors instead, which silently missed the
 * findings-integrity, tool-mix, rate-limit, flagged-model-cost, danger-zone
 * and builders-disagree attention states while their panels were hidden.)
 *
 * `null` for a section means at least one of its panels cannot know its
 * statuses yet (a fetch still in flight) — the badge renders nothing rather
 * than a count that could grow when the fetch lands. A panel whose fetch has
 * SETTLED without data (failed or empty) contributes an empty list instead:
 * it renders no sections, so it has nothing to count, and hiding another
 * panel's live attention behind one panel's failed fetch would recreate the
 * invisible-alarm problem the badges exist to solve.
 *
 * Reflection is absent on purpose: its badge counts proposals waiting on a
 * human decision (`reflectionPendingCount` below), and its one attention
 * section — a failed run — is by construction one of those pending rows, so
 * a second badge would say the same thing twice.
 */
export function attentionBySection(states: {
  integrity: FetchState<IntegrityStats>;
  operational: FetchState<OperationalStats>;
  cost: FetchState<CostStats>;
  quality: FetchState<QualityStats>;
  reviewValue: FetchState<ReviewValueStats>;
  config: FetchState<ConfigReport>;
}): Record<'health' | 'value' | 'config', number | null> {
  return {
    health: sectionAttentionCount([
      integritySectionStatuses(states.integrity, states.config),
      operationalSectionStatuses(states.operational),
    ]),
    value: sectionAttentionCount([
      costSectionStatuses(states.cost),
      qualitySectionStatuses(states.quality),
      reviewValueSectionStatuses(states.reviewValue),
    ]),
    config: sectionAttentionCount([
      configSectionStatuses(states.config),
    ]),
  };
}

/** True when a proposal is waiting on a human decision — the reflection
 *  section's reason to be visited. A failed run's row (error set, status
 *  still at its 'pending' default) counts too: it also needs a person to
 *  look. Null while the list has not settled. */
export function reflectionPendingCount(state: typeof reflectionListState.value): number | null {
  if (state.status === 'empty') return 0;
  if (state.status !== 'ready') return null;
  return state.proposals.filter((p) => p.status === 'pending').length;
}

/** The worded chip on a section button. Both kinds spend the accent (each is
 *  "a person must act" — the same fact the panels behind the button render
 *  in the accent), so the KIND is carried by the words on the chip — "to
 *  check" points at readings the panels mark "Needs attention", "to decide"
 *  at proposals awaiting a human decision — never by colour alone
 *  (Colour-Plus-Words). The fuller sentence rides on `title`/`aria-label`.
 *  Renders nothing at zero AND at null, and the two absences mean different
 *  things: zero is a real all-clear on a settled section; null means the
 *  count is not yet knowable, and drawing a number for either would guess. */
function SectionBadge({ count, kind }: { count: number | null; kind: 'attention' | 'pending' }) {
  if (count == null || count === 0) return null;
  const label = kind === 'attention'
    ? `${countOf(count, 'reading')} asking for attention`
    : `${countOf(count, 'proposal')} waiting for a decision`;
  return (
    <span class={`stats-subnav__badge stats-subnav__badge--${kind}`} title={label} aria-label={label}>
      {count} {kind === 'attention' ? 'to check' : 'to decide'}
    </span>
  );
}

/** Same `role="group"` + per-button `aria-pressed` convention as the window
 *  and population selectors below it — deliberately NOT a nested
 *  `role="tablist"` inside the app's real tab bar, for the same reason the
 *  window selector isn't one. Every button carries a badge: the three stats
 *  sections fold their panels' own attention statuses (`attentionBySection`),
 *  Reflection counts proposals waiting on a decision. */
function SectionNav() {
  const current = activeSection.value;
  const attention = attentionBySection({
    integrity: integrityStats.value,
    operational: operationalStats.value,
    cost: costStats.value,
    quality: qualityStats.value,
    reviewValue: reviewValueStats.value,
    config: configReport.value,
  });
  const pending = reflectionPendingCount(reflectionListState.value);
  return (
    <div class="stats-subnav" role="group" aria-label="Section">
      {STATS_SECTIONS.map((s) => (
        <button
          key={s}
          type="button"
          class={`stats-subnav__btn ${s === current ? 'stats-subnav__btn--active' : ''}`}
          aria-pressed={s === current}
          onClick={() => setSection(s)}
        >
          {SECTION_LABEL[s]}
          {s === 'reflection'
            ? <SectionBadge count={pending} kind="pending" />
            : <SectionBadge count={attention[s]} kind="attention" />}
        </button>
      ))}
    </div>
  );
}

function WindowSelector() {
  const current = statsWindow.value;
  return (
    <div class="window-selector" role="group" aria-label="Time window">
      {STATS_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          class={`window-selector__btn ${w === current ? 'window-selector__btn--active' : ''}`}
          aria-pressed={w === current}
          onClick={() => setStatsWindow(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

/** Reuses `WindowSelector`'s exact `role="group"` + per-button `aria-pressed`
 *  markup and active-state styling (background/weight change, no colour cue
 *  on its own) — deliberately NOT a second `role="tablist"`. Chrome, not a
 *  finding, so it never spends `--color-accent`, same as the window
 *  selector it sits beside. */
function PopulationSelector() {
  const current = statsPopulation.value;
  return (
    <div class="population-selector" role="group" aria-label="Population">
      {STATS_POPULATIONS.map((p) => (
        <button
          key={p}
          type="button"
          class={`population-selector__btn ${p === current ? 'population-selector__btn--active' : ''}`}
          aria-pressed={p === current}
          onClick={() => setStatsPopulation(p)}
        >
          {p === 'prod' ? 'Prod' : 'Test'}
        </button>
      ))}
    </div>
  );
}

/** The exclusion disclosure for the four population-aware panels below the
 *  toolbar — see the module doc comment for why one shared sentence, sourced
 *  from whichever signal has settled, is correct here rather than one copy
 *  per panel. Renders nothing while every source is still loading/errored,
 *  matching this tab's convention of never showing a guessed or stale number. */
function PopulationDisclosure() {
  const meta = pickPopulationMeta(costStats.value, qualityStats.value, integrityStats.value, operationalStats.value);
  if (meta == null) return null;
  return <p class="stats-view__population-disclosure">{describePopulationExclusion(meta.population, meta.otherPopulationCount)}</p>;
}

// ---------------------------------------------------------------------------
// Refresh (arrival-efficiency fix) — the tab's manual Refresh button re-runs
// the exact fetches the tab does on mount (`loadAllStats` + `loadReflections`,
// the same pair the mount effect below now calls through this one function).
// `statsRefreshing` guards a double-fire (the button also disables itself,
// and this function no-ops if already running, covering the mount effect
// and a click racing each other). The "as of" stamp itself is NOT set here:
// `loadStatsForWindow` (stats-store.ts) stamps `statsLastLoadedAt` as soon
// as the windowed batch it fetches lands, so a plain window/population
// switch keeps the stamp honest too, not only a full Refresh — see that
// function's doc comment for why the stamp is scoped to the windowed data
// specifically rather than to this wrapper's config/reflections calls.
// ---------------------------------------------------------------------------

async function refreshStatsTab(): Promise<void> {
  if (statsRefreshing.value) return;
  statsRefreshing.value = true;
  try {
    await Promise.all([loadAllStats(), loadReflections()]);
  } finally {
    statsRefreshing.value = false;
  }
}

/** Forces a re-render every 30s purely so the as-of stamp's relative time
 *  keeps counting up on a long-open tab — without this, `formatRelativeTime`
 *  would only ever recompute when some OTHER state changed, and the stamp
 *  would freeze at whatever it read after the last actual fetch: a smaller
 *  copy of the exact "silently ages" bug this whole feature exists to close. */
function useRelativeTimeTick(intervalMs: number): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/** Chrome, not a finding — reuses the shared `.btn`/`.btn--ghost` vocabulary
 *  (DESIGN.md's Buttons component) for the control and Muted Ink for the
 *  stamp (Text-Tier Rule: a timestamp, not a sentence someone reads for its
 *  content), so neither spends `--color-accent`. */
function TabToolbar() {
  useRelativeTimeTick(30_000);
  const refreshing = statsRefreshing.value;
  const at = statsLastLoadedAt.value;
  return (
    <div class="stats-view__tab-toolbar">
      {at != null && (
        <span class="stats-view__as-of">
          {refreshing && 'Refreshing. '}
          Data as of {formatRelativeTime(at)}.
        </span>
      )}
      {/* aria-live: the button's own visible text already changes between
          "Refresh" and "Refreshing…" — this is a second, redundant
          announcement for readers that don't surface a same-element text
          change, mirroring the reflection decision gate's precedent
          (reflection-card.tsx's `.reflection-decision__buttons`). */}
      <div aria-live="polite">
        <button
          type="button"
          class={`btn btn--ghost stats-view__refresh-btn${refreshing ? ' btn--pending' : ''}`}
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => { void refreshStatsTab(); }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

export function StatsView() {
  // Refetch every time the tab is opened rather than caching across mounts:
  // this is an operate-mode dashboard, and a stale number with no visible
  // "stale" marker is worse than a brief loading flash. All sections'
  // signals load up front (not lazily per section) so the section badges
  // are honest from the first paint and switching is instant. Runs through
  // `refreshStatsTab` — the SAME function the manual Refresh button calls —
  // so mount and refresh share one busy flag and one as-of stamp.
  //
  // Before that: seed the shared window/population signals from the URL
  // (arrival-efficiency fix) so a pasted deep link reproduces the window and
  // population it points at instead of the hardcoded 30d/prod defaults.
  // Plain signal writes, not `setStatsWindow`/`setStatsPopulation` — those
  // no-op on an unchanged value and exist to trigger their OWN refetch,
  // which `refreshStatsTab` below is about to do anyway.
  useEffect(() => {
    const params = getRouteParams();
    const urlWindow = parseStatsWindow(params);
    const urlPopulation = parseStatsPopulation(params);
    if (urlWindow) statsWindow.value = urlWindow;
    if (urlPopulation) statsPopulation.value = urlPopulation;
    void refreshStatsTab();

    // A cross-section link built with `buildPanelHref` (stats-store.ts) can
    // carry an `anchor` param naming a DOM id to land on — the cold-load
    // counterpart to `navigateToPanel`'s in-page scroll, for a link that was
    // middle-clicked or pasted into a fresh tab rather than clicked in place.
    // `section` (parsed above, via `activeSection`'s own init) already put
    // the right panel on screen by the time this runs, so the id exists.
    // Consumed once, then cleared, so a later refresh of this same tab does
    // not keep re-scrolling to wherever an old link once pointed.
    const anchorId = params.get('anchor');
    if (anchorId && typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        document.getElementById(anchorId)?.scrollIntoView({ block: 'start' });
      });
      updateRouteParams({ anchor: undefined });
    }
  }, []);

  const section = activeSection.value;
  // The Prod|Test and window controls scope only the four windowed stats
  // endpoints. Config is a fact about the environment and reflections are
  // "the last few cycles, full stop" — showing scoping chrome above panels
  // it does not scope is the invisible-control problem this tab exists to
  // avoid, so the toolbar renders only on the sections it really governs.
  const windowed = section === 'health' || section === 'value';

  return (
    <div class="stats-view">
      {/* Ribbon is "directly under the tabs, above everything else" per Task
          5's brief — four glance-level indicators (drift, model integrity,
          levers, error rate) that stay visible whichever section is open.
          It is deliberately NOT a summary of every section's worst signal;
          the badges on the section switcher carry that per-section fold
          (`attentionBySection`), so nothing alarming is invisible while
          another section is open. The ribbon reads its own
          always-production signal (`ribbonIntegrityStats`) and is NOT
          affected by the Prod|Test control — see stats-ribbon.tsx. */}
      <StatsRibbon />

      <TabToolbar />

      <SectionNav />

      {windowed && (
        <div class="stats-view__toolbar">
          <PopulationSelector />
          <WindowSelector />
        </div>
      )}

      {windowed && <PopulationDisclosure />}

      {section === 'health' && (
        <>
          <StatsIntegrityPanel />
          <OperationalPanel />
        </>
      )}

      {section === 'value' && (
        <>
          <CostQualityPanel />
          {/* Directly after Cost & Quality, which reports what reviews COST
              and PRODUCE — this is the only panel that reports whether any
              of it MATTERED (it reads `finding_outcomes`, not
              `pr_reviews`). */}
          <ReviewValuePanel />
        </>
      )}

      {/* Reflection is its own section, not an appendix to Cost & value:
          it is the one surface on this tab with a human ACTION on it
          (approve/reject), and its section button carries a pending count
          so that action is findable without scrolling past four panels. */}
      {section === 'reflection' && <ReflectionCard />}

      {section === 'config' && <ConfigPanel />}
    </div>
  );
}
