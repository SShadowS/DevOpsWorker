import { useEffect } from 'preact/hooks';
import {
  statsWindow, costStats, qualityStats, operationalStats,
  setStatsWindow, loadAllStats, STATS_WINDOWS,
} from '../stats-store.ts';
import type { FetchState, StatsWindow } from '../stats-store.ts';
import { formatCost } from '../format.ts';
import { StatsRibbon } from './stats-ribbon.tsx';
import { StatsIntegrityPanel } from './stats-integrity.tsx';
import { ConfigPanel } from './stats-config.tsx';

// ---------------------------------------------------------------------------
// Shell for the Stats & Config tab (Task 4). Owns: the third tab's panel
// container, the shared window selector, and data fetching for all six
// endpoints with loading/empty/error states. The remaining placeholder slots
// below (Cost & Quality/Task 8, Operational/Task 9) still get their body
// from a later task; Integrity (Task 6) and Config (Task 7) have each been
// replaced by their own component (`stats-integrity.tsx`, `stats-config.tsx`),
// matching the ribbon's precedent of extracting a finished slot out of the
// generic `<StatsSlot>` placeholder.
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

interface StatsSlotProps {
  id: string;
  title: string;
  taskLabel: string;
  /** Omit for unwindowed data (e.g. config) — the omission itself is the
   *  correct signal, not a missing label. */
  window?: StatsWindow;
  sources: SlotSourceInfo[];
}

/** One placeholder section. Border colour + status text both come from the
 *  same `worstStatus()` call so colour is never the only signal. Once a
 *  panel task lands, its component replaces the `<ul>` + placeholder note
 *  below — the loading/empty/error branching above stays as-is. */
function StatsSlot({ id, title, taskLabel, window, sources }: StatsSlotProps) {
  const overall = worstStatus(sources);
  return (
    <section id={id} class={`stats-slot stats-slot--${overall}`} aria-label={title}>
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">{title}</h3>
        {window && <span class="stats-slot__window" title="Time window this section reads">{window}</span>}
        <span class="stats-slot__task-tag">{taskLabel}</span>
      </div>
      <ul class="stats-slot__sources">
        {sources.map((s) => (
          <li key={s.label} class={`stats-slot__source stats-slot__source--${s.status}`}>
            <span class="stats-slot__source-label">{s.label}</span>
            <span class="stats-slot__source-message">{s.message}</span>
          </li>
        ))}
      </ul>
      {overall === 'ready' && (
        <p class="stats-slot__placeholder-note">Data loaded — panel UI not yet built ({taskLabel}).</p>
      )}
    </section>
  );
}

export function StatsView() {
  // Refetch every time the tab is opened rather than caching across mounts:
  // this is an operate-mode dashboard, and a stale number with no visible
  // "stale" marker is worse than a brief loading flash.
  useEffect(() => { loadAllStats(); }, []);

  const currentWindow = statsWindow.value;
  const cost = costStats.value;
  const quality = qualityStats.value;
  const operational = operationalStats.value;

  return (
    <div class="stats-view">
      {/* Ribbon is "directly under the tabs, above everything else" per Task
          5's brief — it's the reason this page exists; the window selector
          (chrome, not a panel) comes after it, not before. Own component
          (stats-ribbon.tsx): each of its 4 indicators degrades through its
          OWN fetch's loading/error/empty/ready cycle rather than the
          combined-worst-of-N-sources pattern StatsSlot below uses, since the
          drift comparison is worth reading even when /api/stats/integrity
          comes back empty for this window. */}
      <StatsRibbon />

      <div class="stats-view__toolbar">
        <WindowSelector />
      </div>

      <StatsIntegrityPanel />

      <ConfigPanel />

      <StatsSlot
        id="stats-slot-cost-quality"
        title="Cost & Quality"
        taskLabel="Task 8"
        window={currentWindow}
        sources={[
          describeFetchState('Cost', cost, (d) => `n=${d.sampleSize} · total ${formatCost(d.totalCostUsd)}`),
          describeFetchState('Quality', quality, (d) => `n=${d.sampleSize} · avg read-band items ${d.avgReadBandItems?.toFixed(1) ?? 'n/a'}`),
        ]}
      />

      <StatsSlot
        id="stats-slot-operational"
        title="Operational"
        taskLabel="Task 9"
        window={currentWindow}
        sources={[
          describeFetchState('Operational stats', operational, (d) =>
            `n=${d.sampleSize} · ${d.reviewsPerDay.average?.toFixed(1) ?? 'n/a'} reviews/day`),
        ]}
      />
    </div>
  );
}
