import type { IRegistryStore } from './registry-store.interface.ts';
import type { OverlayManifest } from '../overlay/types.ts';
import { repoConfigSchema, companionConfigSchema } from './schemas.ts';

export interface SeedResult {
  reposSeeded: number;
  companionsSeeded: number;
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
 * seeding (or vice versa). Both are always attempted to completion; if either
 * fails validation, the other's outcome — success or failure — stands on its
 * own. Failures are collected and thrown together, naming every table that
 * failed and every invalid entry within it, plus a note of what did seed
 * successfully despite the failure (there is no other way to surface a
 * partial success once an error is thrown).
 */
export async function seedRegistryFromManifest(
  store: IRegistryStore,
  manifest: OverlayManifest,
): Promise<SeedResult> {
  let reposSeeded = 0;
  let companionsSeeded = 0;
  const failures: string[] = [];

  try {
    reposSeeded = await seedRepos(store, manifest);
  } catch (error) {
    failures.push(`repos — ${errorMessage(error)}`);
  }

  try {
    companionsSeeded = await seedCompanions(store, manifest);
  } catch (error) {
    failures.push(`companions — ${errorMessage(error)}`);
  }

  if (failures.length > 0) {
    const seeded: string[] = [];
    if (reposSeeded > 0) seeded.push(`${reposSeeded} repo(s)`);
    if (companionsSeeded > 0) seeded.push(`${companionsSeeded} companion(s)`);
    const seededNote = seeded.length > 0 ? ` Seeded successfully despite this: ${seeded.join(', ')}.` : '';
    throw new Error(`Registry seeding failed — ${failures.join(' | ')}.${seededNote}`);
  }

  return { reposSeeded, companionsSeeded };
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
