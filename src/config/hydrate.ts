import type { IRegistryStore } from './registry-store.interface.ts';
import { replaceRepos } from './repos.ts';
import { replaceCompanions } from './companions.ts';

/**
 * Hydrate the live repo and companion registries from the database, replacing
 * whatever is currently in memory. Every process that reads `repos` or
 * `companionRegistry` (watcher, dashboard, webhook server, CLI) should call
 * this once at startup, after the one-time manifest seed
 * (`seedRegistryFromManifest`) has had a chance to populate an empty table.
 */
export async function hydrateRegistryFromDb(store: IRegistryStore): Promise<void> {
  const [reposFromDb, companionsFromDb] = await Promise.all([
    store.listRepos(),
    store.listCompanions(),
  ]);
  replaceRepos(reposFromDb);
  replaceCompanions(companionsFromDb);
}

/**
 * `hydrateRegistryFromDb`, but a failure warns instead of throwing.
 *
 * `src/cli/index.ts` gives every process's startup hydration a small
 * (2×500ms) retry budget before falling back to the manifest-only registry.
 * A command's own `connectStores()` call — `run.ts`, `continue.ts`,
 * `review-pr.ts` — then retries the database connection for up to ~20s, and
 * can succeed AFTER that startup hydration already gave up. Nothing
 * re-hydrates the registry when that later connection succeeds, so a
 * container in that state serves the manifest snapshot — frozen at whatever
 * it was seeded with, arbitrarily old the moment an admin edits a repo — for
 * its entire run, with no error. Call this immediately after your own
 * `connectStores()` succeeds, before reading `repos` or `companionRegistry`,
 * to close that gap the same way the watcher's per-tick hydrate already does
 * for the long-running processes.
 */
export async function hydrateRegistryBestEffort(store: IRegistryStore): Promise<void> {
  try {
    await hydrateRegistryFromDb(store);
  } catch (err) {
    console.warn(`[registry] failed to refresh repo/companion registry from database: ${err instanceof Error ? err.message : err}`);
  }
}

// Timestamp of the last hydration done through `refreshRegistryIfStale`, in
// whatever clock that call's `now` argument supplied. Module-level because
// `repos`/`companionRegistry` are themselves module-level singletons — one
// staleness clock per process, shared by every caller.
//
// Deliberately NOT touched by `hydrateRegistryFromDb` itself: that function
// takes no clock, so recording a timestamp there would mean recording it via
// the real `Date.now()` even when a caller later polls with an injected fake
// clock — mixing two clocks would make the TTL comparison meaningless. Only
// `refreshRegistryIfStale` writes this, always using its own `now`.
let lastHydratedAt: number | undefined;

/**
 * Re-hydrate the registries only if more than `ttlMs` has passed since the
 * last hydration done through this function. Lets a long-running process
 * (e.g. the watcher's poll loop) keep its view of the registry fresh without
 * hitting the database on every tick.
 *
 * `now` defaults to `Date.now`; tests inject a fake clock so TTL behaviour
 * can be asserted without a real wait.
 */
export async function refreshRegistryIfStale(
  store: IRegistryStore,
  ttlMs: number,
  now: () => number = Date.now,
): Promise<void> {
  const currentTime = now();
  if (lastHydratedAt !== undefined && currentTime - lastHydratedAt < ttlMs) {
    return;
  }
  await hydrateRegistryFromDb(store);
  lastHydratedAt = currentTime;
}

/** Reset the module-level staleness clock — exported for testing only. */
export function _resetHydrationState(): void {
  lastHydratedAt = undefined;
}
