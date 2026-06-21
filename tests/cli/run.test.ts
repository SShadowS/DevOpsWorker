import { describe, test, expect, afterEach, beforeAll } from 'bun:test';
import { resolveConfig } from '../../src/cli/run.ts';
import { registerRepos } from '../../src/config/repos.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

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

  test('uses buildConfigFromRepo when REPO_CONFIG is set', () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = resolveConfig(undefined);
    expect(config.azureDevOps.project).toBe('Sample Project');
    expect(config.paths.sessionRoot).toBe('/workspace/session');
    expect(config.paths.targetRepo).toBe('/workspace/session/SampleRepo');
    expect(repo).toBeDefined();
    expect(repo!.azureDevOps.repositoryName).toBe('Sample Repo');
  });

  test('respects SESSION_ROOT env var in container mode', () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';
    process.env['SESSION_ROOT'] = '/custom/session';

    const { config } = resolveConfig(undefined);
    expect(config.paths.sessionRoot).toBe('/custom/session');
    expect(config.paths.targetRepo).toBe('/custom/session/SampleRepo');
  });

  test('falls back to loadConfig when --session is provided', () => {
    delete process.env['REPO_CONFIG'];
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = resolveConfig('/tmp/test-session');
    expect(config.paths.sessionRoot).toBe('/tmp/test-session');
    expect(repo).toBeUndefined();
  });

  test('throws when neither REPO_CONFIG nor --session provided', () => {
    delete process.env['REPO_CONFIG'];
    expect(() => resolveConfig(undefined)).toThrow(
      'Either REPO_CONFIG env var (container mode) or --session flag (local mode) is required',
    );
  });

  test('REPO_CONFIG takes precedence over --session', () => {
    process.env['REPO_CONFIG'] = 'sample-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    const { config, repo } = resolveConfig('/tmp/ignored-session');
    // Should use repo config, not session path
    expect(repo).toBeDefined();
    expect(config.paths.sessionRoot).toBe('/workspace/session');
    expect(config.paths.targetRepo).toBe('/workspace/session/SampleRepo');
  });

  test('throws for unknown REPO_CONFIG key', () => {
    process.env['REPO_CONFIG'] = 'nonexistent-repo';
    process.env['AZURE_DEVOPS_PAT'] = 'test-pat';

    expect(() => resolveConfig(undefined)).toThrow('Unknown repo key "nonexistent-repo"');
  });
});
