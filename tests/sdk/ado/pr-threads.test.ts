import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
  fetchReviewThreadsRaw,
  STALE_NOTICE_PREFIX,
  postInlineThread,
  updateThreadComment,
  appendToThread,
  likePRComment,
} from '../../../src/sdk/ado/pull-requests.ts';

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

  test('flags a thread whose LAST comment is a stale notice, even though the FIRST is not', async () => {
    mockThreads([{
      id: 11,
      comments: [
        { id: 1, content: '<!-- ai-finding:abc1234567890def -->\n\nOriginal finding', commentType: 'text' },
        { id: 2, content: `${STALE_NOTICE_PREFIX}2026-07-29._`, commentType: 'text' },
      ],
    }]);
    const t = (await fetchReviewThreadsRaw(1, config))[0]!;
    expect(t.lastCommentIsStaleNotice).toBe(true);
  });

  test('does not flag a thread whose last comment is ordinary content', async () => {
    mockThreads([{
      id: 12,
      comments: [
        { id: 1, content: '<!-- ai-finding:abc1234567890def -->\n\nOriginal finding', commentType: 'text' },
        { id: 2, content: 'Thanks, fixed in the next commit.', commentType: 'text' },
      ],
    }]);
    const t = (await fetchReviewThreadsRaw(1, config))[0]!;
    expect(t.lastCommentIsStaleNotice).toBe(false);
  });
});

describe('postInlineThread', () => {
  test('anchors to the right-hand side of the diff and leaves the thread active', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let body: any;
    globalThis.fetch = mock((u: string, init: any) => {
      url = u;
      method = init.method;
      body = JSON.parse(init.body);
      return Promise.resolve(new Response(JSON.stringify({ id: 5 }), { status: 200 }));
    }) as unknown as typeof fetch;

    await postInlineThread(1, { filePath: 'App/X.al', line: 42, content: 'c' }, config);

    expect(method).toBe('POST');
    // Full suffix, not a fragment: the thread-creation endpoint has no threadId/comments
    // segment, unlike appendToThread's and updateThreadComment's URLs — a bare
    // `.toContain('threads')` would pass even against the wrong endpoint.
    expect(url).toContain('/pullrequests/1/threads?api-version=7.0');
    expect(body.comments[0].content).toBe('c');   // the finding's own text must survive
    expect(body.comments[0].commentType).toBe(1);
    expect(body.threadContext.filePath).toBe('/App/X.al');   // ADO requires a leading slash
    expect(body.threadContext.rightFileStart.line).toBe(42);
    expect(body.threadContext.rightFileEnd.line).toBe(42);
    expect(body.status).toBe('active');   // never pre-closed
  });

  test('does not double the leading slash on an already-absolute path', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let body: any;
    globalThis.fetch = mock((u: string, init: any) => {
      url = u;
      method = init.method;
      body = JSON.parse(init.body);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    await postInlineThread(1, { filePath: '/App/X.al', line: 1, content: 'c' }, config);
    expect(method).toBe('POST');
    expect(url).toContain('/pullrequests/1/threads?api-version=7.0');
    expect(body.threadContext.filePath).toBe('/App/X.al');
  });
});

describe('updateThreadComment', () => {
  test('PATCHes the specific comment by thread and comment id, replacing its content', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let body: any;
    globalThis.fetch = mock((u: string, init: any) => {
      url = u;
      method = init.method;
      body = JSON.parse(init.body);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await updateThreadComment(1, 7, 3, 'updated content', config);

    expect(method).toBe('PATCH');
    expect(url).toContain('/pullrequests/1/threads/7/comments/3?api-version=7.0');
    expect(body).toEqual({ content: 'updated content' });
  });
});

describe('appendToThread', () => {
  test('POSTs a reply onto the existing thread — not the thread-creation endpoint — and never resolves it', async () => {
    let method: string | undefined;
    let url: string | undefined;
    let body: any;
    globalThis.fetch = mock((u: string, init: any) => {
      url = u;
      method = init.method;
      body = JSON.parse(init.body);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await appendToThread(1, 7, 'not detected in this review', config);

    expect(method).toBe('POST');
    // Full suffix, not a fragment: postInlineThread POSTs to ".../threads?api-version=7.0"
    // (no threadId segment) — a substring check like `.toContain('threads')` would pass
    // even if appendToThread wrongly hit that endpoint instead of the reply sub-resource.
    expect(url).toContain('/pullrequests/1/threads/7/comments?api-version=7.0');
    expect(url).not.toContain('/threads?api-version=7.0');
    expect(body).toEqual({ content: 'not detected in this review', commentType: 1 });
    expect(body.status).toBeUndefined();   // a reply must never close/resolve the thread
  });
});

describe('likePRComment', () => {
  test('POSTs to the comment likes sub-resource', async () => {
    let method: string | undefined;
    let url: string | undefined;
    globalThis.fetch = mock((u: string, init: any) => {
      url = u;
      method = init.method;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;

    await likePRComment(1, 7, 3, config);

    // POST, not PUT — verified against the real API, which answers PUT with
    // 405 Method Not Allowed on this sub-resource.
    expect(method).toBe('POST');
    // Full suffix, not a fragment: `appendToThread` POSTs to
    // ".../threads/7/comments?api-version=7.0", so a substring check on
    // "/comments" would pass even if this wrongly hit that endpoint and posted
    // a reply to the PR instead of adding a reaction.
    expect(url).toContain('/pullrequests/1/threads/7/comments/3/likes?api-version=7.0');
    expect(url).not.toContain('/comments?api-version=7.0');
  });

  test('sends no body — the liking identity comes from the PAT', async () => {
    let init: any;
    globalThis.fetch = mock((_u: string, i: any) => {
      init = i;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;

    await likePRComment(1, 7, 3, config);

    expect(init.body).toBeUndefined();
  });
});

describe('postInlineThread anchor', () => {
  test('without endLine, start and end anchor the same line — unchanged behaviour', async () => {
    const bodies: string[] = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await postInlineThread(1, { filePath: 'App/X.al', line: 12, content: 'hi' }, config);

    const sent = JSON.parse(bodies[0]!);
    expect(sent.threadContext.rightFileStart).toEqual({ line: 12, offset: 1 });
    expect(sent.threadContext.rightFileEnd).toEqual({ line: 12, offset: 1 });
  });

  test('with endLine, the range ends at column 1 of that line', async () => {
    const bodies: string[] = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    await postInlineThread(1, { filePath: 'App/X.al', line: 12, endLine: 14, content: 'hi' }, config);

    const sent = JSON.parse(bodies[0]!);
    expect(sent.threadContext.rightFileStart).toEqual({ line: 12, offset: 1 });
    expect(sent.threadContext.rightFileEnd).toEqual({ line: 14, offset: 1 });
  });
});
