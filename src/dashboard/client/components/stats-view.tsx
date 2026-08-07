import { useEffect } from 'preact/hooks';
import {
  statsWindow, statsPopulation, costStats, qualityStats, integrityStats, operationalStats,
  setStatsWindow, setStatsPopulation, loadAllStats, STATS_WINDOWS, STATS_POPULATIONS,
} from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type { Population, PopulationMeta } from '../../stats.ts';
import { StatsRibbon } from './stats-ribbon.tsx';
import { StatsIntegrityPanel } from './stats-integrity.tsx';
import { ConfigPanel } from './stats-config.tsx';
import { CostQualityPanel } from './stats-costquality.tsx';
import { ReviewValuePanel } from './stats-review-value.tsx';
import { OperationalPanel } from './stats-operational.tsx';

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
      : `${otherCount} test run(s) excluded from this window.`;
  }
  return otherCount === 0
    ? 'Showing test runs only. No production reviews in this window.'
    : `Showing test runs only. ${otherCount} production review(s) excluded from this window.`;
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

export function StatsView() {
  // Refetch every time the tab is opened rather than caching across mounts:
  // this is an operate-mode dashboard, and a stale number with no visible
  // "stale" marker is worse than a brief loading flash.
  useEffect(() => { loadAllStats(); }, []);

  return (
    <div class="stats-view">
      {/* Ribbon is "directly under the tabs, above everything else" per Task
          5's brief — it's the reason this page exists; the window selector
          (chrome, not a panel) comes after it, not before. Own component
          (stats-ribbon.tsx): each of its 4 indicators degrades through its
          OWN fetch's loading/error/empty/ready cycle rather than a
          combined-worst-of-N-sources pattern, since the drift comparison is
          worth reading even when /api/stats/integrity comes back empty for
          this window. The ribbon reads its own always-production signal
          (`ribbonIntegrityStats`) and is NOT affected by the Prod|Test
          control below it — see stats-ribbon.tsx. */}
      <StatsRibbon />

      <div class="stats-view__toolbar">
        <PopulationSelector />
        <WindowSelector />
      </div>

      <PopulationDisclosure />

      <StatsIntegrityPanel />

      <ConfigPanel />

      <CostQualityPanel />

      {/* Directly after Cost & Quality, which reports what reviews COST and
          PRODUCE. This is the only slot that reports whether any of it
          MATTERED, and it reads a different table (`finding_outcomes`) — so it
          sits beside the cost figures it qualifies, not at the end of the
          page under operational throughput. */}
      <ReviewValuePanel />

      <OperationalPanel />
    </div>
  );
}
