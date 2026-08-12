import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { parseArgs, hydrateFromDbBestEffort, restoreCoreCompanionDefaults } from '../../scripts/resolve-companions.ts';
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
    expect(Object.keys(companionRegistry)).toEqual(['DbComp']);
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

// ---------------------------------------------------------------------------
// The second regression this file guards against.
//
// The public core's "BC" companion (Microsoft's code-history mirror) is
// registered as a hardcoded default in companions.ts, not seeded from the
// overlay manifest into the database — `seedRegistryFromManifest` only ever
// seeds the OVERLAY's own companions. `hydrateRegistryBestEffort` REPLACES
// the live registry with exactly the database's rows (correct: a companion
// deleted from the database must disappear), so on a database that is
// reachable, "BC" vanishes from `companionRegistry` the instant hydration
// succeeds — unless something restores it. Confirmed against a real, live
// deployment's database, where every registered repo referenced "BC" as a
// companion: without this restore, wiring the database into
// resolve-companions.ts would turn every container's companion-resolution
// step for such a repo from a silent staleness bug into an immediate
// "Unknown companion "BC"" crash.
// ---------------------------------------------------------------------------
describe('restoreCoreCompanionDefaults', () => {
  test('restores a core default the database hydration replaced away', () => {
    const before = { BC: companionRegistry['BC'] ?? mkCompanion({ url: 'https://example.invalid/bc.git' }) };
    replaceCompanions({ DbComp: mkCompanion() }); // simulates hydrateRegistryBestEffort's REPLACE dropping BC

    restoreCoreCompanionDefaults(before);

    expect(companionRegistry['BC']).toEqual(before['BC']);
    expect(companionRegistry['DbComp']).toBeDefined(); // the database's own companion is untouched
  });

  test('never overwrites a companion the database DID supply — the database still wins there', () => {
    const staleCore = { Shared: mkCompanion({ url: 'https://example.invalid/stale.git' }) };
    const fresh = mkCompanion({ url: 'https://example.invalid/fresh.git' });
    replaceCompanions({ Shared: fresh });

    restoreCoreCompanionDefaults(staleCore);

    expect(companionRegistry['Shared']).toEqual(fresh);
  });

  test('no-op when nothing is missing', () => {
    replaceCompanions({ BC: mkCompanion() });
    const before = { BC: companionRegistry['BC']! };

    restoreCoreCompanionDefaults(before);

    expect(Object.keys(companionRegistry)).toEqual(['BC']);
  });
});
