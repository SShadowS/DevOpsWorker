import { describe, test, expect, afterEach, mock } from 'bun:test';
import { buildPipelineContext } from '../../src/cli/context.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function makeConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'TestRepo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Proj\\Area',
      iterationPath: 'Proj\\Iter',
      pat: 'test-pat',
    },
    paths: {
      sessionRoot: '/tmp/session',
      targetRepo: '/tmp/session/doc',
      stateDir: '/tmp/session/state',
    },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 },
      prPublished: { fixCommand: '/fix', timeoutHours: 48 },
      pollIntervalMinutes: 5,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'claude-sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/AL', testAppRoot: 'Test', test: 'Test/AL' },
  };
}

function makeWorkItemApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    fields: {
      'System.Title': 'Fix posting bug',
      'System.WorkItemType': 'Bug',
      'System.State': 'Active',
      'System.AreaPath': 'Proj\\Area',
      'System.IterationPath': 'Proj\\Iter',
      ...overrides,
    },
  };
}

function mockFetch(data: unknown, status = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(data), { status })),
  ) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPipelineContext', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns context with correct workItemId and config', async () => {
    mockFetch(makeWorkItemApiResponse());
    const config = makeConfig();

    const ctx = await buildPipelineContext(42, config);

    expect(ctx.workItemId).toBe(42);
    expect(ctx.config).toBe(config);
  });

  test('maps work item fields correctly', async () => {
    mockFetch(makeWorkItemApiResponse());

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItem.id).toBe(42);
    expect(ctx.workItem.title).toBe('Fix posting bug');
    expect(ctx.workItem.type).toBe('Bug');
    expect(ctx.workItem.state).toBe('Active');
    expect(ctx.workItem.areaPath).toBe('Proj\\Area');
    expect(ctx.workItem.iterationPath).toBe('Proj\\Iter');
  });

  test('sets workItemType from work item type field', async () => {
    mockFetch(makeWorkItemApiResponse({ 'System.WorkItemType': 'Bug' }));

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItemType).toBe('Bug');
  });

  test('sets workItemType for User Story', async () => {
    mockFetch(makeWorkItemApiResponse({ 'System.WorkItemType': 'User Story' }));

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItemType).toBe('User Story');
  });

  test('calls fetch with correct Azure DevOps URL', async () => {
    mockFetch(makeWorkItemApiResponse());
    const config = makeConfig();

    await buildPipelineContext(42, config);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('https://dev.azure.com/test-org');
    expect(url).toContain('wit/workitems/42');
  });

  test('includes Authorization header with encoded PAT', async () => {
    mockFetch(makeWorkItemApiResponse());
    const config = makeConfig();

    await buildPipelineContext(42, config);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from(':test-pat').toString('base64')}`;
    expect(headers['Authorization']).toBe(expectedAuth);
  });

  test('handles work item with tags', async () => {
    mockFetch(makeWorkItemApiResponse({ 'System.Tags': 'analyse; plan-approved' }));

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItem.tags).toEqual(['analyse', 'plan-approved']);
  });

  test('handles work item with no tags', async () => {
    mockFetch(makeWorkItemApiResponse({ 'System.Tags': '' }));

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItem.tags).toEqual([]);
  });

  test('throws AzureDevOpsError on non-ok response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' })),
    ) as unknown as typeof fetch;

    await expect(buildPipelineContext(42, makeConfig())).rejects.toThrow('404');
  });
});
