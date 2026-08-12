import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { parseArgs, hydrateFromDbBestEffort } from '../../scripts/resolve-companions.ts';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import { FakeRegistryStore, mkRepo, mkCompanion } from '../config/fixtures/fake-registry-store.ts';

// `hydrateFromDbBestEffort` mutates the real process-global `repos` /
// `companionRegistry` singletons (same reason hydrate.test.ts and
// hydrate-startup.test.ts snapshot and restore them) — snapshot before each
// test and restore after, so this file's assertions can never leak into
// another file regardless of bun test's run order.
let repoSnapshot: RepoRegistry;
let companionSnapshot: CompanionRegistry;

beforeEach(() => {
  repoSnapshot = { ...repos };
  companionSnapshot = { ...companionRegistry };
});

afterEach(() => {
  replaceRepos(repoSnapshot);
  replaceCompanions(companionSnapshot);
});

// ---------------------------------------------------------------------------
// The regression this guards against.
//
// Once repo/companion registration lives in the database, the ONE consumer
// that never got hydrated from it was docker/entrypoint.sh's pre-CLI resolve
// step — it only ever applied the (frozen) overlay manifest. A repo added or
// edited only in the database either made the entrypoint die with "Unknown
// repo key" or clone the wrong branch/layout while the CLI later in the same
// container resolved the database's version instead. `hydrateFromDbBestEffort`
// is the fix: it MUST behave like `src/config/hydrate-startup.ts`'s own
// startup hydration — database wins on success, manifest-only registry stands
// on any failure, and it must never throw (a database problem here must not
// take down a container that could otherwise still run).
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('first argument is the registry key, no --bc-platform', () => {
    expect(parseArgs(['document-output'])).toEqual({ registryKey: 'document-output', bcPlatform: undefined });
  });

  test('--bc-platform sets the platform version', () => {
    expect(parseArgs(['document-output', '--bc-platform', '28.0.0.0'])).toEqual({
      registryKey: 'document-output',
      bcPlatform: '28.0.0.0',
    });
  });

  test('no arguments — registry key is undefined', () => {
    expect(parseArgs([])).toEqual({ registryKey: undefined, bcPlatform: undefined });
  });
});

describe('hydrateFromDbBestEffort', () => {
  test('on success, the database registry replaces the manifest-only one', async () => {
    replaceRepos({ 'manifest-only': mkRepo({ repoKey: 'manifest-only' }) });
    replaceCompanions({});

    const store = new FakeRegistryStore();
    await store.upsertRepo('from-db', mkRepo({ repoKey: 'from-db' }), null);
    await store.upsertCompanion('DbComp', mkCompanion(), null);

    await hydrateFromDbBestEffort({ connectStores: async () => ({ registryStore: store }) });

    expect(Object.keys(repos)).toEqual(['from-db']);
    // 'BC' is here too even though the database only supplied 'DbComp' — the core's
    // hardcoded companion default survives replaceCompanions's REPLACE (fixed at the
    // source in src/config/companions.ts).
    expect(Object.keys(companionRegistry).sort()).toEqual(['BC', 'DbComp']);
  });

  // This is the exact regression that turned wiring the database into this script into
  // an immediate "Unknown companion "BC"" crash: confirmed live, every repo in a real
  // deployment's registry references "BC" as a companion, and companionRegistry's real
  // module-level default already includes it (unlike the test above, which starts from
  // an explicitly emptied registry). The fix now lives in companions.ts's
  // replaceCompanions, so this is an integration check that THIS script's call path
  // actually benefits from it, not a re-test of the mechanism itself.
  test('the real "BC" companion survives hydration even when the database does not supply it', async () => {
    const store = new FakeRegistryStore();
    await store.upsertCompanion('DbOnlyComp', mkCompanion(), null);

    await hydrateFromDbBestEffort({ connectStores: async () => ({ registryStore: store }) });

    expect(companionRegistry['BC']).toBeDefined();
    expect(companionRegistry['DbOnlyComp']).toBeDefined();
  });

  test('on a connectStores failure (e.g. no DATABASE_URL), resolves without throwing and leaves the manifest registry intact', async () => {
    replaceRepos({ 'manifest-only': mkRepo({ repoKey: 'manifest-only' }) });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        hydrateFromDbBestEffort({
          connectStores: async () => {
            throw new Error('DATABASE_URL environment variable is required');
          },
        }),
      ).resolves.toBeUndefined();

      expect(Object.keys(repos)).toEqual(['manifest-only']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('DATABASE_URL');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // AggregateError regression, mirrored from hydrate-startup.test.ts: a real
  // `postgres` connection failure has an EMPTY `.message` on the AggregateError
  // itself — confirmed there against an actual unreachable port. This script
  // reuses hydrate-startup.ts's `errorMessage()` specifically so it doesn't
  // regress the same "()" empty-warning bug independently.
  test('a connection failure shaped like a real postgres AggregateError logs its actual reason, not an empty message', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aggregate = new AggregateError(
        [new Error('connect ECONNREFUSED 127.0.0.1:59999')],
        '',
      );

      await hydrateFromDbBestEffort({
        connectStores: async () => { throw aggregate; },
      });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('never writes to stdout — the entrypoint pipes stdout straight into jq', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await hydrateFromDbBestEffort({
        connectStores: async () => { throw new Error('unreachable'); },
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

// The "BC" companion regression this file used to guard against locally (a
// script-scoped `restoreCoreCompanionDefaults`) is now fixed at the source —
// see src/config/companions.ts's `replaceCompanions` and
// tests/config/companions.test.ts for the mechanism's own tests, and
// tests/config/hydrate-startup.test.ts for the end-to-end regression test
// matching the real "N companion(s) active" startup log line. This file only
// needed the one integration check above (the "real 'BC' companion survives
// hydration" test) proving this script's own call path benefits from it.
