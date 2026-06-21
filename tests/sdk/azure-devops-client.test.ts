import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  fetchWorkItem,
  checkWorkItemTag,
  checkPullRequestPublished,
  getPullRequestStatus,
  findRerunCommandInComments,
  findRerunCommandInPRComments,
  postWorkItemComment,
  postPRComment,
  queryWorkItems,
  addWorkItemTags,
  removeWorkItemTags,
  updateWorkItemFields,
  buildPipelineRunUrl,
  fetchWorkItemCommentsSince,
  AzureDevOpsError,
} from '../../src/sdk/azure-devops-client.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
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
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

const originalFetch = globalThis.fetch;
let mockFn: ReturnType<typeof mock>;

function setMockFetch(body: unknown, status = 200, statusText = 'OK') {
  mockFn = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

/** Returns different responses for sequential fetch calls (e.g. GET then PATCH). */
function setSequentialMockFetch(...responses: unknown[]) {
  let callIndex = 0;
  mockFn = mock(() => {
    const body = responses[callIndex] ?? {};
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  globalThis.fetch = mockFn as unknown as typeof fetch;
}

function workItemResponse(tags: string) {
  return {
    id: 42,
    fields: {
      'System.Title': 'Test',
      'System.WorkItemType': 'Bug',
      'System.State': 'Active',
      'System.Tags': tags,
      'System.AreaPath': 'Test',
      'System.IterationPath': 'Test',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('azure-devops-client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('fetchWorkItem', () => {
    test('parses fields correctly', async () => {
      setMockFetch({
        id: 42,
        fields: {
          'System.Title': 'Fix the bug',
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': 'tag1; tag2',
          'System.AreaPath': 'Project\\Area',
          'System.IterationPath': 'Project\\Sprint1',
          'System.AssignedTo': { displayName: 'Alice' },
          'System.Description': '<p>Description here</p>',
          'Microsoft.VSTS.Common.AcceptanceCriteria': 'Must work',
        },
      });

      const wi = await fetchWorkItem(42, mockConfig());

      expect(wi.id).toBe(42);
      expect(wi.title).toBe('Fix the bug');
      expect(wi.type).toBe('Bug');
      expect(wi.state).toBe('Active');
      expect(wi.tags).toEqual(['tag1', 'tag2']);
      expect(wi.assignedTo).toBe('Alice');
      expect(wi.description).toBe('<p>Description here</p>');
      expect(wi.acceptanceCriteria).toBe('Must work');
      expect(wi.areaPath).toBe('Project\\Area');
      expect(wi.iterationPath).toBe('Project\\Sprint1');
    });
  });

  describe('checkWorkItemTag', () => {
    test('case-insensitive match', async () => {
      setMockFetch({
        id: 42,
        fields: {
          'System.Title': 'Test',
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': 'Plan-Approved; other-tag',
          'System.AreaPath': 'Test',
          'System.IterationPath': 'Test',
        },
      });

      const result = await checkWorkItemTag(42, 'plan-approved', mockConfig());
      expect(result).toBe(true);
    });
  });

  describe('checkPullRequestPublished', () => {
    test('returns true when not draft', async () => {
      setMockFetch({ pullRequestId: 100, isDraft: false });
      const result = await checkPullRequestPublished(100, mockConfig());
      expect(result).toBe(true);
    });

    test('returns false when still draft', async () => {
      setMockFetch({ pullRequestId: 100, isDraft: true });
      const result = await checkPullRequestPublished(100, mockConfig());
      expect(result).toBe(false);
    });
  });

  describe('getPullRequestStatus', () => {
    test('returns status and isDraft for active draft PR', async () => {
      setMockFetch({ pullRequestId: 100, isDraft: true, status: 'active' });
      const result = await getPullRequestStatus(100, mockConfig());
      expect(result).toEqual({ status: 'active', isDraft: true });
    });

    test('returns status for completed PR', async () => {
      setMockFetch({ pullRequestId: 100, isDraft: false, status: 'completed' });
      const result = await getPullRequestStatus(100, mockConfig());
      expect(result).toEqual({ status: 'completed', isDraft: false });
    });

    test('returns status for abandoned PR', async () => {
      setMockFetch({ pullRequestId: 100, isDraft: false, status: 'abandoned' });
      const result = await getPullRequestStatus(100, mockConfig());
      expect(result).toEqual({ status: 'abandoned', isDraft: false });
    });

    test('returns null when PR fetch fails', async () => {
      mockFn = mock(() =>
        Promise.resolve(new Response('Not found', { status: 404, statusText: 'Not Found' })),
      );
      globalThis.fetch = mockFn as unknown as typeof fetch;

      const result = await getPullRequestStatus(999, mockConfig());
      expect(result).toBeNull();
    });
  });

  describe('findRerunCommandInComments', () => {
    test('filters by since timestamp', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: 'old /rerun-plan comment', createdDate: '2024-01-01T00:00:00Z' },
          { id: 2, text: '/rerun-plan fix naming', createdDate: '2024-06-01T00:00:00Z' },
        ],
      });

      const result = await findRerunCommandInComments(42, '/rerun-plan', mockConfig(), '2024-03-01T00:00:00Z');
      expect(result).toBe('/rerun-plan fix naming');
    });

    test('returns null when no match', async () => {
      setMockFetch({ comments: [{ id: 1, text: 'no command here', createdDate: '2024-06-01T00:00:00Z' }] });
      const result = await findRerunCommandInComments(42, '/rerun-plan', mockConfig());
      expect(result).toBeNull();
    });

    test('ignores command embedded in instruction text', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: '*To request changes: reply with `/rerun-plan` and your feedback*', createdDate: '2024-06-01T00:00:00Z' },
        ],
      });
      const result = await findRerunCommandInComments(42, '/rerun-plan', mockConfig());
      expect(result).toBeNull();
    });

    test('matches command at start of line', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: '/rerun-plan please revise the naming conventions', createdDate: '2024-06-01T00:00:00Z' },
        ],
      });
      const result = await findRerunCommandInComments(42, '/rerun-plan', mockConfig());
      expect(result).toBe('/rerun-plan please revise the naming conventions');
    });
  });

  describe('fetchWorkItemCommentsSince', () => {
    const since = '2024-03-01T00:00:00Z';

    test('returns human comments after since timestamp', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: 'old comment', createdDate: '2024-01-01T00:00:00Z', createdBy: { displayName: 'Alice', uniqueName: 'alice@test.com' } },
          { id: 2, text: 'Use the helper codeunit for this', createdDate: '2024-06-01T00:00:00Z', createdBy: { displayName: 'Bob', uniqueName: 'bob@test.com' } },
          { id: 3, text: 'Also check the posting routine', createdDate: '2024-07-01T00:00:00Z', createdBy: { displayName: 'Carol', uniqueName: 'carol@test.com' } },
        ],
      });

      const result = await fetchWorkItemCommentsSince(42, since, mockConfig());
      expect(result).toHaveLength(2);
      expect(result[0]!.createdBy!.displayName).toBe('Bob');
      expect(result[1]!.createdBy!.displayName).toBe('Carol');
    });

    test('filters out pipeline-generated comments', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: '<h2>✅ Readiness Assessment — Work Item #42</h2><hr><em>Generated by DevOps Pipeline</em>', createdDate: '2024-06-01T00:00:00Z' },
          { id: 2, text: '<h2>🤖 Dev Plan — Work Item #42</h2><hr><em>Generated by DevOps Pipeline</em>', createdDate: '2024-06-02T00:00:00Z' },
          { id: 3, text: 'This looks good, but use pattern X', createdDate: '2024-06-03T00:00:00Z', createdBy: { displayName: 'Alice', uniqueName: 'alice@test.com' } },
        ],
      });

      const result = await fetchWorkItemCommentsSince(42, since, mockConfig());
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe('This looks good, but use pattern X');
    });

    test('filters out the rerun command comment itself', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: 'Use the helper codeunit', createdDate: '2024-06-01T00:00:00Z', createdBy: { displayName: 'Bob', uniqueName: 'bob@test.com' } },
          { id: 2, text: '/rerun-plan Rethink the approach', createdDate: '2024-06-02T00:00:00Z', createdBy: { displayName: 'Alice', uniqueName: 'alice@test.com' } },
        ],
      });

      const result = await fetchWorkItemCommentsSince(42, since, mockConfig(), '/rerun-plan');
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe('Use the helper codeunit');
    });

    test('returns empty array when no matching comments', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: 'old comment', createdDate: '2024-01-01T00:00:00Z' },
        ],
      });

      const result = await fetchWorkItemCommentsSince(42, since, mockConfig());
      expect(result).toHaveLength(0);
    });

    test('filters out error comments with Recovery Options', async () => {
      setMockFetch({
        comments: [
          { id: 1, text: '<h2>🚨 Pipeline Error — Work Item #42</h2><h3>Recovery Options</h3>', createdDate: '2024-06-01T00:00:00Z' },
          { id: 2, text: 'I think we should try a different approach', createdDate: '2024-06-02T00:00:00Z', createdBy: { displayName: 'Dev', uniqueName: 'dev@test.com' } },
        ],
      });

      const result = await fetchWorkItemCommentsSince(42, since, mockConfig());
      expect(result).toHaveLength(1);
      expect(result[0]!.createdBy!.displayName).toBe('Dev');
    });
  });

  describe('findRerunCommandInPRComments', () => {
    test('searches across threads', async () => {
      setMockFetch({
        value: [
          {
            id: 1,
            publishedDate: '2024-01-01T00:00:00Z',
            comments: [
              { id: 1, content: 'looks good', publishedDate: '2024-01-01T00:00:00Z' },
            ],
          },
          {
            id: 2,
            publishedDate: '2024-06-01T00:00:00Z',
            comments: [
              { id: 2, content: '/fix fix tests', publishedDate: '2024-06-01T00:00:00Z' },
            ],
          },
        ],
      });

      const result = await findRerunCommandInPRComments(100, '/fix', mockConfig());
      expect(result).toBe('/fix fix tests');
    });

    test('skips system comments without content', async () => {
      setMockFetch({
        value: [
          {
            id: 1,
            publishedDate: '2024-01-01T00:00:00Z',
            comments: [
              { id: 1, commentType: 'system', publishedDate: '2024-01-01T00:00:00Z' },
            ],
          },
          {
            id: 2,
            publishedDate: '2024-06-01T00:00:00Z',
            comments: [
              { id: 2, content: '/fix go', commentType: 'text', publishedDate: '2024-06-01T00:00:00Z' },
            ],
          },
        ],
      });

      const result = await findRerunCommandInPRComments(100, '/fix', mockConfig());
      expect(result).toBe('/fix go');
    });
  });

  describe('postWorkItemComment', () => {
    test('sends correct payload', async () => {
      setMockFetch({});

      await postWorkItemComment(42, 'Hello', mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('wit/workItems/42/comments');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({ text: 'Hello' });
    });
  });

  describe('queryWorkItems', () => {
    test('returns work item IDs from WIQL response', async () => {
      setMockFetch({
        workItems: [
          { id: 100, url: 'https://dev.azure.com/test/100' },
          { id: 200, url: 'https://dev.azure.com/test/200' },
          { id: 300 },
        ],
      });

      const ids = await queryWorkItems('SELECT [System.Id] FROM WorkItems', mockConfig());
      expect(ids).toEqual([100, 200, 300]);
    });

    test('returns empty array when no matches', async () => {
      setMockFetch({ workItems: [] });

      const ids = await queryWorkItems('SELECT [System.Id] FROM WorkItems', mockConfig());
      expect(ids).toEqual([]);
    });

    test('sends POST with correct WIQL body', async () => {
      setMockFetch({ workItems: [] });
      const wiql = 'SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS \'analyse\'';

      await queryWorkItems(wiql, mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('wit/wiql');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({ query: wiql });
    });

    test('throws AzureDevOpsError on HTTP error', async () => {
      setMockFetch('Bad request', 400, 'Bad Request');

      await expect(
        queryWorkItems('INVALID', mockConfig()),
      ).rejects.toBeInstanceOf(AzureDevOpsError);
    });
  });

  describe('addWorkItemTags', () => {
    test('merges new tags with existing', async () => {
      setSequentialMockFetch(workItemResponse('existing-tag'), {});

      await addWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(2);
      const [url, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      expect(url).toContain('wit/workitems/42');
      expect(opts.method).toBe('PATCH');
      expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json-patch+json');
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual([
        { op: 'replace', path: '/fields/System.Tags', value: 'existing-tag; need-input' },
      ]);
    });

    test('is idempotent — does not duplicate existing tags', async () => {
      setSequentialMockFetch(workItemResponse('existing; need-input'), {});

      await addWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(2);
      const [, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body[0].value).toBe('existing; need-input');
    });

    test('handles empty initial tags', async () => {
      setSequentialMockFetch(workItemResponse(''), {});

      await addWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(2);
      const [, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body[0].value).toBe('need-input');
    });

    test('is case-insensitive for dedup', async () => {
      setSequentialMockFetch(workItemResponse('Need-Input'), {});

      await addWorkItemTags(42, ['need-input'], mockConfig());

      const [, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body[0].value).toBe('Need-Input');
    });
  });

  describe('removeWorkItemTags', () => {
    test('removes target tag and preserves others', async () => {
      setSequentialMockFetch(workItemResponse('keep-me; need-input; also-keep'), {});

      await removeWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(2);
      const [, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body[0].value).toBe('keep-me; also-keep');
    });

    test('is a no-op when tag does not exist', async () => {
      setSequentialMockFetch(workItemResponse('other-tag'));

      await removeWorkItemTags(42, ['need-input'], mockConfig());

      // Only the GET call, no PATCH
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('handles empty initial tags', async () => {
      setSequentialMockFetch(workItemResponse(''));

      await removeWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('is case-insensitive for removal', async () => {
      setSequentialMockFetch(workItemResponse('Need-Input; other'), {});

      await removeWorkItemTags(42, ['need-input'], mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(2);
      const [, opts] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body[0].value).toBe('other');
    });
  });

  describe('updateWorkItemFields', () => {
    test('sends correct JSON-patch payload for single field', async () => {
      setMockFetch({});

      await updateWorkItemFields(42, { 'System.State': 'Active' }, mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('wit/workitems/42');
      expect(opts.method).toBe('PATCH');
      expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json-patch+json');
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual([
        { op: 'replace', path: '/fields/System.State', value: 'Active' },
      ]);
    });

    test('sends multiple ops for multiple fields', async () => {
      setMockFetch({});

      await updateWorkItemFields(42, {
        'System.State': 'Active',
        'System.BoardColumn': 'In Code Review',
      }, mockConfig());

      expect(mockFn).toHaveBeenCalledTimes(1);
      const [, opts] = mockFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual([
        { op: 'replace', path: '/fields/System.State', value: 'Active' },
        { op: 'replace', path: '/fields/System.BoardColumn', value: 'In Code Review' },
      ]);
    });
  });

  describe('HTTP errors', () => {
    test('throws AzureDevOpsError on HTTP error', async () => {
      mockFn = mock(() =>
        Promise.resolve(new Response('Not found', { status: 404, statusText: 'Not Found' })),
      );
      globalThis.fetch = mockFn as unknown as typeof fetch;

      await expect(fetchWorkItem(999, mockConfig())).rejects.toBeInstanceOf(AzureDevOpsError);
    });
  });

  describe('buildPipelineRunUrl', () => {
    test('constructs correct URL from config and run ID', () => {
      const url = buildPipelineRunUrl(mockConfig(), 42);
      expect(url).toBe('https://dev.azure.com/test-org/Test%20Project/_build/results?buildId=42');
    });
  });

  describe('postPRComment', () => {
    test('posts a comment thread to the PR', async () => {
      setMockFetch({ id: 1 });
      await postPRComment(99, 'Hello from CI', mockConfig());
      expect(mockFn).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFn.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/git/repositories/repo-id/pullrequests/99/threads?');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body as string);
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0].content).toBe('Hello from CI');
      expect(body.comments[0].commentType).toBe(1);
      expect(body.status).toBe(4);
    });
  });
});
