import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { repos, replaceRepos, getRepoConfig } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import {
  hydrateRegistryFromDb,
  hydrateRegistryBestEffort,
  refreshRegistryIfStale,
  _resetHydrationState,
} from '../../src/config/hydrate.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry, IRegistryStore } from '../../src/config/registry-store.interface.ts';
import { FakeRegistryStore, mkRepo, mkCompanion } from './fixtures/fake-registry-store.ts';

// `replaceRepos`/`replaceCompanions` mutate the real process-global singletons
// that other test files (repos-registry.test.ts, companions.test.ts) also
// register keys into. Snapshot before each test and restore after, so this
// file's "remove keys absent from the new map" behaviour can never leak into
// another file regardless of bun test's run order.
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

describe('replaceRepos', () => {
  test('the exported object identity is unchanged — every consumer keeps its held reference', () => {
    const before = repos;
    replaceRepos({ x: mkRepo({ repoKey: 'x' }) });
    expect(repos).toBe(before);
  });

  test('adds new keys, updates changed ones, and removes keys absent from the new map', () => {
    replaceRepos({
      keep: mkRepo({ repoKey: 'keep', repositoryId: 'v1' }),
      drop: mkRepo({ repoKey: 'drop' }),
    });
    expect(Object.keys(repos).sort()).toEqual(['drop', 'keep']);

    replaceRepos({
      keep: mkRepo({ repoKey: 'keep', repositoryId: 'v2' }), // updated
      added: mkRepo({ repoKey: 'added' }), // new
      // 'drop' is absent from this map — must disappear.
    });

    expect(Object.keys(repos).sort()).toEqual(['added', 'keep']);
    expect(getRepoConfig('keep').azureDevOps.repositoryId).toBe('v2');
    expect(repos['drop']).toBeUndefined();
  });

  test('replacing with an empty map clears the registry entirely', () => {
    replaceRepos({ solo: mkRepo({ repoKey: 'solo' }) });
    expect(Object.keys(repos)).toEqual(['solo']);

    replaceRepos({});
    expect(Object.keys(repos)).toEqual([]);
  });
});

describe('replaceCompanions', () => {
  test('the exported object identity is unchanged — every consumer keeps its held reference', () => {
    const before = companionRegistry;
    replaceCompanions({ X: mkCompanion() });
    expect(companionRegistry).toBe(before);
  });

  test('adds new keys, updates changed ones, and removes keys absent from the new map', () => {
    replaceCompanions({
      Keep: mkCompanion({ url: 'https://example.invalid/v1.git' }),
      Drop: mkCompanion(),
    });
    expect(Object.keys(companionRegistry).sort()).toEqual(['Drop', 'Keep']);

    replaceCompanions({
      Keep: mkCompanion({ url: 'https://example.invalid/v2.git' }),
      Added: mkCompanion(),
    });

    expect(Object.keys(companionRegistry).sort()).toEqual(['Added', 'Keep']);
    expect(companionRegistry['Keep']?.url).toBe('https://example.invalid/v2.git');
    expect(companionRegistry['Drop']).toBeUndefined();
  });
});

describe('hydrateRegistryFromDb', () => {
  test('populates both registries from the store, replacing whatever was in memory', async () => {
    replaceRepos({ stale: mkRepo({ repoKey: 'stale' }) });
    replaceCompanions({ Stale: mkCompanion() });

    const store = new FakeRegistryStore();
    await store.upsertRepo('repo-a', mkRepo({ repoKey: 'repo-a' }), null);
    await store.upsertCompanion('Comp', mkCompanion(), null);

    await hydrateRegistryFromDb(store);

    expect(Object.keys(repos)).toEqual(['repo-a']);
    expect(Object.keys(companionRegistry)).toEqual(['Comp']);
    expect(getRepoConfig('repo-a').repoKey).toBe('repo-a');
  });
});

// Finding I-1's fix: `run.ts`, `continue.ts`, and `review-pr.ts` call this
// right after their own `connectStores()` succeeds, so a container that lost
// the startup-hydration race (see hydrate-startup.ts) gets a second chance to
// see the database once its own, larger-budget connection comes through.
describe('hydrateRegistryBestEffort', () => {
  test('on success, behaves exactly like hydrateRegistryFromDb', async () => {
    replaceRepos({ stale: mkRepo({ repoKey: 'stale' }) });

    const store = new FakeRegistryStore();
    await store.upsertRepo('from-db', mkRepo({ repoKey: 'from-db' }), null);

    await hydrateRegistryBestEffort(store);

    expect(Object.keys(repos)).toEqual(['from-db']);
  });

  test('on failure, warns and resolves without throwing — the caller keeps its current registry', async () => {
    replaceRepos({ kept: mkRepo({ repoKey: 'kept' }) });

    const store: IRegistryStore = new FakeRegistryStore();
    store.listRepos = () => Promise.reject(new Error('connection lost'));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(hydrateRegistryBestEffort(store)).resolves.toBeUndefined();

      // The failed hydrate never replaced anything — last-known registry stands.
      expect(Object.keys(repos)).toEqual(['kept']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('connection lost');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('refreshRegistryIfStale', () => {
  test('calls the store on the first call', async () => {
    const store = new FakeRegistryStore();
    await store.upsertRepo('first', mkRepo({ repoKey: 'first' }), null);
    const listReposSpy = mock(store.listRepos.bind(store));
    store.listRepos = listReposSpy;

    await refreshRegistryIfStale(store, 5000, () => 1000);

    expect(listReposSpy).toHaveBeenCalledTimes(1);
    expect(repos['first']).toBeDefined();
  });

  test('skips within the TTL', async () => {
    const store = new FakeRegistryStore();
    await store.upsertRepo('first', mkRepo({ repoKey: 'first' }), null);
    const listReposSpy = mock(store.listRepos.bind(store));
    store.listRepos = listReposSpy;

    let t = 1000;
    await refreshRegistryIfStale(store, 5000, () => t); // first call — hydrates
    t = 3000; // 2000ms later, still under the 5000ms TTL
    await refreshRegistryIfStale(store, 5000, () => t); // should skip

    expect(listReposSpy).toHaveBeenCalledTimes(1);
  });

  test('hydrates again once the injected clock passes the TTL', async () => {
    const store = new FakeRegistryStore();
    await store.upsertRepo('first', mkRepo({ repoKey: 'first' }), null);
    const listReposSpy = mock(store.listRepos.bind(store));
    store.listRepos = listReposSpy;

    let t = 1000;
    await refreshRegistryIfStale(store, 5000, () => t); // first call — hydrates
    t = 6001; // just past the 5000ms TTL
    await refreshRegistryIfStale(store, 5000, () => t); // should hydrate again

    expect(listReposSpy).toHaveBeenCalledTimes(2);
  });

  test('defaults to Date.now when no clock is injected', async () => {
    const store = new FakeRegistryStore();
    await store.upsertRepo('first', mkRepo({ repoKey: 'first' }), null);

    await refreshRegistryIfStale(store, 5000);

    expect(repos['first']).toBeDefined();
  });
});
