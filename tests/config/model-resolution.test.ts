import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadConfig, buildConfigFromRepo, parseEffort } from '../../src/cli/config.ts';
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

/**
 * DEFAULT_EFFORT — reasoning effort, plumbed the same way as DEFAULT_MODEL.
 *
 * Thinking tokens bill at OUTPUT rates, so effort is a cost lever that KEEPS the
 * model. That matters because switching to a cheaper model was measured to downgrade
 * the review verdict (opus-5: "request changes" 4/4; cheaper models: "needs
 * discussion" 2/2 on the same PR).
 *
 * The parity test is the important one: DEFAULT_MODEL was honoured by one config
 * builder and ignored by the other, leaving a documented control silently inert.
 * Effort must not repeat that.
 */
describe('DEFAULT_EFFORT reaches models.effort', () => {
  const SAVED_E = process.env['DEFAULT_EFFORT'];
  beforeEach(() => { delete process.env['DEFAULT_EFFORT']; });
  afterEach(() => {
    if (SAVED_E === undefined) delete process.env['DEFAULT_EFFORT'];
    else process.env['DEFAULT_EFFORT'] = SAVED_E;
  });

  test('parseEffort accepts every level the SDK defines', () => {
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(parseEffort(lvl)).toBe(lvl as any);
    }
  });

  test('parseEffort is case- and whitespace-tolerant', () => {
    expect(parseEffort('  LOW ')).toBe('low');
  });

  test('unset, blank or unrecognised yields undefined — leaving the SDK default', () => {
    // A typo must be a no-op, never an invalid level handed to the SDK mid-review.
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort('')).toBeUndefined();
    expect(parseEffort('   ')).toBeUndefined();
    expect(parseEffort('lowish')).toBeUndefined();
    expect(parseEffort('none')).toBeUndefined();
  });

  test('loadConfig honours it — the path review-pr.ts uses', () => {
    process.env['DEFAULT_EFFORT'] = 'low';
    expect(loadConfig('.').models.effort).toBe('low');
  });

  test('loadConfig leaves it undefined when unset, so the SDK default stands', () => {
    expect(loadConfig('.').models.effort).toBeUndefined();
  });

  test('both config builders agree — the divergence that made DEFAULT_MODEL inert', () => {
    process.env['DEFAULT_EFFORT'] = 'low';
    const viaLoad = loadConfig('.').models.effort;
    const viaRepo = buildConfigFromRepo(REPO, { ...process.env, AZURE_DEVOPS_PAT: 'x' } as Record<string, string>)
      .models.effort;
    expect(viaLoad).toBe('low');
    expect(viaLoad).toBe(viaRepo);
  });

  test('runAgent forwards effort to the SDK only when set', () => {
    // Source-pinned: the option must be conditionally spread, so an unset effort
    // leaves the SDK default rather than passing an explicit undefined.
    const src = readFileSync(new URL('../../src/sdk/run-agent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/\.\.\.\(context\.config\.models\.effort \? \{ effort: context\.config\.models\.effort \} : \{\}\)/);
  });

  test('DEFAULT_EFFORT is forwarded to spawned containers', () => {
    // A var read inside the container but absent from the allowlist does nothing,
    // silently — the failure mode this project keeps hitting.
    const src = readFileSync(new URL('../../src/cli/watch/container-dispatcher.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/DEFAULT_EFFORT: process\.env\['DEFAULT_EFFORT'\]/);
  });
});
