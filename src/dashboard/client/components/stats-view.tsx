import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
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
import { ReflectionCard, listState as reflectionListState, loadReflections } from './reflection-card.tsx';
import { assessFlaggedModelKeys, assessErrorRate } from '../assessors.ts';
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
// segmented switcher. The ribbon stays global above it: it is already the
// "worst signal wins" summary for the whole tab, which is exactly what makes
// hiding five of seven panels safe — an alarm is visible before any
// switching. Each section button additionally carries its own attention
// marker so a reader knows WHERE to click, not just that something is off.
// ---------------------------------------------------------------------------

const STATS_SECTIONS = ['health', 'value', 'reflection', 'config'] as const;
export type StatsSection = (typeof STATS_SECTIONS)[number];

const SECTION_LABEL: Record<StatsSection, string> = {
  health: 'Health',
  value: 'Cost & value',
  reflection: 'Reflection',
  config: 'Config',
};

const SECTION_STORAGE_KEY = 'stats-section';

function initialSection(): StatsSection {
  try {
    const saved = localStorage.getItem(SECTION_STORAGE_KEY);
    if (saved && (STATS_SECTIONS as readonly string[]).includes(saved)) return saved as StatsSection;
  } catch { /* storage unavailable — session default is fine */ }
  return 'health';
}

const activeSection = signal<StatsSection>(initialSection());

function setSection(s: StatsSection): void {
  activeSection.value = s;
  try { localStorage.setItem(SECTION_STORAGE_KEY, s); } catch { /* best effort */ }
}

/** How many of the integrity readings ask for attention right now. Reuses
 *  the SAME assessors the Integrity panel itself renders with — the badge
 *  must never disagree with the panel it points at. Only the two assessors
 *  that need nothing beyond IntegrityStats run here; the contamination
 *  reading needs its own fetch and stays the panel's business. Null while
 *  the signal has not settled — no guessed badge. */
export function healthAttentionCount(integrity: FetchState<Parameters<typeof assessFlaggedModelKeys>[0]>): number | null {
  if (integrity.status !== 'ready') return null;
  const readings = [
    assessFlaggedModelKeys(integrity.data),
    assessErrorRate(integrity.data.errorRate, integrity.data.lowSample),
  ];
  return readings.filter((r) => r.severity === 'attention').length;
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

function SectionBadge({ count, kind }: { count: number | null; kind: 'attention' | 'pending' }) {
  if (count == null || count === 0) return null;
  const label = kind === 'attention'
    ? `${countOf(count, 'reading')} asking for attention`
    : `${countOf(count, 'proposal')} waiting for a decision`;
  return <span class={`stats-subnav__badge stats-subnav__badge--${kind}`} title={label} aria-label={label}>{count}</span>;
}

/** Same `role="group"` + per-button `aria-pressed` convention as the window
 *  and population selectors below it — deliberately NOT a nested
 *  `role="tablist"` inside the app's real tab bar, for the same reason the
 *  window selector isn't one. */
function SectionNav() {
  const current = activeSection.value;
  const health = healthAttentionCount(integrityStats.value);
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
          {s === 'health' && <SectionBadge count={health} kind="attention" />}
          {s === 'reflection' && <SectionBadge count={pending} kind="pending" />}
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

export function StatsView() {
  // Refetch every time the tab is opened rather than caching across mounts:
  // this is an operate-mode dashboard, and a stale number with no visible
  // "stale" marker is worse than a brief loading flash. All sections'
  // signals load up front (not lazily per section) so the section badges
  // are honest from the first paint and switching is instant.
  // `loadReflections` joins the same policy: its badge and the card share
  // one signal, so a decision made inside the card updates the badge too.
  useEffect(() => { loadAllStats(); void loadReflections(); }, []);

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
          5's brief — and it is what makes the section switcher below safe:
          it summarizes the worst signal across ALL sections, so nothing
          alarming is invisible while another section is open. The ribbon
          reads its own always-production signal (`ribbonIntegrityStats`)
          and is NOT affected by the Prod|Test control — see
          stats-ribbon.tsx. */}
      <StatsRibbon />

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
