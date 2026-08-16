import { signal } from '@preact/signals';
import type { StatsWindow, CostStats, QualityStats, IntegrityStats, OperationalStats, ReviewValueStats, DriftStats, Population } from '../stats.ts';
import type { ConfigReport } from '../config-report.ts';
import { parseEnumParam, updateRouteParams } from './url-route.ts';

export type { StatsWindow, Population };

export const STATS_WINDOWS: readonly StatsWindow[] = ['7d', '30d', '90d'];
export const STATS_POPULATIONS: readonly Population[] = ['prod', 'test'];

/** The Stats & Config tab's four sections (moved here from stats-view.tsx
 *  so the URL-route parsers below and the section signal in stats-view.tsx
 *  can both reach it without stats-view.tsx and url-route.ts importing each
 *  other). */
export const STATS_SECTIONS = ['health', 'value', 'reflection', 'config'] as const;
export type StatsSection = (typeof STATS_SECTIONS)[number];

// ---------------------------------------------------------------------------
// URL-route parsers (arrival-efficiency fix) — pure, total, unit-tested.
// Each returns `null` for an absent or unrecognised param rather than a
// hardcoded default: "the URL said nothing" and "the URL said something
// invalid" both mean the same thing to a caller (fall back to whatever it
// otherwise would have used — a remembered choice, or a hardcoded default),
// and collapsing them here keeps that fallback decision at the call site
// instead of guessing a default a caller didn't ask for.
// ---------------------------------------------------------------------------

export function parseStatsSection(params: URLSearchParams): StatsSection | null {
  return parseEnumParam(params, 'section', STATS_SECTIONS);
}

export function parseStatsWindow(params: URLSearchParams): StatsWindow | null {
  return parseEnumParam(params, 'window', STATS_WINDOWS);
}

export function parseStatsPopulation(params: URLSearchParams): Population | null {
  return parseEnumParam(params, 'population', STATS_POPULATIONS);
}

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
 * `head` is resolved LIVE from a read-only bind-mounted `.git` (or reports
 * an explicit unresolved reason when the mount/git command fails —
 * see `resolveHeadSha` in `stats.ts`), `composeService` reads an env var,
 * and `spawnedImage.mostRecentSha` is an UNWINDOWED whole-table search
 * (`stats.ts` `getDriftStats`) — none of that depends on the window holding
 * any rows. Even `spawnedImage.distribution` being empty at n=0 is itself
 * informative, not blank.
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

/** The one shared population every population-aware panel reads. Defaults to
 *  `'prod'` so a fresh page load — and every existing screenshot/expectation
 *  of this tab — shows production unless a reader deliberately opts into
 *  Test. See `ribbonIntegrityStats` below for the one signal that must NOT
 *  follow this toggle. */
export const statsPopulation = signal<Population>('prod');

export const costStats = signal<FetchState<CostStats>>({ status: 'loading' });
export const qualityStats = signal<FetchState<QualityStats>>({ status: 'loading' });
export const integrityStats = signal<FetchState<IntegrityStats>>({ status: 'loading' });
export const operationalStats = signal<FetchState<OperationalStats>>({ status: 'loading' });
/** Review value — the one windowed signal whose `sampleSize` counts FINDINGS
 *  (`finding_outcomes` rows), not `pr_reviews` rows. `classifyWindowedResponse`
 *  still applies unchanged: a window with plenty of reviews but no classified
 *  findings genuinely has nothing to show, and 'empty' is the right reading. */
export const reviewValueStats = signal<FetchState<ReviewValueStats>>({ status: 'loading' });
export const driftStats = signal<FetchState<DriftStats>>({ status: 'loading' });
/** Not windowed — `/api/config` reports resolved configuration, not a time-series stat. */
export const configReport = signal<FetchState<ConfigReport>>({ status: 'loading' });

/** When the windowed data currently on screen (cost/quality/integrity/
 *  operational/review-value/drift) was last fetched — the tab-level "as of"
 *  stamp (stats-view.tsx's `TabToolbar`) reads this. Set inside
 *  `loadStatsForWindow` once its batch actually lands (after the
 *  supersede-token check, never on a discarded response), so a plain
 *  window or population switch keeps the stamp honest, not only the manual
 *  Refresh button. Deliberately NOT updated by Config or Reflection: Config
 *  already shows its own `generatedAt` (stats-config.tsx) and Reflection is
 *  unwindowed, so folding either in here would make the stamp describe data
 *  it does not own. `null` before the first load completes, so the stamp
 *  can render nothing rather than a fabricated time. */
export const statsLastLoadedAt = signal<string | null>(null);

/** True while a refresh cycle (the tab's initial mount load, or the manual
 *  Refresh button — see `refreshStatsTab` in stats-view.tsx) is in flight.
 *  The Refresh button reads this for its disabled/pending state and to
 *  guard against a double-fire. Deliberately NOT set by `setStatsWindow`/
 *  `setStatsPopulation`: those already have their own visible feedback (the
 *  panels' own `FetchState: 'loading'` rendering), so tying the Refresh
 *  button's busy state to every scope-picker click would just be a second,
 *  redundant loading indicator for the same fetch. */
export const statsRefreshing = signal(false);

