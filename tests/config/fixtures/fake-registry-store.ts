import type { IRegistryStore, CompanionRegistry } from '../../../src/config/registry-store.interface.ts';
import type { RepoConfig, RepoRegistry } from '../../../src/config/repo-config.ts';
import type { CompanionDef } from '../../../src/config/companions.ts';

/**
 * In-memory fake implementing the REAL IRegistryStore interface, so a field
 * added to the interface without a matching fake method is a compile error
 * rather than a silently-passing test. Shared by every test file that needs
 * a store double instead of a real Postgres connection.
 */
export class FakeRegistryStore implements IRegistryStore {
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

/** Obviously-fake values only — this is the public core. */
export function mkRepo(over: { repoKey?: string; areaPath?: string; repositoryId?: string } = {}): RepoConfig {
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

export function mkCompanion(over: { url?: string } = {}): CompanionDef {
  return {
    url: over.url ?? 'https://example.invalid/companion.git',
    defaultBranch: 'main',
    readOnly: true,
  };
}
