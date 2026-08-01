import { signal } from '@preact/signals';
import type { StatsWindow, CostStats, QualityStats, IntegrityStats, OperationalStats, DriftStats } from '../stats.ts';
import type { ConfigReport } from '../config-report.ts';

export type { StatsWindow };

export const STATS_WINDOWS: readonly StatsWindow[] = ['7d', '30d', '90d'];

/**
 * Fetch lifecycle for one stats/config panel. `'empty'` is deliberately
 * distinct from `'error'`: empty means the request succeeded and the window
 * genuinely holds zero rows — a real, sayable fact. Error means the request
 * itself failed. Collapsing the two into one blank-looking state is exactly
 * the failure mode the design constraints call out: an operator at 2am needs
 * to know which one they're looking at.
 */
export type FetchState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; data: T };

/** Classify a windowed stats response by its own reported sample size. Pure —
 *  no network, no signals — so it's unit-testable with plain fixture data.
 *
 *  Applies to cost/quality/integrity/operational, whose content genuinely
 *  IS derived from the window's rows — a real zero means nothing to show.
 *  It deliberately does NOT apply to drift; see `classifyDriftResponse`. */
export function classifyWindowedResponse<T extends { sampleSize: number }>(data: T): FetchState<T> {
  return data.sampleSize === 0 ? { status: 'empty' } : { status: 'ready', data };
}

/**
 * Drift is never "empty" the way the other windowed endpoints are.
 * `sampleSize` on `/api/drift` counts PR-review rows in the window, but
 * `head` comes from a hardcoded not-observable-in-container marker,
 * `composeService` reads an env var, and `spawnedImage.mostRecentSha` is an
 * UNWINDOWED whole-table search (`stats.ts` `getDriftStats`) — none of that
 * depends on the window holding any rows. Even `spawnedImage.distribution`
 * being empty at n=0 is itself informative, not blank.
 *
 * Running drift through `classifyWindowedResponse` would collapse a
 * zero-review window to a generic "No data recorded in this window" and
 * hide the build-provenance comparison exactly when review data is thin —
 * backwards, since drift is the reason the status ribbon exists and is most
 * worth reading when nothing else is populated. So: always ready on a
 * successful fetch, never empty. Pure — unit-tested with fixture data. */
export function classifyDriftResponse(data: DriftStats): FetchState<DriftStats> {
  return { status: 'ready', data };
}

/** The one shared window every stats panel reads — set here, consumed everywhere. */
export const statsWindow = signal<StatsWindow>('30d');

export const costStats = signal<FetchState<CostStats>>({ status: 'loading' });
export const qualityStats = signal<FetchState<QualityStats>>({ status: 'loading' });
export const integrityStats = signal<FetchState<IntegrityStats>>({ status: 'loading' });
export const operationalStats = signal<FetchState<OperationalStats>>({ status: 'loading' });
export const driftStats = signal<FetchState<DriftStats>>({ status: 'loading' });
/** Not windowed — `/api/config` reports resolved configuration, not a time-series stat. */
export const configReport = signal<FetchState<ConfigReport>>({ status: 'loading' });

async function fetchJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, message: `${res.status} ${res.statusText}` };
    return { ok: true, data: await res.json() as T };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Network error' };
  }
}

// Monotonic token guards against an in-flight request from a superseded
// window landing after a newer one — e.g. a fast 7d -> 30d click resolving
// out of order would otherwise leave the 7d numbers on screen under a "30d"
// selector with nothing to say so.
let statsRequestToken = 0;

export async function loadStatsForWindow(window: StatsWindow): Promise<void> {
  const token = ++statsRequestToken;
  costStats.value = { status: 'loading' };
  qualityStats.value = { status: 'loading' };
  integrityStats.value = { status: 'loading' };
  operationalStats.value = { status: 'loading' };
  driftStats.value = { status: 'loading' };

  const [cost, quality, integrity, operational, drift] = await Promise.all([
    fetchJson<CostStats>(`/api/stats/cost?window=${window}`),
    fetchJson<QualityStats>(`/api/stats/quality?window=${window}`),
    fetchJson<IntegrityStats>(`/api/stats/integrity?window=${window}`),
    fetchJson<OperationalStats>(`/api/stats/operational?window=${window}`),
    fetchJson<DriftStats>(`/api/drift?window=${window}`),
  ]);
  if (token !== statsRequestToken) return; // superseded by a later window switch

  costStats.value = cost.ok ? classifyWindowedResponse(cost.data) : { status: 'error', message: cost.message };
  qualityStats.value = quality.ok ? classifyWindowedResponse(quality.data) : { status: 'error', message: quality.message };
  integrityStats.value = integrity.ok ? classifyWindowedResponse(integrity.data) : { status: 'error', message: integrity.message };
  operationalStats.value = operational.ok ? classifyWindowedResponse(operational.data) : { status: 'error', message: operational.message };
  driftStats.value = drift.ok ? classifyDriftResponse(drift.data) : { status: 'error', message: drift.message };
}

let configRequestToken = 0;

export async function loadConfigReport(): Promise<void> {
  const token = ++configRequestToken;
  configReport.value = { status: 'loading' };
  const result = await fetchJson<ConfigReport>('/api/config');
  if (token !== configRequestToken) return;
  configReport.value = result.ok ? { status: 'ready', data: result.data } : { status: 'error', message: result.message };
}

/** Switch the shared window and refetch every windowed endpoint. No-op if
 *  already on that window (guards a redundant click re-triggering 5 fetches). */
export function setStatsWindow(next: StatsWindow): void {
  if (statsWindow.value === next) return;
  statsWindow.value = next;
  void loadStatsForWindow(next);
}

/** Load everything the Stats & Config tab needs. Called once when the tab
 *  mounts. Config has no window dependency and is fetched once here;
 *  `setStatsWindow` alone drives windowed refetches thereafter. */
export function loadAllStats(): void {
  void loadStatsForWindow(statsWindow.value);
  void loadConfigReport();
}
