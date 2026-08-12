import { describe, test, expect } from 'bun:test';
import { seedRegistryFromManifest } from '../../src/config/seed.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { FakeRegistryStore, mkRepo, mkCompanion } from './fixtures/fake-registry-store.ts';

describe('seedRegistryFromManifest', () => {
  test('empty table plus a manifest with two repos seeds both', async () => {
    const store = new FakeRegistryStore();
    const manifest: OverlayManifest = {
      repos: {
        'repo-a': mkRepo({ repoKey: 'repo-a' }),
        'repo-b': mkRepo({ repoKey: 'repo-b' }),
      },
    };

    const result = await seedRegistryFromManifest(store, manifest);

    expect(result.reposSeeded).toBe(2);
    expect(await store.countRepos()).toBe(2);
    expect((await store.getRepo('repo-a'))?.repoKey).toBe('repo-a');
    expect((await store.getRepo('repo-b'))?.repoKey).toBe('repo-b');
  });

  test('a non-empty repo table seeds nothing, even when the manifest differs — the existing row is untouched', async () => {
    const store = new FakeRegistryStore();
    const existing = mkRepo({ repoKey: 'existing', repositoryId: 'existing-id' });
    store.seedRawRepo('existing', existing);

    const manifest: OverlayManifest = {
      repos: {
        'existing': mkRepo({ repoKey: 'existing', repositoryId: 'manifest-would-overwrite' }),
        'repo-b': mkRepo({ repoKey: 'repo-b' }),
      },
    };

    const result = await seedRegistryFromManifest(store, manifest);

    expect(result.reposSeeded).toBe(0);
    expect(await store.countRepos()).toBe(1);
    // Not just "count unchanged" — the pre-existing row's content must be untouched.
    expect(await store.getRepo('existing')).toEqual(existing);
    expect(await store.getRepo('repo-b')).toBeNull();
  });

  test('an empty manifest seeds nothing', async () => {
    const store = new FakeRegistryStore();

    const result = await seedRegistryFromManifest(store, {});

    expect(result.reposSeeded).toBe(0);
    expect(result.companionsSeeded).toBe(0);
    expect(await store.countRepos()).toBe(0);
    expect(await store.countCompanions()).toBe(0);
  });

  test('running the seed twice in a row is a no-op the second time', async () => {
    const store = new FakeRegistryStore();
    const manifest: OverlayManifest = {
      repos: { 'repo-a': mkRepo({ repoKey: 'repo-a' }) },
      companions: { 'Comp': mkCompanion() },
    };

    const first = await seedRegistryFromManifest(store, manifest);
    expect(first).toEqual({ reposSeeded: 1, companionsSeeded: 1 });

    const second = await seedRegistryFromManifest(store, manifest);
    expect(second).toEqual({ reposSeeded: 0, companionsSeeded: 0 });

    expect(await store.countRepos()).toBe(1);
    expect(await store.countCompanions()).toBe(1);
  });

  test('repos seed while companions do not, decided independently', async () => {
    const store = new FakeRegistryStore();
    // Companions table is already non-empty; repos table is empty.
    await store.upsertCompanion('Existing', mkCompanion(), null);

    const manifest: OverlayManifest = {
      repos: { 'repo-a': mkRepo({ repoKey: 'repo-a' }) },
      companions: { 'WouldSeed': mkCompanion({ url: 'https://example.invalid/would-seed.git' }) },
    };

    const result = await seedRegistryFromManifest(store, manifest);

    expect(result.reposSeeded).toBe(1);
    expect(result.companionsSeeded).toBe(0);
    expect(await store.countRepos()).toBe(1);
    expect(await store.countCompanions()).toBe(1);
    expect(await store.getCompanion('WouldSeed')).toBeNull();
  });

  test('companions seed while repos do not, decided independently (the mirror direction)', async () => {
    const store = new FakeRegistryStore();
    // Repos table is already non-empty; companions table is empty.
    await store.upsertRepo('existing', mkRepo({ repoKey: 'existing' }), null);

    const manifest: OverlayManifest = {
      repos: { 'would-seed': mkRepo({ repoKey: 'would-seed' }) },
      companions: { 'Comp': mkCompanion() },
    };

    const result = await seedRegistryFromManifest(store, manifest);

    expect(result.reposSeeded).toBe(0);
    expect(result.companionsSeeded).toBe(1);
    expect(await store.countRepos()).toBe(1);
    expect(await store.countCompanions()).toBe(1);
    expect(await store.getRepo('would-seed')).toBeNull();
    expect(await store.getCompanion('Comp')).not.toBeNull();
  });

  test('a malformed manifest repo entry throws and names the offending key, without half-seeding', async () => {
    const store = new FakeRegistryStore();
    const manifest = {
      repos: {
        'good-repo': mkRepo({ repoKey: 'good-repo' }),
        // Missing required azureDevOps.repositoryId / areaPath.
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
    } as unknown as OverlayManifest;

    await expect(seedRegistryFromManifest(store, manifest)).rejects.toThrow(/bad-repo/);
    // Nothing was inserted — a half-seeded registry is worse than an empty one.
    expect(await store.countRepos()).toBe(0);
  });

  test('a malformed manifest companion entry throws and names the offending key, without half-seeding', async () => {
    const store = new FakeRegistryStore();
    const manifest = {
      companions: {
        'GoodComp': mkCompanion(),
        'BadComp': { defaultBranch: 'main' }, // missing required url
      },
    } as unknown as OverlayManifest;

    await expect(seedRegistryFromManifest(store, manifest)).rejects.toThrow(/BadComp/);
    expect(await store.countCompanions()).toBe(0);
  });

  // Regression test for the coupling bug from review round 1: a malformed repo
  // entry must never block an unrelated, valid companion manifest from seeding.
  // The two tables are attempted to completion independently — the error
  // surfaces the repo failure AND records that the companion still seeded.
  test('a malformed repo entry does NOT prevent a valid, independent companion manifest from seeding', async () => {
    const store = new FakeRegistryStore();
    const manifest = {
      repos: {
        // Missing required azureDevOps.repositoryId / areaPath.
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
      companions: {
        'GoodComp': mkCompanion(),
      },
    } as unknown as OverlayManifest;

    let thrown: Error | undefined;
    try {
      await seedRegistryFromManifest(store, manifest);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/bad-repo/);
    expect(thrown!.message).toMatch(/1 companion/);
    expect(await store.countRepos()).toBe(0);
    expect(await store.countCompanions()).toBe(1);
    expect(await store.getCompanion('GoodComp')).not.toBeNull();
  });

  test('two malformed repo entries in the same manifest are both named in the error, not just the first', async () => {
    const store = new FakeRegistryStore();
    const manifest = {
      repos: {
        'bad-one': { url: 'https://example.invalid/bad1.git', branch: 'main' },
        'bad-two': { url: 'https://example.invalid/bad2.git', branch: 'main' },
      },
    } as unknown as OverlayManifest;

    let thrown: Error | undefined;
    try {
      await seedRegistryFromManifest(store, manifest);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/bad-one/);
    expect(thrown!.message).toMatch(/bad-two/);
    expect(await store.countRepos()).toBe(0);
  });

  test('when both tables have a malformed entry, the error names both tables', async () => {
    const store = new FakeRegistryStore();
    const manifest = {
      repos: {
        'bad-repo': { url: 'https://example.invalid/bad.git', branch: 'main' },
      },
      companions: {
        'BadComp': { defaultBranch: 'main' }, // missing required url
      },
    } as unknown as OverlayManifest;

    let thrown: Error | undefined;
    try {
      await seedRegistryFromManifest(store, manifest);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/bad-repo/);
    expect(thrown!.message).toMatch(/BadComp/);
    expect(await store.countRepos()).toBe(0);
    expect(await store.countCompanions()).toBe(0);
  });
});