/**
 * The status ribbon (stats-ribbon.tsx) must always describe PRODUCTION,
 * never whatever population `statsPopulation` currently selects — the
 * ribbon sits directly above panels that DO follow the toggle, and a ribbon
 * that silently flipped to Test underneath a "production only" label would
 * be exactly the ambiguous-reading failure this tab exists to catch (a
 * screenshot of the screen must not be ambiguous about which population is
 * which). `integrityStats` is the one signal the ribbon shares with a
 * toggled panel (Integrity uses it too), so it alone needs a dedicated,
 * always-prod copy here — `configReport` and `driftStats`, the ribbon's
 * other two sources, are already population-independent (Task 3 left
 * `/api/config` and `/api/drift` untouched) and need no equivalent. */
export const ribbonIntegrityStats = signal<FetchState<IntegrityStats>>({ status: 'loading' });

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
  reviewValueStats.value = { status: 'loading' };
  driftStats.value = { status: 'loading' };
  ribbonIntegrityStats.value = { status: 'loading' };

  // /api/drift is production-only and unchanged — no population param.
  const population = statsPopulation.value;
  const qs = `?window=${window}&population=${population}`;
  // Only fire a second, prod-pinned integrity request while actually
  // viewing Test — when the toggle is already 'prod' (the default),
  // `integrity` below already IS the prod reading the ribbon needs, so
  // reusing it avoids an identical duplicate query on every load.
  const needsProdPinnedIntegrity = population !== 'prod';

  const [cost, quality, integrity, operational, reviewValue, drift, ribbonIntegrity] = await Promise.all([
    fetchJson<CostStats>(`/api/stats/cost${qs}`),
    fetchJson<QualityStats>(`/api/stats/quality${qs}`),
    fetchJson<IntegrityStats>(`/api/stats/integrity${qs}`),
    fetchJson<OperationalStats>(`/api/stats/operational${qs}`),
    fetchJson<ReviewValueStats>(`/api/stats/review-value${qs}`),
    fetchJson<DriftStats>(`/api/drift?window=${window}`),
    needsProdPinnedIntegrity
      ? fetchJson<IntegrityStats>(`/api/stats/integrity?window=${window}&population=prod`)
      : Promise.resolve(null),
  ]);
  if (token !== statsRequestToken) return; // superseded by a later window/population switch

  // The tab-level "as of" stamp (stats-view.tsx's TabToolbar) describes THIS
  // windowed batch specifically — Config already shows its own `generatedAt`
  // (stats-config.tsx) and Reflection is "the last few cycles, full stop",
  // neither scoped by window/population the way this batch is. Stamping
  // here, not in `refreshStatsTab`'s wrapper, means a plain window or
  // population switch (not just the manual Refresh button) also keeps the
  // stamp honest — the data on screen just changed, so the stamp must too.
  statsLastLoadedAt.value = new Date().toISOString();

  costStats.value = cost.ok ? classifyWindowedResponse(cost.data) : { status: 'error', message: cost.message };
  qualityStats.value = quality.ok ? classifyWindowedResponse(quality.data) : { status: 'error', message: quality.message };
  const integrityResult: FetchState<IntegrityStats> =
    integrity.ok ? classifyWindowedResponse(integrity.data) : { status: 'error', message: integrity.message };
  integrityStats.value = integrityResult;
  operationalStats.value = operational.ok ? classifyWindowedResponse(operational.data) : { status: 'error', message: operational.message };
  reviewValueStats.value = reviewValue.ok ? classifyWindowedResponse(reviewValue.data) : { status: 'error', message: reviewValue.message };
  driftStats.value = drift.ok ? classifyDriftResponse(drift.data) : { status: 'error', message: drift.message };
  ribbonIntegrityStats.value = ribbonIntegrity == null
    ? integrityResult
    : ribbonIntegrity.ok ? classifyWindowedResponse(ribbonIntegrity.data) : { status: 'error', message: ribbonIntegrity.message };
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
 *  already on that window (guards a redundant click re-triggering 6 fetches).
 *  Patches the URL's `window` param via `replaceState` (arrival-efficiency
 *  fix) — a scope-picker click must not spend a back-button step, matching
 *  the population selector below and the section switcher in stats-view.tsx. */
export function setStatsWindow(next: StatsWindow): void {
  if (statsWindow.value === next) return;
  statsWindow.value = next;
  updateRouteParams({ window: next });
  void loadStatsForWindow(next);
}

/** Switch the shared population and refetch the five population-aware
 *  endpoints — mirrors `setStatsWindow` exactly, including its no-op guard
 *  and its URL patch. Deliberately routed through the SAME
 *  `loadStatsForWindow` path the window signal already uses rather than a
 *  second fetch effect: switching population re-runs the identical
 *  fetch-and-classify sequence, which reads `statsPopulation.value` for the
 *  query string on its own. */
export function setStatsPopulation(next: Population): void {
  if (statsPopulation.value === next) return;
  statsPopulation.value = next;
  updateRouteParams({ population: next });
  void loadStatsForWindow(statsWindow.value);
}

/** Load everything the Stats & Config tab needs. Called once when the tab
 *  mounts, and again by the manual Refresh button (`refreshStatsTab` in
 *  stats-view.tsx, which also re-runs reflections — a concern this file
 *  does not own). Config has no window dependency and is fetched once here;
 *  `setStatsWindow` alone drives windowed refetches thereafter. Returns its
 *  Promise (rather than firing-and-forgetting, as it did before the
 *  arrival-efficiency fix) so a caller can await both fetches settling
 *  before recording the "as of" timestamp. */
export async function loadAllStats(): Promise<void> {
  await Promise.all([loadStatsForWindow(statsWindow.value), loadConfigReport()]);
}
