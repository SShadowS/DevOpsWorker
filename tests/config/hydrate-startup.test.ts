import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { hydrateStartupRegistry } from '../../src/config/hydrate-startup.ts';
import { _resetHydrationState } from '../../src/config/hydrate.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { FakeRegistryStore, mkRepo, mkCompanion } from './fixtures/fake-registry-store.ts';

// `hydrateStartupRegistry` mutates the real process-global `repos` /
// `companionRegistry` singletons (via `applyOverlayRegistries` and its own
// per-table `replaceRepos`/`replaceCompanions` calls) — same reason
// `hydrate.test.ts` snapshots and restores them, so this file's assertions
// can never leak into another. It
// also resets the module-level hydration clock in hydrate.ts: this file's
// own calls never read it (hydrateStartupRegistry hydrates directly, not
// through refreshRegistryIfStale), but a full reset here means this file
// never leaves that shared clock in a state some OTHER file's test — one
// that DOES read it — could depend on run order to avoid.
let repoSnapshot: RepoRegistry;
let companionSnapshot: CompanionRegistry;

beforeEach(() => {
  repoSnapshot = { ...repos };
  companionSnapshot = { ...companionRegistry };
  _resetHydrationState();
});

afterEach(() => {
  replaceRepos(repoSnapshot);
  replaceCompanions(companionSnapshot);
});

