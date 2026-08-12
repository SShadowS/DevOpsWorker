import { describe, test, expect, afterEach, beforeAll, beforeEach } from 'bun:test';
import { resolveConfig } from '../../src/cli/run.ts';
import { registerRepos, repos, replaceRepos } from '../../src/config/repos.ts';
import { companionRegistry, replaceCompanions } from '../../src/config/companions.ts';
import { hydrateRegistryBestEffort } from '../../src/config/hydrate.ts';
import type { RepoConfig, RepoRegistry } from '../../src/config/repo-config.ts';
import type { CompanionRegistry } from '../../src/config/registry-store.interface.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';
import { FakeRegistryStore } from '../config/fixtures/fake-registry-store.ts';

// The public core ships an empty repo registry; concrete repos arrive from the
// private overlay at startup. Register a neutral fixture so resolveConfig has a
// repo to resolve via REPO_CONFIG (no proprietary data).
const fixture: RepoConfig = {
  active: true,
  url: 'https://example.com/sample.git',
  branch: 'master',
  azureDevOps: {
    project: 'Sample Project',
    repositoryId: 'sample-id',
    repositoryName: 'Sample Repo',
    areaPath: 'Sample Project\\Sample Area',
  },
  repoKey: 'SampleRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud', testAppRoot: 'Test', test: 'Test/Src' },
};

beforeAll(() => {
  registerRepos({ 'sample-repo': fixture });
});

describe('resolveConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('uses buildConfigFromRepo when REPO_CONFIG is set', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = await resolveConfig(undefined);
    expect(config.azureDevOps.project).toBe('Sample Project');
    expect(config.paths.sessionRoot).toBe('/workspace/session');
    expect(config.paths.targetRepo).toBe('/workspace/session/SampleRepo');
    expect(repo).toBeDefined();
    expect(repo!.azureDevOps.repositoryName).toBe('Sample Repo');
  });

  test('respects SESSION_ROOT env var in container mode', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['SESSION_ROOT'] = '/custom/session';

    const { config } = await resolveConfig(undefined);
    expect(config.paths.sessionRoot).toBe('/custom/session');
    expect(config.paths.targetRepo).toBe('/custom/session/SampleRepo');
  });

  test('falls back to loadConfig when --session is provided', async () => {
    delete process.env['REPO_CONFIG'];
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = await resolveConfig('/tmp/test-session');
    expect(config.paths.sessionRoot).toBe('/tmp/test-session');
    expect(repo).toBeUndefined();
  });

  test('throws when neither REPO_CONFIG nor --session provided', async () => {
    delete process.env['REPO_CONFIG'];
    await expect(resolveConfig(undefined)).rejects.toThrow(
      'Either REPO_CONFIG env var (container mode) or --session flag (local mode) is required',
    );
  });

  test('REPO_CONFIG takes precedence over --session', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = await resolveConfig('/tmp/ignored-session');
    // Should use repo config, not session path
    expect(repo).toBeDefined();
    expect(config.paths.sessionRoot).toBe('/workspace/session');
    expect(config.paths.targetRepo).toBe('/workspace/session/SampleRepo');
  });

  test('throws for unknown REPO_CONFIG key', async () => {
    process.env['REPO_CONFIG'] = 'nonexistent-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    await expect(resolveConfig(undefined)).rejects.toThrow('Unknown repo key "nonexistent-repo"');
  });
});

// ---------------------------------------------------------------------------
// resolveConfig — settings parity with the resumed path (loadConfigFromState).
// This is the gap Task 8's own review caught: a FRESH run went through
// resolveConfig with no settings at all, while a RESUMED run went through
// loadConfigFromState -> buildCurrentConfig and picked up the database. The
// same work item ran with different configuration before and after a resume.
// ---------------------------------------------------------------------------

function fakeSettingsStore(overrides: Record<string, unknown> = {}, opts: { rejects?: boolean } = {}): ISettingsStore {
  return {
    async getAll() {
      if (opts.rejects) throw new Error('settings table unreachable (fake)');
      return { ...overrides };
    },
    async get<T>(key: string) {
      return (key in overrides ? overrides[key] : null) as T | null;
    },
    async set() {},
    async delete() {},
  };
}

