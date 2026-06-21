#!/usr/bin/env bun
/**
 * Resolves companion repos for a given REPO_CONFIG registry key.
 * Called by the Docker entrypoint to get companion clone info as JSON.
 *
 * Usage: bun scripts/resolve-companions.ts <registry-key> [--bc-platform <version>]
 * Example: bun scripts/resolve-companions.ts document-output
 *          bun scripts/resolve-companions.ts document-output --bc-platform 28.0.0.0
 *
 * Output: JSON object with repoKey, appRoot, and companions array.
 *  - When --bc-platform is provided AND the BC companion has no explicit branch
 *    override in repos.ts, the BC branch is derived as `w1-${major}`.
 *  - When --bc-platform is omitted, behavior is unchanged from the previous version.
 */
import { getRepoConfig } from '../src/config/repos.ts';
import { getCompanions } from '../src/config/companions.ts';
import { loadManifest, applyOverlayRegistries } from '../src/overlay/index.ts';

// This is a standalone entry point (run by docker/entrypoint.sh), so it must load
// the private overlay itself — the core ships an empty repo/companion registry and
// only populates it from the overlay. Without this, getRepoConfig throws
// "Unknown repo key" because the registry is empty.
applyOverlayRegistries(await loadManifest());

const args = process.argv.slice(2);
const registryKey = args[0];
let bcPlatform: string | undefined;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--bc-platform' && args[i + 1]) {
    bcPlatform = args[++i];
  }
}

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
