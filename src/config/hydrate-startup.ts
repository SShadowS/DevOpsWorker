import type { IRegistryStore } from './registry-store.interface.ts';
import type { OverlayManifest } from '../overlay/types.ts';
import { applyOverlayRegistries } from '../overlay/index.ts';
import { seedRegistryFromManifest, type TableSeedResult } from './seed.ts';
import { repos, replaceRepos } from './repos.ts';
import { companionRegistry, replaceCompanions } from './companions.ts';

/** The one piece of `connectStores()` this needs, kept narrow so tests can
 *  fake it without standing up a real store bundle or a database. */
export interface HydrateStartupDeps {
  connectStores(): Promise<{ registryStore: IRegistryStore }>;
}

/**
 * The registry half of every process's startup: apply the overlay manifest,
 * then let the database win wherever it has data of its own.
 *
 * Called once from `src/cli/index.ts`'s `main()`, which every command —
 * `run`, `watch`, `dashboard`, `webhook-server`, and every spawned container
 * (they re-enter this same `main()`) — dispatches through before doing
 * anything else. That is also why nothing here may throw: a database problem
 * must never block a command that doesn't even need the database (`--help`,
 * `diagnose`), so every failure is caught and logged, and the live registry
 * simply falls back to whatever the manifest already put there.
 *
 * Order is deliberate: `applyOverlayRegistries` (manifest → live registry)
 * runs unconditionally first, so a fresh install — or a database that never
 * comes up — still has something to run on. Then, only if the database is
 * reachable, `seedRegistryFromManifest` (manifest → database, once, only
 * while the table is still empty) runs BEFORE reading the database back into
 * the live registry: hydrating first would read an empty table and wipe out
 * the manifest's merge via `replaceRepos`/`replaceCompanions`, and nothing
 * would re-hydrate the live registry once the seed ran afterward.
 *
 * The database read that follows is deliberately PER-TABLE rather than a
 * single `hydrateRegistryFromDb` call: a table whose seed just failed
 * validation is still empty (see `TableSeedResult`'s jsdoc), and replacing
 * the live registry with that empty read would erase the manifest's entries
 * `applyOverlayRegistries` already put there — one malformed manifest field
 * would leave every process with ZERO repos instead of the manifest's,
 * which is what a real deployment hit before this existed. Skip the replace
 * for exactly the table that failed; the other table (and a from-scratch
 * hydrate once the manifest is fixed and re-seeds) is unaffected.
 */
export async function hydrateStartupRegistry(
  overlay: OverlayManifest,
  deps: HydrateStartupDeps,
): Promise<void> {
  applyOverlayRegistries(overlay);

  let registryStore: IRegistryStore;
  try {
    ({ registryStore } = await deps.connectStores());
  } catch (err) {
    console.warn(`[registry] database unavailable — continuing with the manifest-only registry (${errorMessage(err)})`);
    return;
  }

  // Never throws (see seedRegistryFromManifest's jsdoc) — each table's
  // outcome is reported, not thrown, specifically so the per-table hydrate
  // below can act on it.
  const seedResult = await seedRegistryFromManifest(registryStore, overlay);
  logSeedResult(seedResult);

  try {
    const [reposFromDb, companionsFromDb] = await Promise.all([
      registryStore.listRepos(),
      registryStore.listCompanions(),
    ]);

    if (seedResult.repos.failed) {
      console.warn(`[registry] repo seed failed validation — running on the manifest's repos until the manifest is fixed (${seedResult.repos.error})`);
    } else {
      replaceRepos(reposFromDb);
    }

    if (seedResult.companions.failed) {
      console.warn(`[registry] companion seed failed validation — running on the manifest's companions until the manifest is fixed (${seedResult.companions.error})`);
    } else {
      replaceCompanions(companionsFromDb);
    }

    console.log(`[registry] hydrated from the database — ${Object.keys(repos).length} repo(s), ${Object.keys(companionRegistry).length} companion(s) active`);
  } catch (err) {
    console.warn(`[registry] failed to hydrate from the database — continuing with the manifest-only registry (${errorMessage(err)})`);
  }
}

function logSeedResult(seedResult: { repos: TableSeedResult; companions: TableSeedResult }): void {
  const seeded: string[] = [];
  if (seedResult.repos.seeded > 0) seeded.push(`${seedResult.repos.seeded} repo(s)`);
  if (seedResult.companions.seeded > 0) seeded.push(`${seedResult.companions.seeded} companion(s)`);
  if (seeded.length > 0) console.log(`[registry] seeded ${seeded.join(' and ')} from the manifest`);
}

/**
 * A connection failure from `postgres` surfaces as a Node `AggregateError`
 * (one nested error per address the driver tried, e.g. IPv6 then IPv4) whose
 * own `.message` is an EMPTY STRING — `err.message` alone renders a warning
 * as "(...)" with nothing inside the parentheses, useless for whoever reads
 * the startup log. The actual reason lives in `.errors[]` (or, for a single
 * plain error, directly on `.code`).
 *
 * Exported so other one-shot database-optional callers (e.g.
 * `scripts/resolve-companions.ts`, which hits this same connection path
 * before the CLI's own startup hydration even runs) get the same readable
 * message instead of re-deriving it.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const nested = (err as { errors?: unknown[] } | undefined)?.errors;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.map((e) => (e instanceof Error && e.message) || String(e)).join('; ');
  }
  const code = (err as { code?: string } | undefined)?.code;
  if (code) return code;
  return String(err);
}