describe('resolveConfig — fresh-start settings parity', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('container mode (buildConfigFromRepo): a database models.default beats the environment variable', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['DEFAULT_MODEL'] = 'env-model';

    const { config } = await resolveConfig(undefined, fakeSettingsStore({ 'models.default': 'db-model' }));
    expect(config.models.default).toBe('db-model');
  });

  test('container mode: no settingsStore falls back to the environment variable — unchanged from before this parameter existed', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['DEFAULT_MODEL'] = 'env-model';

    const { config } = await resolveConfig(undefined);
    expect(config.models.default).toBe('env-model');
  });

  test('session mode (loadConfig): a database models.default beats the environment variable', async () => {
    delete process.env['REPO_CONFIG'];
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['DEFAULT_MODEL'] = 'env-model';

    const { config } = await resolveConfig('/tmp/test-session', fakeSettingsStore({ 'models.default': 'db-model' }));
    expect(config.models.default).toBe('db-model');
  });

  test('session mode: an unreachable settings store falls back to the environment variable rather than throwing', async () => {
    delete process.env['REPO_CONFIG'];
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['DEFAULT_MODEL'] = 'env-model';

    const { config } = await resolveConfig('/tmp/test-session', fakeSettingsStore({}, { rejects: true }));
    expect(config.models.default).toBe('env-model');
  });
});

// ---------------------------------------------------------------------------
// Finding I-1 regression: a container that lost the startup-hydration race
// (index.ts's small 2×500ms budget) must still see an admin's database edit
// once ITS OWN connectStores() call — a much larger retry budget — succeeds.
// `run()` now calls `hydrateRegistryBestEffort(registryStore)` right after
// that connect, before `resolveConfig` runs. This proves the read
// `resolveConfig` performs (via `getRepoConfig`, container mode) sees the
// database's version, not whatever the manifest/startup hydration left
// behind — the exact gap the final review named.
// ---------------------------------------------------------------------------

describe('container-mode resolve after a failed-then-recovered hydration (Finding I-1)', () => {
  const originalEnv = { ...process.env };
  let repoSnapshot: RepoRegistry;
  let companionSnapshot: CompanionRegistry;

  beforeEach(() => {
    // `hydrateRegistryBestEffort` (via `hydrateRegistryFromDb`) replaces BOTH
    // registries, removing every key not in the store it reads — snapshot
    // and restore both, so this test can't affect any other file's repos OR
    // companions, regardless of run order (same convention as hydrate.test.ts
    // and hydrate-startup.test.ts).
    repoSnapshot = { ...repos };
    companionSnapshot = { ...companionRegistry };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    replaceRepos(repoSnapshot);
    replaceCompanions(companionSnapshot);
  });

  test('sees the database repo, not the manifest one, after hydrateRegistryBestEffort runs', async () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    // Before any recovery: only the manifest's registration (from this
    // file's top-level beforeAll) is in `repos` — standing in for a
    // container whose own startup hydration lost the race and never ran.
    const { config: beforeRecovery } = await resolveConfig(undefined);
    expect(beforeRecovery.azureDevOps.areaPath).toBe(fixture.azureDevOps.areaPath);

    // An admin edited this repo in the database while this (hypothetical)
    // container was still starting up.
    const editedRepo: RepoConfig = {
      ...fixture,
      azureDevOps: { ...fixture.azureDevOps, areaPath: 'Edited Project\\New Area' },
    };
    const store = new FakeRegistryStore();
    store.seedRawRepo('sample-repo', editedRepo);

    // This is what `run()` now does right after its own connectStores() call
    // succeeds — the "later, larger-budget connection" winning the race.
    await hydrateRegistryBestEffort(store);

    const { config: afterRecovery } = await resolveConfig(undefined);
    expect(afterRecovery.azureDevOps.areaPath).toBe('Edited Project\\New Area');
  });
});
