import { describe, test, expect } from 'bun:test';
import {
  repos,
  registerRepos,
  getRepoConfig,
  getActiveAreaPaths,
  buildAreaPathFilter,
  findRepoByRepositoryId,
} from '../../src/config/repos.ts';
import { companionRegistry, registerCompanions } from '../../src/config/companions.ts';
import { applyOverlayRegistries } from '../../src/overlay/index.ts';
import type { RepoConfig, RepoRegistry } from '../../src/config/repo-config.ts';

function mkRepo(over: { areaPath?: string; repositoryId?: string; repoKey?: string; active?: boolean } = {}): RepoConfig {
  return {
    active: over.active,
    url: 'https://example.com/r.git',
    branch: 'master',
    azureDevOps: {
      project: 'P',
      repositoryId: over.repositoryId ?? 'rid',
      repositoryName: 'R',
      areaPath: over.areaPath ?? 'Area\\X',
    },
    repoKey: over.repoKey ?? 'RK',
    companions: {},
    layout: { appRoot: 'Cloud', source: 'Cloud', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

// These exercise the registry helpers against EXPLICIT fixtures (via the optional
// `registry` param), so the empty/silent-failure cases are isolated from the
// process-global registry that other test files mutate.

describe('buildAreaPathFilter — watcher WIQL silent-failure guard', () => {
  test('empty registry → "AND 1=0" (match NOTHING, never accidentally match all)', () => {
    expect(buildAreaPathFilter({})).toBe('  AND 1=0');
  });

  test('repos present but none active → "AND 1=0"', () => {
    const reg: RepoRegistry = {
      a: mkRepo({ active: false, areaPath: 'Area\\A' }),
      b: mkRepo({ active: false, areaPath: 'Area\\B' }),
    };
    expect(getActiveAreaPaths(reg)).toEqual([]);
    expect(buildAreaPathFilter(reg)).toBe('  AND 1=0');
  });

  test('active repos → UNDER clauses for ACTIVE ones only, joined by OR', () => {
    const reg: RepoRegistry = {
      a: mkRepo({ active: true, areaPath: 'Area\\A' }),
      b: mkRepo({ active: false, areaPath: 'Area\\B' }),
      c: mkRepo({ active: true, areaPath: 'Area\\C' }),
    };
    expect(getActiveAreaPaths(reg)).toEqual(['Area\\A', 'Area\\C']);
    const f = buildAreaPathFilter(reg);
    expect(f).toContain("[System.AreaPath] UNDER 'Area\\A'");
    expect(f).toContain("[System.AreaPath] UNDER 'Area\\C'");
    expect(f).toContain(' OR ');
    expect(f).not.toContain('Area\\B');
  });
});

describe('findRepoByRepositoryId — webhook PR match', () => {
  const reg: RepoRegistry = { x: mkRepo({ repositoryId: 'guid-1' }) };

  test('matches a known repository GUID', () => {
    expect(findRepoByRepositoryId('guid-1', reg)?.key).toBe('x');
  });

  test('undefined for an unknown GUID', () => {
    expect(findRepoByRepositoryId('nope', reg)).toBeUndefined();
  });

  test('undefined against an empty registry (no overlay installed)', () => {
    expect(findRepoByRepositoryId('guid-1', {})).toBeUndefined();
  });
});

describe('registerRepos / applyOverlayRegistries — startup chokepoint', () => {
  test('registerRepos is additive and overwrites on key clash', () => {
    registerRepos({ 'reg-test-1': mkRepo({ repositoryId: 'v1' }) });
    expect(getRepoConfig('reg-test-1').azureDevOps.repositoryId).toBe('v1');

    registerRepos({ 'reg-test-1': mkRepo({ repositoryId: 'v2' }) });
    expect(getRepoConfig('reg-test-1').azureDevOps.repositoryId).toBe('v2');
  });

  test('applyOverlayRegistries populates BOTH repos and companions from a manifest', () => {
    applyOverlayRegistries({
      repos: { 'overlay-test-repo': mkRepo({ repositoryId: 'ov', areaPath: 'OV\\Area' }) },
      companions: { 'OverlayComp': { url: 'https://example.com/oc', defaultBranch: 'master', readOnly: true } },
    });
    expect(repos['overlay-test-repo']).toBeDefined();
    expect(getRepoConfig('overlay-test-repo').azureDevOps.repositoryId).toBe('ov');
    expect(companionRegistry['OverlayComp']?.defaultBranch).toBe('master');
  });

  test('applyOverlayRegistries with an empty manifest is a no-op (does not throw)', () => {
    expect(() => applyOverlayRegistries({})).not.toThrow();
  });

  test('registerCompanions is additive and overwrites on key clash', () => {
    registerCompanions({ 'CompTest': { url: 'https://example.com/c1', defaultBranch: 'master', readOnly: true } });
    expect(companionRegistry['CompTest']?.url).toBe('https://example.com/c1');
    registerCompanions({ 'CompTest': { url: 'https://example.com/c2', defaultBranch: 'main', readOnly: false } });
    expect(companionRegistry['CompTest']?.defaultBranch).toBe('main');
  });
});
