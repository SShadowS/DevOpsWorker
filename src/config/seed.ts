import type { IRegistryStore } from './registry-store.interface.ts';
import type { OverlayManifest } from '../overlay/types.ts';
import { repoConfigSchema, companionConfigSchema } from './schemas.ts';

/** Outcome of attempting to seed ONE table from the manifest. */
export interface TableSeedResult {
  /** Rows inserted from the manifest. 0 covers three different, ordinary
   *  cases — an empty manifest, a table that was already non-empty (seeding
   *  is a no-op past the first run), or a validation failure (see `failed`)
   *  — callers that need to tell those apart must check `failed`, not just
   *  `seeded === 0`. */
  seeded: number;
  /** True only when this table was empty and the manifest's entries for it
   *  failed schema validation. `seedRepos`/`seedCompanions` validate every
   *  entry BEFORE inserting any of them, so `failed: true` always means
   *  nothing was written — the table is still exactly as empty as it was
   *  before this call. */
  failed: boolean;
  /** Present only when `failed` is true; names the offending entries. */
  error?: string;
}

export interface SeedResult {
  repos: TableSeedResult;
  companions: TableSeedResult;
}

/**
 * One-time seed of the repo and companion registries from the overlay manifest.
 *
 * The database is the source of truth, not the manifest: this only fills a
 * table that is still completely empty. Once a single row exists in
 * `repo_registry` (or `companion_registry`), the manifest can never add,
 * remove, or modify anything in that table again — call this on every
 * startup; it is a no-op once either table has been seeded.
 *
 * The two tables are decided, attempted, and reported on INDEPENDENTLY: a
 * malformed repo entry must never prevent a valid companion manifest from
 * seeding (or vice versa), and each table's own success or failure is
 * reported through its own `TableSeedResult`. This function never throws —
 * a malformed manifest entry is data for the caller to act on, not an
 * exception. That matters for `hydrateStartupRegistry`, which needs to know,
 * PER TABLE, whether the seed failed validation so it can leave that one
 * table on the manifest instead of replacing it with an empty database read.
 */
export async function seedRegistryFromManifest(
  store: IRegistryStore,
  manifest: OverlayManifest,
): Promise<SeedResult> {
  return {
    repos: await seedTable(() => seedRepos(store, manifest)),
    companions: await seedTable(() => seedCompanions(store, manifest)),
  };
}

async function seedTable(attempt: () => Promise<number>): Promise<TableSeedResult> {
  try {
    return { seeded: await attempt(), failed: false };
  } catch (error) {
    return { seeded: 0, failed: true, error: errorMessage(error) };
  }
}

async function seedRepos(store: IRegistryStore, manifest: OverlayManifest): Promise<number> {
  const entries = Object.entries(manifest.repos ?? {});
  if (entries.length === 0) return 0;
  if ((await store.countRepos()) !== 0) return 0;

  const invalid: string[] = [];
  for (const [key, config] of entries) {
    const result = repoConfigSchema.safeParse(config);
    if (!result.success) invalid.push(`"${key}" — ${describeIssues(result.error)}`);
  }
  if (invalid.length > 0) {
    throw new Error(`Cannot seed repo registry: invalid manifest entries — ${invalid.join('; ')}`);
  }

  for (const [key, config] of entries) {
    await store.upsertRepo(key, config, null);
  }

  console.log(`[seed] Seeded ${entries.length} repo(s) from the overlay manifest`);
  return entries.length;
}

async function seedCompanions(store: IRegistryStore, manifest: OverlayManifest): Promise<number> {
  const entries = Object.entries(manifest.companions ?? {});
  if (entries.length === 0) return 0;
  if ((await store.countCompanions()) !== 0) return 0;

  const invalid: string[] = [];
  for (const [key, config] of entries) {
    const result = companionConfigSchema.safeParse(config);
    if (!result.success) invalid.push(`"${key}" — ${describeIssues(result.error)}`);
  }
  if (invalid.length > 0) {
    throw new Error(`Cannot seed companion registry: invalid manifest entries — ${invalid.join('; ')}`);
  }

  for (const [key, config] of entries) {
    await store.upsertCompanion(key, config, null);
  }

  console.log(`[seed] Seeded ${entries.length} companion(s) from the overlay manifest`);
  return entries.length;
}

/** Renders zod issues as "path: message" pairs for a thrown error message. */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`).join(', ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
