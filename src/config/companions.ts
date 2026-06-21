export interface CompanionDef {
  /** HTTPS clone URL (PAT-compatible for Azure DevOps, plain for GitHub) */
  url: string;
  /** Default branch */
  defaultBranch: string;
  /** If true, never branched or modified — symlinked from cache */
  readOnly?: boolean;
}

/**
 * Companion repo registry. The public core ships only the public `BC` companion
 * (Microsoft's open BC code-history mirror). Proprietary companion repos (their
 * clone URLs) are supplied by the private overlay (`OverlayManifest.companions`)
 * via `registerCompanions`, called once at startup in `src/cli/index.ts`.
 */
export const companionRegistry: Record<string, CompanionDef> = {
  'BC': {
    url: 'https://github.com/StefanMaron/MSDyn365BC.Code.History.git',
    defaultBranch: 'w1',
    readOnly: true,
  },
};

/**
 * Merge overlay-provided companion definitions into the live registry.
 * Idempotent. Called once per process at startup from the CLI entrypoint.
 */
export function registerCompanions(extra: Record<string, CompanionDef>): void {
  Object.assign(companionRegistry, extra);
}

/** Derive the BC companion git branch from a source app.json platform version.
 *  E.g. "28.0.0.0" → "w1-28". The branch must exist on the BC companion repo;
 *  caller is responsible for clone-failure handling.
 *  Throws if platform is missing/malformed. */
export function bcCompanionBranchForPlatform(platform: string): string {
  const m = platform.match(/^(\d+)\./);
  if (!m) {
    throw new Error(
      `Cannot derive BC companion branch: platform '${platform}' does not start with a major version`,
    );
  }
  return `w1-${m[1]}`;
}

export interface ResolveCompanionsOptions {
  /** Source app.json's `platform` field. When provided AND the BC companion has no
   *  explicit branch override, the resolver derives `w1-${major}` from it. */
  bcPlatform?: string;
}

/**
 * Resolve the companion list for a given repo config.
 * Skips the target repo itself if it appears in companions.
 * Override precedence: explicit `override.branch` > derived (`bcPlatform` for BC) > registry default.
 */
export function getCompanions(
  repoKey: string,
  companions: Record<string, { branch?: string; readOnly?: boolean }>,
  options: ResolveCompanionsOptions = {},
): Array<{ name: string; url: string; branch: string; readOnly: boolean }> {
  return Object.entries(companions)
    .filter(([name]) => name !== repoKey)
    .map(([name, override]) => {
      const def = companionRegistry[name];
      if (!def) throw new Error(`Unknown companion "${name}" — not in companionRegistry`);
      let branch: string;
      if (override.branch) {
        branch = override.branch;
      } else if (name === 'BC' && options.bcPlatform) {
        branch = bcCompanionBranchForPlatform(options.bcPlatform);
      } else {
        branch = def.defaultBranch;
      }
      return {
        name,
        url: def.url,
        branch,
        readOnly: override.readOnly ?? def.readOnly ?? true,
      };
    });
}
