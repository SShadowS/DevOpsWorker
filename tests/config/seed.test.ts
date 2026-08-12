import { describe, test, expect } from 'bun:test';
import { seedRegistryFromManifest } from '../../src/config/seed.ts';
import type { IRegistryStore, CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import type { RepoConfig, RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionDef } from '../../src/config/companions.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';

// In-memory fake implementing the REAL IRegistryStore interface, so a field
// added to the interface without a matching fake method is a compile error
// rather than a silently-passing test.
class FakeRegistryStore implements IRegistryStore {
  private repos = new Map<string, RepoConfig>();
  private companions = new Map<string, CompanionDef>();

  async listRepos(): Promise<RepoRegistry> {
    return Object.fromEntries(this.repos);
  }

  async getRepo(key: string): Promise<RepoConfig | null> {
    return this.repos.get(key) ?? null;
  }

  async upsertRepo(key: string, config: RepoConfig, _actor: string | null): Promise<void> {
    this.repos.set(key, config);
  }

  async deleteRepo(key: string): Promise<void> {
    this.repos.delete(key);
  }

  async countRepos(): Promise<number> {
    return this.repos.size;
  }

  async listCompanions(): Promise<CompanionRegistry> {
    return Object.fromEntries(this.companions);
  }

  async getCompanion(key: string): Promise<CompanionDef | null> {
    return this.companions.get(key) ?? null;
  }

  async upsertCompanion(key: string, config: CompanionDef, _actor: string | null): Promise<void> {
    this.companions.set(key, config);
  }

  async deleteCompanion(key: string): Promise<void> {
    this.companions.delete(key);
  }

  async countCompanions(): Promise<number> {
    return this.companions.size;
  }

  /** Test-only helper — puts a row directly into the fake, bypassing seeding. */
  seedRawRepo(key: string, config: RepoConfig): void {
    this.repos.set(key, config);
  }
}

// Obviously-fake values only — this is the public core.
function mkRepo(over: { repoKey?: string; areaPath?: string; repositoryId?: string } = {}): RepoConfig {
  return {
    url: 'https://example.invalid/repo.git',
    branch: 'main',
    azureDevOps: {
      project: 'Fake Project',
      repositoryId: over.repositoryId ?? '00000000-0000-0000-0000-000000000000',
      repositoryName: 'FakeRepo',
      areaPath: over.areaPath ?? 'Fake.Project\\Area',
    },
    repoKey: over.repoKey ?? 'FakeRepo',
    companions: {},
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

function mkCompanion(over: { url?: string } = {}): CompanionDef {
  return {
    url: over.url ?? 'https://example.invalid/companion.git',
    defaultBranch: 'main',
    readOnly: true,
  };
}

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
});
