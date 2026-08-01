import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, buildConfigFromRepo } from '../../src/cli/config.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

/**
 * DEFAULT_MODEL must reach `models.default` on EVERY config path.
 *
 * There are two builders. `buildConfigFromRepo` always honoured the env var;
 * `loadConfig` had a bare `'claude-opus-5'` literal, so the variable was inert on
 * every path through it — including `review-pr.ts`, the PR reviewer.
 *
 * The failure was invisible in the worst way: DEFAULT_MODEL is in the container env
 * allowlist and arrives correctly, so it looked wired. Measured on a spawned
 * container, `process.env.DEFAULT_MODEL` was "claude-opus-4-8" while
 * `models.default` resolved to "claude-opus-5" — a paid A/B run silently compared a
 * model against itself.
 */

const SAVED = process.env['DEFAULT_MODEL'];
beforeEach(() => { delete process.env['DEFAULT_MODEL']; });
afterEach(() => {
  if (SAVED === undefined) delete process.env['DEFAULT_MODEL'];
  else process.env['DEFAULT_MODEL'] = SAVED;
});

const REPO = {
  url: 'https://example.invalid/x',
  branch: 'main',
  repoKey: 'X',
  // `buildConfigFromRepo` reads both of these to derive appPaths — omitting either throws.
  companions: {},
  layout: { appRoot: 'Cloud', testRoot: 'Test' },
  azureDevOps: { organization: 'o', project: 'p', repositoryId: 'r', repositoryName: 'n' },
} as unknown as RepoConfig;

describe('DEFAULT_MODEL reaches models.default', () => {
  test('loadConfig honours it — the path review-pr.ts actually uses', () => {
    process.env['DEFAULT_MODEL'] = 'claude-opus-4-8';
    expect(loadConfig('.').models.default).toBe('claude-opus-4-8');
  });

  test('loadConfig falls back to claude-opus-5 when unset', () => {
    expect(loadConfig('.').models.default).toBe('claude-opus-5');
  });

  test('an EMPTY value falls back rather than being passed through', () => {
    // The container env forwards unset vars as '', and '' is not nullish — `??` here
    // would hand an empty model id to the SDK. This pins `||`.
    process.env['DEFAULT_MODEL'] = '';
    expect(loadConfig('.').models.default).toBe('claude-opus-5');
  });

  test('the two config builders agree — this is the divergence that caused the bug', () => {
    // The root cause was not a typo, it was two builders drifting apart. Assert
    // parity directly so they cannot diverge again silently.
    process.env['DEFAULT_MODEL'] = 'claude-sonnet-5';
    const viaLoad = loadConfig('.').models.default;
    const viaRepo = buildConfigFromRepo(REPO, { ...process.env, AZURE_DEVOPS_PAT: 'x' } as Record<string, string>)
      .models.default;
    expect(viaLoad).toBe('claude-sonnet-5');
    expect(viaLoad).toBe(viaRepo);
  });

  test('perAgent pins still win over the default, so a cheap default cannot silently upgrade coder', () => {
    // resolveAgentKnobs precedence: override -> base.model -> perAgent[name] -> default.
    // A DEFAULT_MODEL change must not disturb agents that are deliberately pinned.
    process.env['DEFAULT_MODEL'] = 'claude-opus-4-8';
    const m = loadConfig('.').models;
    expect(m.perAgent?.['coder']).toBe('claude-sonnet-5');
    expect(m.default).toBe('claude-opus-4-8');
  });
});
