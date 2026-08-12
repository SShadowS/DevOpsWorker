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
 * startup; it is a no-op once either table has been seeded. The two tables
 * are decided independently, so one can seed while the other does not.
 */
export async function seedRegistryFromManifest(
  store: IRegistryStore,
  manifest: OverlayManifest,
): Promise<SeedResult> {
  const reposSeeded = await seedRepos(store, manifest);
  const companionsSeeded = await seedCompanions(store, manifest);
  return { reposSeeded, companionsSeeded };
}

async function seedRepos(store: IRegistryStore, manifest: OverlayManifest): Promise<number> {
  const entries = Object.entries(manifest.repos ?? {});
  if (entries.length === 0) return 0;
  if ((await store.countRepos()) !== 0) return 0;

  for (const [key, config] of entries) {
    const result = repoConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`Cannot seed repo registry: manifest repo "${key}" is invalid — ${describeIssues(result.error)}`);
    }
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

  for (const [key, config] of entries) {
    const result = companionConfigSchema.safeParse(config);
    if (!result.success) {
      throw new Error(`Cannot seed companion registry: manifest companion "${key}" is invalid — ${describeIssues(result.error)}`);
    }
  }

  for (const [key, config] of entries) {
    await store.upsertCompanion(key, config, null);
  }

  console.log(`[seed] Seeded ${entries.length} companion(s) from the overlay manifest`);
  return entries.length;
}

/** Renders zod issues as "path: message" pairs for a thrown error message. */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ');
}
