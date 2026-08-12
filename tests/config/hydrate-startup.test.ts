import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { hydrateStartupRegistry } from '../../src/config/hydrate-startup.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { FakeRegistryStore, mkRepo } from './fixtures/fake-registry-store.ts';

// `hydrateStartupRegistry` mutates the real process-global `repos` /
// `companionRegistry` singletons (via `applyOverlayRegistries` and
// `hydrateRegistryFromDb`) — same reason `hydrate.test.ts` snapshots and
// restores them, so this file's assertions can never leak into another.
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
