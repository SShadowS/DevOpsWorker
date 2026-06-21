import type { RepoConfig, RepoRegistry } from './repo-config.ts';

/**
 * Target repo registry. The public core ships EMPTY — concrete repo registrations
 * (URLs, ADO GUIDs, area paths, pipeline IDs) are proprietary and supplied by the
 * private overlay (`OverlayManifest.repos`) via `registerRepos`, called once at
 * startup in `src/cli/index.ts`. All helpers below read this live object, so
 * entries registered at startup are visible to every consumer.
 */
export const repos: RepoRegistry = {};

/**
 * Merge overlay-provided repo registrations into the live registry.
 * Idempotent (later registration of the same key overwrites). Called once per
 * process at startup from the CLI entrypoint after loading the overlay manifest.
 */
export function registerRepos(extra: RepoRegistry): void {
  Object.assign(repos, extra);
}

/**
 * Look up a repo config by key.
 * Throws if the key is not found.
 */
export function getRepoConfig(repoKey: string, registry: RepoRegistry = repos): RepoConfig {
  const config = registry[repoKey];
  if (!config) {
    throw new Error(
      `Unknown repo key "${repoKey}". Available: ${Object.keys(registry).join(', ')}`,
    );
  }
  return config;
}

/**
 * Find a repo config by Azure DevOps area path.
 * Returns the key and config, or undefined if no match.
 */
export function findRepoByAreaPath(areaPath: string, registry: RepoRegistry = repos): { key: string; config: RepoConfig } | undefined {
  for (const [key, config] of Object.entries(registry)) {
    if (areaPath.startsWith(config.azureDevOps.areaPath)) {
      return { key, config };
    }
  }
  return undefined;
}

/**
 * Find a repo config by its `repoKey` field (e.g., 'YourApp').
 * This differs from the registry key (e.g., 'document-output') used by `getRepoConfig`.
 * `PipelineConfig.repoKey` holds the directory name, so call this when you have a config in hand.
 */
export function findRepoByRepoKey(repoKey: string, registry: RepoRegistry = repos): { key: string; config: RepoConfig } | undefined {
  for (const [key, config] of Object.entries(registry)) {
    if (config.repoKey === repoKey) {
      return { key, config };
    }
  }
  return undefined;
}

/**
 * Find a repo config by Azure DevOps repository ID (GUID).
 * Used by the webhook server to match incoming PR events to known repos.
 */
export function findRepoByRepositoryId(repositoryId: string, registry: RepoRegistry = repos): { key: string; config: RepoConfig } | undefined {
  for (const [key, config] of Object.entries(registry)) {
    if (config.azureDevOps.repositoryId === repositoryId) {
      return { key, config };
    }
  }
  return undefined;
}

/**
 * Get area paths for all active repos.
 * Used to build WIQL filters so the watcher only queries for work items
 * in repos that are ready for processing.
 */
export function getActiveAreaPaths(registry: RepoRegistry = repos): string[] {
  return Object.values(registry)
    .filter(r => r.active)
    .map(r => r.azureDevOps.areaPath);
}

/**
 * Build a WIQL area path filter clause for active repos.
 * Returns empty string if all repos are active (no filter needed)
 * or if no repos are active (should not query at all).
 */
export function buildAreaPathFilter(registry: RepoRegistry = repos): string {
  const paths = getActiveAreaPaths(registry);
  if (paths.length === 0) return '  AND 1=0'; // no active repos — match nothing
  return paths
    .map(p => `[System.AreaPath] UNDER '${p}'`)
    .join(' OR ');
}