describe('hydrateStartupRegistry', () => {
  test('the database wins over the manifest for a repo both supply, and contributes a repo the manifest never had', async () => {
    const manifestRepoA = mkRepo({ repoKey: 'repo-a', areaPath: 'Manifest.Path' });
    const dbRepoA = mkRepo({ repoKey: 'repo-a', areaPath: 'Database.Path' });
    const dbRepoB = mkRepo({ repoKey: 'repo-b' });

    const store = new FakeRegistryStore();
    store.seedRawRepo('repo-a', dbRepoA);
    store.seedRawRepo('repo-b', dbRepoB);

    const manifest: OverlayManifest = { repos: { 'repo-a': manifestRepoA } };

    await hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) });

    expect(Object.keys(repos).sort()).toEqual(['repo-a', 'repo-b']);
    expect(repos['repo-a']?.azureDevOps.areaPath).toBe('Database.Path');
    expect(repos['repo-b']?.azureDevOps.areaPath).toBe(dbRepoB.azureDevOps.areaPath);
  });

  test('order matters: seeds an empty database from the manifest, then hydrates the live registry from what was just seeded', async () => {
    const store = new FakeRegistryStore(); // both tables empty
    const manifest: OverlayManifest = { repos: { 'repo-a': mkRepo({ repoKey: 'repo-a' }) } };

    await hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) });

    // Seeded into the (previously empty) database...
    expect(await store.countRepos()).toBe(1);
    // ...and that seed is what the live registry ends up reflecting. A buggy
    // ordering (hydrate-before-seed) would replace the live registry with the
    // still-empty store first, wiping out the manifest's merge, and nothing
    // would re-hydrate it afterward — this assertion catches that.
    expect(repos['repo-a']).toBeDefined();
  });

  test('offline path: a store that cannot be reached leaves the manifest registry intact and does not throw', async () => {
    const manifest: OverlayManifest = { repos: { 'repo-a': mkRepo({ repoKey: 'repo-a' }) } };

    await expect(
      hydrateStartupRegistry(manifest, {
        connectStores: async () => {
          throw new Error('DATABASE_URL environment variable is required');
        },
      }),
    ).resolves.toBeUndefined();

    expect(repos['repo-a']).toBeDefined();
    expect(repos['repo-a']?.repoKey).toBe('repo-a');
  });

  test('a seed failure (e.g. a malformed manifest entry) does not stop hydration from the database', async () => {
    const store = new FakeRegistryStore();
    store.seedRawRepo('good-from-db', mkRepo({ repoKey: 'good-from-db' }));

    const manifest = {
      repos: {
        // Missing required azureDevOps fields — seedRegistryFromManifest rejects this.
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
    } as unknown as OverlayManifest;

    await expect(
      hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) }),
    ).resolves.toBeUndefined();

    // Seeding failed (store already had a row anyway, so it would have been a
    // no-op regardless) but hydration from the database still ran.
    expect(repos['good-from-db']).toBeDefined();
  });

  // Regression test for Finding M-1: on a FRESH (empty) database, one invalid
  // manifest entry must not erase the manifest's OTHER, valid entries. Before
  // this fix, `hydrateStartupRegistry` always replaced the live registry with
  // whatever the (still-empty) database read back — `replaceRepos({})` — even
  // though the seed never wrote anything, wiping out the good entry
  // `applyOverlayRegistries` had already put there. This is exactly what one
  // malformed `docsRepoUrl` field did to the live deployment: every process
  // ran with an EMPTY repo registry, not with nine of ten repos, or even the
  // manifest's ten — with zero.
  test('a seed failure on an EMPTY database leaves the manifest\'s repos in place instead of wiping them to nothing', async () => {
    const store = new FakeRegistryStore(); // repos table starts empty
    const manifest = {
      repos: {
        'good-repo': mkRepo({ repoKey: 'good-repo' }),
        // Missing required azureDevOps fields — fails validation, and (per
        // seedRepos's "validate everything before inserting anything" rule)
        // takes 'good-repo' down with it as far as the DATABASE is concerned.
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
    } as unknown as OverlayManifest;

    await expect(
      hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) }),
    ).resolves.toBeUndefined();

    // Nothing was written to the database — the "no half-seeding" rule holds.
    expect(await store.countRepos()).toBe(0);
    // But the live registry still has the manifest's good entry: the seed
    // failure must not erase what `applyOverlayRegistries` already applied.
    expect(repos['good-repo']).toBeDefined();
    expect(repos['bad-repo']).toBeDefined();
  });

  // Mirror of the above for companions, and proof the two tables are still
  // independent under the fix: a repos-table seed failure must not cause the
  // companions table (which seeded successfully) to be skipped too.
  test('a repos seed failure does not stop a successful, independent companions seed from being reflected live', async () => {
    const store = new FakeRegistryStore(); // both tables start empty
    const manifest = {
      repos: {
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
      companions: {
        'GoodComp': mkCompanion(),
      },
    } as unknown as OverlayManifest;

    await expect(
      hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) }),
    ).resolves.toBeUndefined();

    expect(await store.countRepos()).toBe(0);
    expect(await store.countCompanions()).toBe(1);
    // The companion DID seed, so it comes from the database read, same as
    // the "order matters" test above — not merely surviving from the manifest.
    expect(companionRegistry['GoodComp']).toBeDefined();
  });

  // The exact shape of the real production bug this catches: a deployment's
  // overlay manifest supplies N companions (none of them "BC" — the public
  // core's own hardcoded companion, never present in any overlay manifest).
  // Those N get seeded into an empty database, then hydrated back into the
  // live registry. Before the fix in `replaceCompanions`, that hydrate step
  // REPLACED `companionRegistry` with exactly those N rows, dropping "BC" —
  // this is the `hydrateStartupRegistry` call every real process (watcher,
  // dashboard, webhook-server, and each container's own CLI) makes at
  // startup, and its own "[registry] hydrated from the database — N repo(s),
  // M companion(s) active" log line is the symptom that was silently wrong
  // (confirmed live: it read 6, not 7). The assertion below is the one that
  // would have caught it: the live registry must end up with 7, BC included,
  // not 6.
  test('BC survives a real startup hydration alongside the manifest\'s own companions — the "N companion(s) active" count must include it', async () => {
    const store = new FakeRegistryStore(); // empty database — first run
    const manifest: OverlayManifest = {
      companions: {
        Comp1: mkCompanion({ url: 'https://example.invalid/1.git' }),
        Comp2: mkCompanion({ url: 'https://example.invalid/2.git' }),
        Comp3: mkCompanion({ url: 'https://example.invalid/3.git' }),
        Comp4: mkCompanion({ url: 'https://example.invalid/4.git' }),
        Comp5: mkCompanion({ url: 'https://example.invalid/5.git' }),
        Comp6: mkCompanion({ url: 'https://example.invalid/6.git' }),
      },
    };

    await hydrateStartupRegistry(manifest, { connectStores: async () => ({ registryStore: store }) });

    expect(await store.countCompanions()).toBe(6); // seeded exactly what the manifest supplied — no more
    expect(Object.keys(companionRegistry)).toHaveLength(7); // the 6 seeded + the core's own "BC"
    expect(companionRegistry['BC']).toBeDefined();
  });

  // Regression test: a real `postgres` connection failure (e.g. nothing
  // listening on the configured host/port) surfaces as a Node
  // `AggregateError` whose OWN `.message` is an empty string — confirmed by
  // actually triggering one against an unreachable port, not assumed. Naively
  // logging `err.message` renders "continuing with the manifest-only registry
  // ()", telling whoever reads the startup log nothing. The real reason lives
  // in `.errors[]`, one nested error per address the driver tried.
  test('a connection failure shaped like a real postgres AggregateError logs its actual reason, not an empty message', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const aggregate = new AggregateError(
        [new Error('connect ECONNREFUSED ::1:59999'), new Error('connect ECONNREFUSED 127.0.0.1:59999')],
        '',
      );
      const manifest: OverlayManifest = { repos: { 'repo-a': mkRepo({ repoKey: 'repo-a' }) } };

      await hydrateStartupRegistry(manifest, {
        connectStores: async () => { throw aggregate; },
      });

      const warnedText = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warnedText).toContain('ECONNREFUSED');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
