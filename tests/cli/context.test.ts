import { describe, test, expect, afterEach, mock } from 'bun:test';
import { buildPipelineContext } from '../../src/cli/context.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

  test('downloads description screenshots and points the description at the local files', async () => {
    // The whole reason this runs here: an agent that only gets the attachment
    // URL cannot open it, and stops to ask a human what the picture said.
    const dest = mkdtempSync(join(tmpdir(), 'ctx-images-'));
    const attachment =
      'https://dev.azure.com/test-org/proj/_apis/wit/attachments/74008e0b-31eb-4b98-9602-e930193596b5?fileName=image.png';

    let call = 0;
    globalThis.fetch = mock(() => {
      call += 1;
      // First call is the work item; the rest are attachments.
      return call === 1
        ? Promise.resolve(
            new Response(
              JSON.stringify(
                makeWorkItemApiResponse({ 'System.Description': `<p>See below</p><img src="${attachment}">` }),
              ),
              { status: 200 },
            ),
          )
        : Promise.resolve(
            new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), {
              status: 200,
              headers: { 'content-type': 'image/png' },
            }),
          );
    }) as unknown as typeof fetch;

    const config = makeConfig();
    config.paths.sessionRoot = dest;

    const ctx = await buildPipelineContext(42, config);

    expect(ctx.workItem.images).toHaveLength(1);
    expect(existsSync(ctx.workItem.images![0]!.path)).toBe(true);
    expect(ctx.workItem.description).toContain(ctx.workItem.images![0]!.path);
    expect(ctx.workItem.description).not.toContain('_apis/wit/attachments');

    rmSync(dest, { recursive: true, force: true });
  });

  test('still returns a context when an attachment cannot be downloaded', async () => {
    // This runs before the first agent on every `run` and `continue`. A dead
    // attachment costs the picture, never the pipeline.
    const dest = mkdtempSync(join(tmpdir(), 'ctx-images-'));
    const attachment =
      'https://dev.azure.com/test-org/proj/_apis/wit/attachments/74008e0b-31eb-4b98-9602-e930193596b5?fileName=image.png';

    let call = 0;
    globalThis.fetch = mock(() => {
      call += 1;
      return call === 1
        ? Promise.resolve(
            new Response(
              JSON.stringify(makeWorkItemApiResponse({ 'System.Description': `<img src="${attachment}">` })),
              { status: 200 },
            ),
          )
        : Promise.resolve(new Response('gone', { status: 404, statusText: 'Not Found' }));
    }) as unknown as typeof fetch;

    const config = makeConfig();
    config.paths.sessionRoot = dest;

    const ctx = await buildPipelineContext(42, config);

    expect(ctx.workItem.images).toEqual([]);
    // The URL stays, so the description still says a picture is missing.
    expect(ctx.workItem.description).toContain('_apis/wit/attachments');

    rmSync(dest, { recursive: true, force: true });
  });

  test('leaves images empty when the description has none', async () => {
    mockFetch(makeWorkItemApiResponse({ 'System.Description': '<p>words only</p>' }));

    const ctx = await buildPipelineContext(42, makeConfig());

    expect(ctx.workItem.images).toEqual([]);
    expect(globalThis.fetch as unknown as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
  });

  test('throws AzureDevOpsError on non-ok response', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' })),
    ) as unknown as typeof fetch;

    await expect(buildPipelineContext(42, makeConfig())).rejects.toThrow('404');
  });
});
