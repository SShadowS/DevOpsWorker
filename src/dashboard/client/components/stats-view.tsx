import { useEffect } from 'preact/hooks';
import {
  statsWindow,
  setStatsWindow, loadAllStats, STATS_WINDOWS,
} from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import { StatsRibbon } from './stats-ribbon.tsx';
import { StatsIntegrityPanel } from './stats-integrity.tsx';
import { ConfigPanel } from './stats-config.tsx';
import { CostQualityPanel } from './stats-costquality.tsx';
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
// `worstStatus`/`SlotSourceInfo` below are kept: they're exported, unit-tested
// as general-purpose `FetchState` classification helpers independent of any
// one panel (see stats-view.test.ts), not `StatsSlot`-specific — but nothing
// in this tab calls them anymore now that every panel builds its own view
// model. Flagged in task-9-report.md as a candidate for Task 10 to prune
// rather than pruned here, since removing tested, still-correct code is a
// bigger call than this task's stated scope.
// ---------------------------------------------------------------------------

type SlotStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface SlotSourceInfo {
  label: string;
  status: SlotStatus;
  message: string;
}

/** Turn one fetch state into a labelled, human-readable status line. Pure —
 *  exported for unit testing. The four branches are exhaustive: an added
 *  `FetchState` variant fails to typecheck here instead of silently falling
 *  through to a blank slot. */
export function describeFetchState<T>(
  label: string,
  state: FetchState<T>,
  describeReady: (data: T) => string,
): SlotSourceInfo {
  switch (state.status) {
    case 'loading':
      return { label, status: 'loading', message: 'Loading…' };
    case 'error':
      return { label, status: 'error', message: `Failed to load: ${state.message}` };
    case 'empty':
      return { label, status: 'empty', message: 'No data recorded in this window.' };
    case 'ready':
      return { label, status: 'ready', message: describeReady(state.data) };
  }
}

const STATUS_RANK: Record<SlotStatus, number> = { error: 0, loading: 1, empty: 2, ready: 3 };

/** Combine multiple source statuses into the single worst one, for a slot's
 *  overall border colour — error beats loading beats empty beats ready.
 *  Pure — exported for unit testing. */
export function worstStatus(sources: SlotSourceInfo[]): SlotStatus {
  return sources.reduce<SlotStatus>((worst, s) => (STATUS_RANK[s.status] < STATUS_RANK[worst] ? s.status : worst), 'ready');
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
          this window. */}
      <StatsRibbon />

      <div class="stats-view__toolbar">
        <WindowSelector />
      </div>

      <StatsIntegrityPanel />

      <ConfigPanel />

      <CostQualityPanel />

      <OperationalPanel />
    </div>
  );
}
