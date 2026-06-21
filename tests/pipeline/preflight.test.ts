import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';
import { runPreflightChecks, assertPreflight, setCommandRunner, clearCommandCache } from '../../src/pipeline/preflight.ts';
import { PreflightError } from '../../src/sdk/errors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'o',
      orgUrl: 'u',
      project: 'p',
      repositoryId: 'r',
      repositoryName: 'rn',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'a',
      iterationPath: 'i',
      pat: 'test-pat',
    },
    paths: {
      sessionRoot: '/tmp/session',
      targetRepo: '/tmp/nonexistent',
      stateDir: '/tmp/state',
    },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
    ...overrides,
  } as PipelineConfig;
}

// Track temp dirs for cleanup
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Inject a fast, always-succeeding runner so tests don't spawn real CLIs
  // (az alone is ~5s and blows the per-test timeout). Cache cleared so each
  // test starts fresh. Tests assert on path/PAT logic, not CLI availability.
  clearCommandCache();
  setCommandRunner(() => { /* success: no throw */ });
});

afterEach(() => {
  setCommandRunner(null); // restore real execSync runner
  clearCommandCache();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function findCheck(checks: ReturnType<typeof runPreflightChecks>['checks'], name: string) {
  return checks.find(c => c.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPreflightChecks', () => {
  test('passes when repo path exists with .git and PAT is set', () => {
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const config = baseConfig({ paths: { sessionRoot: '/tmp/session', targetRepo: repoDir, stateDir: '/tmp/state' } });
    const result = runPreflightChecks(config);

    expect(findCheck(result.checks, 'main-repo-exists')?.status).toBe('ok');
    expect(findCheck(result.checks, 'main-repo-git')?.status).toBe('ok');
    expect(findCheck(result.checks, 'ado-pat')?.status).toBe('ok');
    expect(result.passed).toBe(true);
  });

  test('fails when targetRepo path does not exist', () => {
    const config = baseConfig({ paths: { sessionRoot: '/tmp/session', targetRepo: '/tmp/definitely-does-not-exist-xyz', stateDir: '/tmp/state' } });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'main-repo-exists');
    expect(check?.status).toBe('fail');
    expect(result.passed).toBe(false);
  });

  test('fails when targetRepo exists but has no .git', () => {
    const repoDir = makeTempDir();
    // no .git directory

    const config = baseConfig({ paths: { sessionRoot: '/tmp/session', targetRepo: repoDir, stateDir: '/tmp/state' } });
    const result = runPreflightChecks(config);

    expect(findCheck(result.checks, 'main-repo-exists')?.status).toBe('ok');
    const gitCheck = findCheck(result.checks, 'main-repo-git');
    expect(gitCheck?.status).toBe('fail');
    expect(result.passed).toBe(false);
  });

  test('fails when PAT is empty', () => {
    const config = baseConfig({
      azureDevOps: {
        organization: 'o', orgUrl: 'u', project: 'p', repositoryId: 'r', repositoryName: 'rn',
        ciPipelineId: 1, cdPipelineId: 2, areaPath: 'a', iterationPath: 'i',
        pat: '',
      },
    });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'ado-pat');
    expect(check?.status).toBe('fail');
    expect(result.passed).toBe(false);
  });

  test('checks companion repo paths when companions configured (found)', () => {
    const sessionRoot = makeTempDir();
    const companionDir = join(sessionRoot, 'OtherRepo');
    mkdirSync(companionDir);

    const config = baseConfig({
      paths: { sessionRoot, targetRepo: '/tmp/nonexistent', stateDir: '/tmp/state' },
      repoKey: 'DocumentOutput',
      companions: { OtherRepo: { branch: 'main' } },
    });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'companion-otherrepo');
    expect(check?.status).toBe('ok');
  });

  test('warns when companion repo path does not exist', () => {
    const sessionRoot = makeTempDir();
    // no companion dir created

    const config = baseConfig({
      paths: { sessionRoot, targetRepo: '/tmp/nonexistent', stateDir: '/tmp/state' },
      repoKey: 'DocumentOutput',
      companions: { MissingRepo: {} },
    });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'companion-missingrepo');
    expect(check?.status).toBe('warn');
  });

  test('skips companion check for self (repoKey)', () => {
    const sessionRoot = makeTempDir();

    const config = baseConfig({
      paths: { sessionRoot, targetRepo: '/tmp/nonexistent', stateDir: '/tmp/state' },
      repoKey: 'DocumentOutput',
      companions: { DocumentOutput: { branch: 'master' } },
    });
    const result = runPreflightChecks(config);

    const selfCheck = findCheck(result.checks, 'companion-documentoutput');
    expect(selfCheck).toBeUndefined();
  });

  test('checks env CLI when environment config is present (not found = warn)', () => {
    const sessionRoot = makeTempDir();

    const config = baseConfig({
      paths: { sessionRoot, targetRepo: '/tmp/nonexistent', stateDir: '/tmp/state' },
      environment: { envCli: 'tools/env-cli', profileId: 'p', appPaths: [] },
    });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'env-cli');
    expect(check).toBeDefined();
    expect(check?.status).toBe('warn');
  });

  test('env CLI check passes when file exists', () => {
    const sessionRoot = makeTempDir();
    mkdirSync(join(sessionRoot, 'tools'));
    writeFileSync(join(sessionRoot, 'tools', 'env-cli'), '#!/bin/sh\necho ok', { mode: 0o755 });

    const config = baseConfig({
      paths: { sessionRoot, targetRepo: '/tmp/nonexistent', stateDir: '/tmp/state' },
      environment: { envCli: 'tools/env-cli', profileId: 'p', appPaths: [] },
    });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'env-cli');
    expect(check?.status).toBe('ok');
  });

  test('skips env CLI check when no environment config', () => {
    const config = baseConfig({ environment: undefined });
    const result = runPreflightChecks(config);

    const check = findCheck(result.checks, 'env-cli');
    expect(check).toBeUndefined();
  });

  test('memoizes command availability — each CLI spawns once across calls', () => {
    const counts: Record<string, number> = {};
    setCommandRunner((cmd) => { counts[cmd] = (counts[cmd] ?? 0) + 1; });

    const config = baseConfig();
    runPreflightChecks(config);
    runPreflightChecks(config);

    // Two full runs, but each availability command spawned exactly once.
    expect(counts['git --version']).toBe(1);
    expect(counts['az --version']).toBe(1);
    expect(counts['bun --version']).toBe(1);
    expect(counts['npx --version']).toBe(1);
  });

  test('caches failure result too — failing command not re-spawned', () => {
    let calls = 0;
    setCommandRunner(() => { calls++; throw new Error('not found'); });

    const config = baseConfig();
    const first = runPreflightChecks(config);
    const callsAfterFirst = calls;
    const second = runPreflightChecks(config);

    expect(findCheck(first.checks, 'git')?.status).toBe('fail');
    expect(findCheck(second.checks, 'git')?.status).toBe('fail');
    // No additional spawns on the second run.
    expect(calls).toBe(callsAfterFirst);
  });
});

describe('assertPreflight', () => {
  test('throws PreflightError on failure', () => {
    const config = baseConfig({
      paths: { sessionRoot: '/tmp/session', targetRepo: '/tmp/definitely-does-not-exist-xyz', stateDir: '/tmp/state' },
    });

    expect(() => assertPreflight(config)).toThrow(PreflightError);
  });

  test('returns result on success', () => {
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const config = baseConfig({ paths: { sessionRoot: '/tmp/session', targetRepo: repoDir, stateDir: '/tmp/state' } });
    const result = assertPreflight(config);

    expect(result.passed).toBe(true);
    expect(result.checks).toBeArray();
  });
});
