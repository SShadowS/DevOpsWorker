import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  getContainerEnv,
  getPrReviewContainerEnv,
  resolveRepoForWorkItem,
} from '../../../src/cli/watch/container-dispatcher.ts';
import { registerRepos } from '../../../src/config/repos.ts';
import type { RepoConfig } from '../../../src/config/repo-config.ts';
import type { PipelineConfig } from '../../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_AREA = 'ContainerDispatcherFixture\\Area';

const fixtureRepo: RepoConfig = {
  active: true,
  url: 'https://example.com/container-dispatcher-fixture.git',
  branch: 'main',
  azureDevOps: {
    project: 'Fixture Project',
    repositoryId: 'fixture-id',
    repositoryName: 'Fixture Repo',
    areaPath: FIXTURE_AREA,
  },
  repoKey: 'FixtureRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

// Registered once for the whole file — a distinct, unlikely-to-collide area
// path so this doesn't interfere with other test files' registry fixtures
// (the live `repos` singleton is shared process-wide; see repos-registry.test.ts).
beforeAll(() => {
  registerRepos({ 'container-dispatcher-fixture': fixtureRepo });
});

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Fixture Project',
      repositoryId: 'fixture-id',
      repositoryName: 'Fixture Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: FIXTURE_AREA,
      iterationPath: 'Test',
      pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'FixtureRepo',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

/** A minimal Azure DevOps "get work item" response, shaped like fetchWorkItem expects. */
function workItemResponse(areaPath: string): Response {
  return new Response(JSON.stringify({
    id: 42,
    fields: {
      'System.Title': 'Test item',
      'System.WorkItemType': 'Task',
      'System.State': 'Active',
      'System.AreaPath': areaPath,
      'System.IterationPath': 'Test',
    },
  }));
}

// ---------------------------------------------------------------------------
// getContainerEnv / getPrReviewContainerEnv — pure env-map builders
// ---------------------------------------------------------------------------

describe('getContainerEnv', () => {
  const keys = [
    'AZURE_DEVOPS_PAT', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ENV_API_TOKEN',
    'DATABASE_URL', 'DISCORD_WEBHOOK_URL', 'PR_REVIEW_NO_POST', 'GIT_USER_NAME', 'GIT_USER_EMAIL',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  test('reads every field straight from process.env', () => {
    process.env['AZURE_DEVOPS_PAT'] = 'pat-1';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-1';
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-1';
    process.env['GIT_USER_NAME'] = 'AI Bot';
    process.env['GIT_USER_EMAIL'] = 'ai@example.com';

    const env = getContainerEnv();
    expect(env['AZURE_DEVOPS_PAT']).toBe('pat-1');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-1');
    expect(env['ANTHROPIC_API_KEY']).toBe('anthropic-1');
    expect(env['GIT_USER_NAME']).toBe('AI Bot');
    expect(env['GIT_USER_EMAIL']).toBe('ai@example.com');
  });

  test('defaults every field to empty string when unset', () => {
    for (const k of keys) delete process.env[k];
    const env = getContainerEnv();
    for (const k of keys) expect(env[k]).toBe('');
  });
});

describe('getPrReviewContainerEnv', () => {
  const original = {
    prKey: process.env['PR_REVIEW_ANTHROPIC_API_KEY'],
    oauth: process.env['CLAUDE_CODE_OAUTH_TOKEN'],
    anthropic: process.env['ANTHROPIC_API_KEY'],
    noPost: process.env['PR_REVIEW_NO_POST'],
  };

  afterEach(() => {
    for (const [k, v] of Object.entries({
      PR_REVIEW_ANTHROPIC_API_KEY: original.prKey,
      CLAUDE_CODE_OAUTH_TOKEN: original.oauth,
      ANTHROPIC_API_KEY: original.anthropic,
      PR_REVIEW_NO_POST: original.noPost,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('falls back to getContainerEnv() when PR_REVIEW_ANTHROPIC_API_KEY is unset', () => {
    delete process.env['PR_REVIEW_ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'main-key';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'main-oauth';

    expect(getPrReviewContainerEnv()).toEqual(getContainerEnv());
  });

  test('uses the pay-per-token key and blanks the OAuth token when set', () => {
    process.env['PR_REVIEW_ANTHROPIC_API_KEY'] = 'pr-review-key';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'main-oauth';

    const env = getPrReviewContainerEnv();
    expect(env['ANTHROPIC_API_KEY']).toBe('pr-review-key');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('');
  });

  test('forwards PR_REVIEW_NO_POST when set', () => {
    process.env['PR_REVIEW_NO_POST'] = '1';
    expect(getPrReviewContainerEnv()['PR_REVIEW_NO_POST']).toBe('1');
  });

  test('omits or empties PR_REVIEW_NO_POST when unset', () => {
    delete process.env['PR_REVIEW_NO_POST'];
    const env = getPrReviewContainerEnv();
    expect(env['PR_REVIEW_NO_POST'] ?? '').toBe('');
  });
});

// ---------------------------------------------------------------------------
// resolveRepoForWorkItem — fetchWorkItem → findRepoByAreaPath → throw
// ---------------------------------------------------------------------------

describe('resolveRepoForWorkItem', () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => { savedFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = savedFetch; });

  test('returns the matched repo + areaPath for a known area path', async () => {
    globalThis.fetch = (() => Promise.resolve(workItemResponse(FIXTURE_AREA))) as unknown as typeof fetch;

    const match = await resolveRepoForWorkItem(42, mockConfig());
    expect(match.key).toBe('container-dispatcher-fixture');
    expect(match.config.repoKey).toBe('FixtureRepo');
    expect(match.areaPath).toBe(FIXTURE_AREA);
  });

  test('matches a work item area path that is a sub-path of the registered area', async () => {
    const subPath = `${FIXTURE_AREA}\\SubTeam`;
    globalThis.fetch = (() => Promise.resolve(workItemResponse(subPath))) as unknown as typeof fetch;

    const match = await resolveRepoForWorkItem(42, mockConfig());
    expect(match.key).toBe('container-dispatcher-fixture');
    // The fetched work item's own area path is preserved (not the registry's),
    // so the caller can log the exact matched path.
    expect(match.areaPath).toBe(subPath);
  });

  test('throws a descriptive error when no repo matches the area path', async () => {
    const unknownArea = 'NoSuchRepoRegisteredAnywhere\\Nope';
    globalThis.fetch = (() => Promise.resolve(workItemResponse(unknownArea))) as unknown as typeof fetch;

    await expect(resolveRepoForWorkItem(99, mockConfig())).rejects.toThrow(
      `No repo config found for area path "${unknownArea}" (WI #99)`,
    );
  });
});
