export interface CompanionDef {
  /** HTTPS clone URL (PAT-compatible for Azure DevOps, plain for GitHub) */
  url: string;
  /** Default branch */
  defaultBranch: string;
  /** If true, never branched or modified by the agent. */
  readOnly?: boolean;
  /** If true, staged into the session as a SYMLINK to the cache (zero-copy) rather
   *  than a real local clone. Use ONLY for huge companions that agents never need to
   *  file-search (Grep/Glob skip symlinked dirs) and that are reachable via LSP as a
   *  dependency instead — e.g. the BC code-history mirror. Default (false) gives a
   *  real, searchable directory. */
  symlinkOnly?: boolean;
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
    // Huge code-history mirror + reachable via LSP as a dependency — symlink, don't copy.
    symlinkOnly: true,
  },
};

/**
 * Snapshot of what the core ships IN CODE, taken here — the line right after
 * `companionRegistry`'s own initializer — so it is guaranteed to run before
 * any caller anywhere could possibly have mutated the registry (`registerCompanions`/
 * `replaceCompanions` are exported functions; nothing outside this module can
 * call them before this module finishes evaluating). This is the permanent
 * floor `replaceCompanions` protects: the database is never the source of
 * truth for "BC" (only the overlay's own companions ever get seeded into it —
 * see `seedRegistryFromManifest`), so a database hydration that fully
 * replaces the registry must not be able to make it disappear.
 */
const CORE_COMPANION_DEFAULTS: Readonly<Record<string, CompanionDef>> = { ...companionRegistry };

/**
 * Merge overlay-provided companion definitions into the live registry.
 * Idempotent. Called once per process at startup from the CLI entrypoint.
 *
 * This MERGES and never deletes — see `replaceCompanions` for the database-
 * backed case where a removed row must actually disappear.
 */
export function registerCompanions(extra: Record<string, CompanionDef>): void {
  Object.assign(companionRegistry, extra);
}

/**
 * Replace the live registry with `next`, in place. Unlike `registerCompanions`,
 * this REMOVES every key not present in EITHER `next` or the core's own
 * hardcoded defaults — mirrors `replaceRepos` in `repos.ts` for the same
 * reason: `companionRegistry` is an `export const` every consumer holds a
 * live reference to, so this mutates that object (delete current keys,
 * assign the new ones) instead of reassigning it.
 *
 * Three tiers, in ascending precedence: the core's hardcoded defaults (code,
 * e.g. "BC"), then `next` (whatever the caller is replacing with — the
 * database's rows, in every real caller). `next` wins on a key both define —
 * a database row for "BC" would override the core default, not be shadowed
 * by it — but a core default absent from `next` still survives, because
 * `next` is never a complete picture of "every companion that should exist":
 * only the OVERLAY's own companions ever get seeded into the database
 * (`seedRegistryFromManifest`), so `next` can never contain a core default
 * unless something put it there deliberately. Before this, `next` alone
 * silently dropped every core default the instant a database (or any other
 * caller) supplied its own companions — dormant for years because
 * `getCompanions()` had no caller that ran after a database hydration, until
 * wiring the database into `scripts/resolve-companions.ts` turned it into an
 * immediate "Unknown companion "BC"" crash for every repo that references it.
 */
export function replaceCompanions(next: Record<string, CompanionDef>): void {
  for (const key of Object.keys(companionRegistry)) {
    delete companionRegistry[key];
  }
  Object.assign(companionRegistry, CORE_COMPANION_DEFAULTS, next);
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
): Array<{ name: string; url: string; branch: string; readOnly: boolean; symlinkOnly: boolean }> {
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
        symlinkOnly: def.symlinkOnly ?? false,
      };
    });
}
