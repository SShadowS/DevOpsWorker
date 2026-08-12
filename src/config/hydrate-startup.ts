import type { IRegistryStore } from './registry-store.interface.ts';
import type { OverlayManifest } from '../overlay/types.ts';
import { applyOverlayRegistries } from '../overlay/index.ts';
import { seedRegistryFromManifest } from './seed.ts';
import { hydrateRegistryFromDb } from './hydrate.ts';
import { repos } from './repos.ts';
import { companionRegistry } from './companions.ts';

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
 * while the table is still empty) runs BEFORE `hydrateRegistryFromDb`
 * (database → live registry): hydrating first would read an empty table and
 * wipe out the manifest's merge via `replaceRepos`/`replaceCompanions`, and
 * nothing would re-hydrate the live registry once the seed ran afterward.
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

  try {
    const seedResult = await seedRegistryFromManifest(registryStore, overlay);
    if (seedResult.reposSeeded > 0 || seedResult.companionsSeeded > 0) {
      console.log(`[registry] seeded ${seedResult.reposSeeded} repo(s) and ${seedResult.companionsSeeded} companion(s) from the manifest`);
    }
  } catch (err) {
    // A malformed manifest entry and a transient store error land here
    // alike — telling them apart needs the message text, which is already
    // in `err`. Either way, seeding must never block startup: log it and
    // move on to hydration, which reads whatever the database actually
    // holds regardless of how this attempt went. The two tables are seeded
    // independently (see seedRegistryFromManifest's own jsdoc), so a thrown
    // message here may already say one table succeeded despite the other's
    // failure — printing it verbatim keeps that nuance instead of flattening
    // it into a generic "seed failed".
    console.warn(`[registry] manifest seed failed — continuing: ${errorMessage(err)}`);
  }

  try {
    await hydrateRegistryFromDb(registryStore);
    console.log(`[registry] hydrated from the database — ${Object.keys(repos).length} repo(s), ${Object.keys(companionRegistry).length} companion(s) active`);
  } catch (err) {
    console.warn(`[registry] failed to hydrate from the database — continuing with the manifest-only registry (${errorMessage(err)})`);
  }
}

/**
 * A connection failure from `postgres` surfaces as a Node `AggregateError`
 * (one nested error per address the driver tried, e.g. IPv6 then IPv4) whose
 * own `.message` is an EMPTY STRING — `err.message` alone renders a warning
 * as "(...)" with nothing inside the parentheses, useless for whoever reads
 * the startup log. The actual reason lives in `.errors[]` (or, for a single
 * plain error, directly on `.code`).
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const nested = (err as { errors?: unknown[] } | undefined)?.errors;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested.map((e) => (e instanceof Error && e.message) || String(e)).join('; ');
  }
  const code = (err as { code?: string } | undefined)?.code;
  if (code) return code;
  return String(err);
}
