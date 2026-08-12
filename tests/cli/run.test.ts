import { describe, test, expect, afterEach, beforeAll } from 'bun:test';
import { resolveConfig } from '../../src/cli/run.ts';
import { registerRepos } from '../../src/config/repos.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';

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
