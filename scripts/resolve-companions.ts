#!/usr/bin/env bun
/**
 * Resolves companion repos for a given REPO_CONFIG registry key.
 * Called by the Docker entrypoint to get companion clone info as JSON.
 *
 * Usage: bun scripts/resolve-companions.ts <registry-key> [--bc-platform <version>]
 * Example: bun scripts/resolve-companions.ts document-output
 *          bun scripts/resolve-companions.ts document-output --bc-platform 28.0.0.0
 *
 * Output: JSON object with repoKey, appRoot, and companions array — the ONLY
 * thing this script may write to stdout. `docker/entrypoint.sh` pipes stdout
 * straight into `jq`; any other stdout write breaks the entrypoint. All
 * diagnostics below go to stderr (`console.warn`/`console.error`) instead.
 *  - When --bc-platform is provided AND the BC companion has no explicit branch
 *    override in repos.ts, the BC branch is derived as `w1-${major}`.
 *  - When --bc-platform is omitted, behavior is unchanged from the previous version.
 */
import { getRepoConfig } from '../src/config/repos.ts';
import { getCompanions, companionRegistry, registerCompanions } from '../src/config/companions.ts';
import { loadManifest, applyOverlayRegistries } from '../src/overlay/index.ts';
import { hydrateRegistryBestEffort } from '../src/config/hydrate.ts';
import { connectStores } from '../src/db/connect-stores.ts';
import { disconnectDatabase } from '../src/db/postgres.ts';
import { errorMessage } from '../src/config/hydrate-startup.ts';
import type { HydrateStartupDeps } from '../src/config/hydrate-startup.ts';
import type { CompanionRegistry } from '../src/config/registry-store.interface.ts';

export function parseArgs(argv: string[]): { registryKey: string | undefined; bcPlatform: string | undefined } {
  const registryKey = argv[0];
  let bcPlatform: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--bc-platform' && argv[i + 1]) {
      bcPlatform = argv[++i];
    }
  }
  return { registryKey, bcPlatform };
}

/**
 * Let the database win over the manifest wherever it has its own data —
 * best-effort, and must NEVER throw or hang: this script is the ONE registry
 * consumer that runs BEFORE the CLI's own startup hydration
 * (`src/cli/index.ts`'s `hydrateStartupRegistry`) even exists as a process —
 * the entrypoint calls it to decide which repo/branch to clone, ahead of
 * `bun run src/cli/index.ts`. Without this, a repo added or edited only in
 * the database (the admin API's whole point) either makes the entrypoint die
 * with "Unknown repo key" or clone the wrong (stale manifest) branch/layout
 * while the CLI later in the same container resolves the database's version.
 *
 * `connectStores`' small, fail-fast retry budget matches `src/cli/index.ts`'s
 * own optional startup hydration, and for the same reason: an unreachable
 * database just means "resolve from the manifest", so it should give up in
 * about a second (2 attempts, 500ms apart), not the ~20s budget a command
 * that actually NEEDS the database gets by default (10 attempts, 2s apart).
 *
 * `hydrateRegistryBestEffort` itself never throws (it catches and warns), so
 * the try/catch here is really only for `connectStores()` — no `DATABASE_URL`,
 * an unreachable host, or a connection timeout all land here and fall back to
 * whatever the manifest already put in the registry. The `finally` always
 * closes the connection: `connectDatabase` keeps its pool open across calls
 * (it's a singleton meant for long-running processes), and this is a one-shot
 * script — an open handle would keep it running until Postgres's own
 * `idle_timeout` (30s) closed it, silently stalling the entrypoint that long
 * on every single invocation.
 */
export async function hydrateFromDbBestEffort(
  deps: HydrateStartupDeps = { connectStores: () => connectStores({ maxRetries: 2, retryDelayMs: 500 }) },
): Promise<void> {
  try {
    const { registryStore } = await deps.connectStores();
    await hydrateRegistryBestEffort(registryStore);
  } catch (err) {
    console.warn(`[resolve-companions] database unavailable — resolving from the manifest only (${errorMessage(err)})`);
  } finally {
    await disconnectDatabase();
  }
}

/**
 * Re-merge any companion `hydrateFromDbBestEffort` dropped that isn't managed
 * by the database at all — the public core's built-in "BC" companion (the
 * Microsoft code-history mirror a deployment's repo configs can depend on)
 * being the one that actually exists. `hydrateRegistryBestEffort` REPLACES
 * `companionRegistry` with exactly the database's rows (by design — a
 * companion an operator deletes from the database must disappear, not
 * linger), but only the overlay's OWN companions ever get seeded into that
 * table (`seedRegistryFromManifest` seeds `overlay.companions`, never the
 * core's hardcoded defaults). So a REPLACE silently drops "BC" the moment the
 * database is reachable — dormant everywhere else in the codebase today,
 * because `getCompanions()` (below) has exactly one real caller, but not
 * dormant here: it turns into "Unknown companion "BC"" for every repo that
 * references it, the moment this script resolves one.
 *
 * `before` is a snapshot taken BEFORE the overlay/database touch the
 * registry, so it reflects only what the core module itself registered.
 * Never overwrites a key the database DID supply — the database still wins
 * there — only fills back in a key hydration made vanish entirely.
 */
export function restoreCoreCompanionDefaults(before: CompanionRegistry): void {
  const missing: CompanionRegistry = {};
  for (const [key, def] of Object.entries(before)) {
    if (!(key in companionRegistry)) missing[key] = def;
  }
  if (Object.keys(missing).length > 0) registerCompanions(missing);
}

if (import.meta.main) {
  // Snapshot the core's hardcoded companion defaults before anything else
  // touches the registry — see restoreCoreCompanionDefaults's jsdoc.
  const coreCompanionDefaults = { ...companionRegistry };

  // This is a standalone entry point (run by docker/entrypoint.sh), so it must load
  // the private overlay itself — the core ships an empty repo/companion registry and
  // only populates it from the overlay. Without this, getRepoConfig throws
  // "Unknown repo key" because the registry is empty.
  applyOverlayRegistries(await loadManifest());
  await hydrateFromDbBestEffort();
  restoreCoreCompanionDefaults(coreCompanionDefaults);

  const { registryKey, bcPlatform } = parseArgs(process.argv.slice(2));

  if (!registryKey) {
    console.error(
      'Usage: bun scripts/resolve-companions.ts <registry-key> [--bc-platform <version>]',
    );
    process.exit(1);
  }

  const repo = getRepoConfig(registryKey);
  const companions = getCompanions(repo.repoKey, repo.companions, { bcPlatform });
  console.log(
    JSON.stringify({
      repoKey: repo.repoKey,
      appRoot: repo.layout.appRoot,
      companions,
    }),
  );
}
