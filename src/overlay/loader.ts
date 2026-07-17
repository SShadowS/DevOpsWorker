import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OverlayManifest } from './types.ts';

/**
 * Resolve the private overlay directory. Resolution order:
 *   1. explicit `dir` argument (the `--overlay <path>` CLI flag), else
 *   2. `PRIVATE_DIR` env var, else
 *   3. default-probe `<cwd>/private`.
 * Returns the absolute path if the directory exists, otherwise `null`.
 *
 * Default-probe keeps daily local work zero-config; the flag/env exist for
 * containers and non-standard layouts.
 */
export function resolvePrivateDir(dir?: string): string | null {
  const candidate = dir ?? process.env['PRIVATE_DIR'] ?? join(process.cwd(), 'private');
  const abs = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  return existsSync(abs) ? abs : null;
}

let cached: OverlayManifest | null = null;

/**
 * Load the overlay manifest from `<privateDir>/manifest.ts`.
 *
 * Returns an empty manifest (`{}`) when no overlay is installed or the manifest
 * file is absent — so the public core runs unchanged with no overlay. Bun imports
 * TypeScript natively, so no compile step is needed.
 *
 * Result is memoised; pass `{ force: true }` (or call `resetManifestCache()`) to
 * reload, primarily for tests.
 */
export async function loadManifest(opts: { dir?: string; force?: boolean } = {}): Promise<OverlayManifest> {
  if (cached && !opts.force) return cached;

  const privateDir = resolvePrivateDir(opts.dir);
  if (!privateDir) {
    cached = {};
    return cached;
  }

  const manifestPath = join(privateDir, 'manifest.ts');
  if (!existsSync(manifestPath)) {
    cached = {};
    return cached;
  }

  const mod = (await import(pathToFileURL(manifestPath).href)) as { default?: unknown };
  const manifest = mod.default;
  if (manifest == null || typeof manifest !== 'object') {
    throw new Error(
      `Overlay manifest at ${manifestPath} must default-export an OverlayManifest object; ` +
        `got ${manifest === null ? 'null' : typeof manifest}.`,
    );
  }

  cached = manifest as OverlayManifest;
  return cached;
}

/** Clear the memoised manifest. For tests that swap overlay directories. */
export function resetManifestCache(): void {
  cached = null;
}

/**
 * Sync accessor for the memoised manifest. Returns `null` when `loadManifest()`
 * has not resolved yet (cold cache).
 *
 * Safe for synchronous consumers (e.g. `loadConfig`) because CLI entrypoints
 * `await loadManifest()` at startup (`src/cli/index.ts`) before any command
 * runs, so the cache is warm by the time sync code reads it. When cold — some
 * unit tests, or ad-hoc scripts that never call `loadManifest()` — this
 * returns `null` and callers fall through to their own generic defaults; that
 * is expected, not an error.
 */
export function getCachedManifest(): OverlayManifest | null {
  return cached;
}

/**
 * Resolve the overlay asset directory for a named agent:
 * `<privateDir>/agents/<name>`. Returns the absolute path if it exists, else
 * `null` (no overlay assets for this agent). Used by agent-workspace staging to
 * merge proprietary skills/rules/CLAUDE.append on top of the public agent.
 */
export function resolveAgentOverlayDir(name: string, dir?: string): string | null {
  const privateDir = resolvePrivateDir(dir);
  if (!privateDir) return null;
  const agentDir = join(privateDir, 'agents', name);
  return existsSync(agentDir) ? agentDir : null;
}
