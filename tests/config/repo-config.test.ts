import { describe, test, expect, beforeAll } from 'bun:test';
import { getRepoConfig, findRepoByAreaPath, registerRepos } from '../../src/config/repos.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

// The public core ships an empty repo registry; concrete repos arrive from the
// private overlay at startup. These tests exercise the helper LOGIC against a
// neutral fixture registered via registerRepos (no proprietary data).
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

describe('getRepoConfig', () => {
  test('returns config for known repo key', () => {
    const config = getRepoConfig('sample-repo');
    expect(config.branch).toBe('master');
    expect(config.azureDevOps.project).toBe('Sample Project');
  });

  test('throws for unknown repo key', () => {
    expect(() => getRepoConfig('nonexistent')).toThrow('Unknown repo key');
  });
});

describe('findRepoByAreaPath', () => {
  test('matches repo by area path prefix', () => {
    const result = findRepoByAreaPath('Sample Project\\Sample Area\\Sub Area');
    expect(result).toBeDefined();
    expect(result!.key).toBe('sample-repo');
  });

  test('returns exact match', () => {
    const result = findRepoByAreaPath('Sample Project\\Sample Area');
    expect(result).toBeDefined();
    expect(result!.key).toBe('sample-repo');
  });

  test('returns undefined for unknown area path', () => {
    const result = findRepoByAreaPath('Unknown\\Area');
    expect(result).toBeUndefined();
  });
});
