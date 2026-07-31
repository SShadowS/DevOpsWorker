import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  classifyContainerOutcome,
  getContainerEnv,
  getPrReviewContainerEnv,
  resolveRepoForWorkItem,
} from '../../../src/cli/watch/container-dispatcher.ts';
import { registerRepos } from '../../../src/config/repos.ts';
import type { RepoConfig } from '../../../src/config/repo-config.ts';
import type { PipelineConfig, PipelineState } from '../../../src/types/pipeline.types.ts';

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
// classifyContainerOutcome — exit code + persisted state → what actually happened
// ---------------------------------------------------------------------------

function stateWith(partial: Partial<PipelineState>): PipelineState {
  return { currentStage: 'checkpoint:plan-approved', ...partial } as PipelineState;
}

const checkpointState = stateWith({
  checkpoint: { name: 'plan-approved', enteredAt: '2026-07-25T20:57:00Z' },
});

const completedState = stateWith({ completedAt: '2026-07-25T20:57:00Z' });

const erroredState = stateWith({
  error: {
    type: 'AgentExecutionError',
    stage: 'coder',
    message: 'agent blew up',
    timestamp: '2026-07-25T20:57:00Z',
  },
});

describe('classifyContainerOutcome', () => {
  test('exit 0 with a checkpoint is a checkpoint pause', () => {
    expect(classifyContainerOutcome(0, checkpointState)).toEqual({
      kind: 'checkpoint',
      name: 'plan-approved',
    });
  });

  test('exit 0 with completedAt is a completion', () => {
    expect(classifyContainerOutcome(0, completedState)).toEqual({ kind: 'completed' });
  });

  test('exit 0 with neither is a clean exit', () => {
    expect(classifyContainerOutcome(0, stateWith({}))).toEqual({ kind: 'clean-exit' });
  });

  test('exit 0 with no state at all is a clean exit', () => {
    expect(classifyContainerOutcome(0, null)).toEqual({ kind: 'clean-exit' });
  });

  // The 125 regression: docker's CLI lost its wait-stream to the daemon
  // ("error waiting for container: unexpected EOF") AFTER the pipeline had
  // already paused at a checkpoint. State is the source of truth, not the
  // exit code — 125 is a docker-CLI code, never a pipeline process code.
  test('nonzero exit with a checkpoint and no error is still a checkpoint pause', () => {
    expect(classifyContainerOutcome(125, checkpointState)).toEqual({
      kind: 'checkpoint',
      name: 'plan-approved',
    });
  });

  test('nonzero exit with completedAt and no error is still a completion', () => {
    expect(classifyContainerOutcome(125, completedState)).toEqual({ kind: 'completed' });
  });

  test('nonzero exit with an error in state reports that error, not the exit code', () => {
    expect(classifyContainerOutcome(1, erroredState)).toEqual({
      kind: 'error',
      type: 'AgentExecutionError',
      stage: 'coder',
      message: 'agent blew up',
      persistError: false,
    });
  });

  test('a persisted error wins over a stale checkpoint on a nonzero exit', () => {
    const both = stateWith({
      checkpoint: { name: 'plan-approved', enteredAt: '2026-07-25T20:00:00Z' },
      error: {
        type: 'AgentExecutionError',
        stage: 'coder',
        message: 'crashed after the checkpoint',
        timestamp: '2026-07-25T20:57:00Z',
      },
    });
    expect(classifyContainerOutcome(1, both)).toMatchObject({ kind: 'error', stage: 'coder' });
  });

  test('nonzero exit with no checkpoint, no completion and no error is a container error', () => {
    expect(classifyContainerOutcome(125, stateWith({}))).toEqual({
      kind: 'error',
      type: 'container-error',
      stage: 'container',
      message: 'Container exited with code 125',
      persistError: true,
    });
  });

  // Genuine docker-run failure (missing image, bad mount): the container never
  // ran, so no state row exists — this must still escalate.
  test('nonzero exit with no state at all is a container error', () => {
    expect(classifyContainerOutcome(125, null)).toEqual({
      kind: 'error',
      type: 'container-error',
      stage: 'container',
      message: 'Container exited with code 125',
      persistError: false,
    });
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

// ---------------------------------------------------------------------------
// Container env allowlist
//
// The spawned-container env is an allowlist, not a pass-through. A config var
// the container reads but that is not forwarded silently falls back to its
// default — observed in production when a run ignored REVISION_MAX_ATTEMPTS
// entirely because it was never in this list.
// ---------------------------------------------------------------------------

describe('container env allowlist', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test('forwards operational policy vars the container config layer reads', () => {
    process.env['DEFAULT_MODEL'] = 'claude-opus-5';
    process.env['REVISION_MAX_ATTEMPTS'] = '2';

    const env = getContainerEnv();
    expect(env['DEFAULT_MODEL']).toBe('claude-opus-5');
    expect(env['REVISION_MAX_ATTEMPTS']).toBe('2');
  });

  test('pr-review env is a superset of the base env, differing only in credentials', () => {
    process.env['PR_REVIEW_ANTHROPIC_API_KEY'] = 'pr-key';
    process.env['REVISION_MAX_ATTEMPTS'] = '3';
    process.env['GIT_USER_NAME'] = 'someone';

    const base = getContainerEnv();
    const pr = getPrReviewContainerEnv();

    // every base key is present — this is what drifted before
    for (const key of Object.keys(base)) {
      expect(Object.keys(pr)).toContain(key);
    }
    expect(pr['REVISION_MAX_ATTEMPTS']).toBe('3');
    expect(pr['GIT_USER_NAME']).toBe('someone');

    // only the credential fields differ
    expect(pr['ANTHROPIC_API_KEY']).toBe('pr-key');
    expect(pr['CLAUDE_CODE_OAUTH_TOKEN']).toBe('');
  });

  test('falls back to the base env when no PR-review key is set', () => {
    delete process.env['PR_REVIEW_ANTHROPIC_API_KEY'];
    expect(getPrReviewContainerEnv()).toEqual(getContainerEnv());
  });

  test('forwards PR_REVIEW_AGENT_SET into the container env', () => {
    process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator';
    const env = getPrReviewContainerEnv();
    expect(env['PR_REVIEW_AGENT_SET']).toBe('code-review-validator');
  });
});
