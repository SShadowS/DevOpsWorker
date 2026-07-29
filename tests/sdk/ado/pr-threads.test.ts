import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchReviewThreadsRaw } from '../../../src/sdk/ado/pull-requests.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'p', repositoryId: 'r', pat: 'x' },
} as any;

function mockThreads(value: unknown) {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ value }), { status: 200 })),
  ) as unknown as typeof fetch;
}

describe('fetchReviewThreadsRaw', () => {
  test('preserves the HTML marker that fetchPRReviewComments would strip', async () => {
    mockThreads([{
      id: 7,
      comments: [{ id: 1, content: '<!-- ai-finding:abc1234567890def -->\n\nBody', commentType: 'text' }],
      threadContext: { filePath: '/App/X.al', rightFileStart: { line: 42 } },
    }]);
    const threads = await fetchReviewThreadsRaw(1, config);
    expect(threads[0]!.rawContent).toContain('<!-- ai-finding:abc1234567890def -->');
  });

  test('exposes the anchor so a thread can be located', async () => {
    mockThreads([{
      id: 7,
      comments: [{ id: 3, content: 'x', commentType: 'text' }],
      threadContext: { filePath: '/App/X.al', rightFileStart: { line: 42 } },
    }]);
    const t = (await fetchReviewThreadsRaw(1, config))[0]!;
    expect(t.id).toBe(7);
    expect(t.firstCommentId).toBe(3);
    expect(t.filePath).toBe('/App/X.al');
    expect(t.line).toBe(42);
  });

  test('keeps unanchored threads — the summary comment is one', async () => {
    mockThreads([{ id: 9, comments: [{ id: 1, content: 'summary', commentType: 'text' }] }]);
    const threads = await fetchReviewThreadsRaw(1, config);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.filePath).toBeUndefined();
  });

  test('skips threads with no comments rather than throwing', async () => {
    mockThreads([{ id: 9, comments: [] }]);
    expect(await fetchReviewThreadsRaw(1, config)).toEqual([]);
  });
});
