import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  maybeInjectToolRule,
  maybeOverrideSubAgentModel,
  SUBAGENT_TOOL_RULE,
  applyInlineFindings,
} from '../../src/cli/review-pr.ts';
import { findingKey, markerFor } from '../../src/sdk/ado/finding-key.ts';

// ---------------------------------------------------------------------------
// EVAL-ONLY A/B hooks
//
// Both mutate sub-agent definition files on disk, so what matters most is that
// they are TRUE no-ops unless explicitly switched on — a production PR review
// must never have its prompts or pinned models rewritten underneath it.
// ---------------------------------------------------------------------------

function withEnv(key: string) {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[key]; delete process.env[key]; });
  afterEach(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
}

describe('maybeInjectToolRule', () => {
  withEnv('PR_REVIEW_SUBAGENT_TOOL_RULE');

  test('is a no-op when unset — production runs must not be mutated', () => {
    expect(maybeInjectToolRule()).toBe(0);
  });

  test('is a no-op for any value other than "1"', () => {
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = 'true';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '0';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '';
    expect(maybeInjectToolRule()).toBe(0);
  });
});

describe('maybeOverrideSubAgentModel', () => {
  withEnv('PR_REVIEW_SUBAGENT_MODEL');

  test('is a no-op when unset', () => {
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });

  test('is a no-op for an empty or whitespace value', () => {
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = '   ';
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });
});

describe('SUBAGENT_TOOL_RULE', () => {
  test('routes toward tools rather than forbidding Bash', () => {
    // Negative framing is measured to backfire on this codebase: telling an
    // agent what NOT to do suppresses the tool entirely instead of redirecting.
    expect(SUBAGENT_TOOL_RULE).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
  });

  test('names specific LSP operations, not just "use LSP"', () => {
    // Four of the seven sub-agents already mention LSP once, in passing — and
    // made zero LSP calls. A bare mention is not steering.
    for (const op of ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'incomingCalls']) {
      expect(SUBAGENT_TOOL_RULE).toContain(op);
    }
  });

  test('gives the cost reason, which is the persuasive part', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('stays in your context');
  });

  test('points Read at partial reads — the exact sed use it replaces', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('`Read` with `offset`/`limit`');
  });
});

// ---------------------------------------------------------------------------
// applyInlineFindings
//
// Posts Critical/Major findings as line-anchored threads after the agent has
// already posted its summary comment. Every ADO call is individually guarded
// — an inline failure must never fail the review.
// ---------------------------------------------------------------------------

const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'p', repositoryId: 'r', pat: 'x' },
} as any;

describe('applyInlineFindings', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('returns zeroes and makes no calls when findingsList is empty', async () => {
    const spy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    const r = await applyInlineFindings(1, [], config);
    expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a rejected inline post is counted, not thrown', async () => {
    // Branch on METHOD, not URL: fetchReviewThreadsRaw (GET) and postInlineThread (POST)
    // hit the SAME url. Branching on the path alone hands the POST a 200 and the
    // test then passes against a correct implementation while proving nothing.
    globalThis.fetch = mock((_u: string, init?: any) =>
      (init?.method ?? 'GET') === 'GET'
        ? Promise.resolve(new Response('{"value":[]}', { status: 200 }))
        : Promise.resolve(new Response('bad request', { status: 400 })),
    ) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
    const r = await applyInlineFindings(1, findings, config);
    expect(r.failed).toBeGreaterThan(0); // did not throw
  });

  test('posts nothing when PR_REVIEW_NO_POST is set', async () => {
    const spy = mock(() => Promise.resolve(new Response('{"value":[]}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    process.env['PR_REVIEW_NO_POST'] = '1';
    try {
      // Call the same guarded expression reviewPR uses.
      const noPost = process.env['PR_REVIEW_NO_POST'] === '1';
      const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
      if (!noPost) await applyInlineFindings(1, findings, config);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env['PR_REVIEW_NO_POST'];
    }
  });

  // Discrimination tests: each of the three reconcileFindings action kinds must
  // reach its OWN writer. All three writers take similar arguments and hit
  // similar (sometimes identical) URLs, so a mis-wire (e.g. 'update' calling
  // postInlineThread instead of updateThreadComment) would not throw — it would
  // silently post to the wrong endpoint. Each test asserts both which endpoint
  // WAS hit and that the other endpoints were NOT.

  test('a new critical finding creates a thread via postInlineThread (POST to the bare threads endpoint)', async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{"id":1}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Boom', file: 'A.al', line: 5, body: 'it breaks' }] as any;
    const r = await applyInlineFindings(1, findings, config);

    expect(r).toEqual({ created: 1, updated: 0, stale: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads?api-version=7.0');
    expect(calls[0]!.url).not.toMatch(/threads\/\d+/); // not the reply/update sub-resource
    const key = findingKey('A.al', 'Boom');
    expect(calls[0]!.body.comments[0].content).toContain(markerFor(key));
    expect(calls[0]!.body.comments[0].content).toContain('🔴 Critical');
    expect(calls[0]!.body.threadContext.filePath).toBe('/A.al');
    expect(calls[0]!.body.threadContext.rightFileStart.line).toBe(5);
  });

  test('a re-raised finding with an existing marker thread PATCHes via updateThreadComment, never creates', async () => {
    const key = findingKey('A.al', 'Boom');
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 7,
            comments: [{ id: 30, content: `${markerFor(key)}\nold`, commentType: 'text' }],
            threadContext: { filePath: '/A.al', rightFileStart: { line: 5 } },
          }],
        }), { status: 200 }));
      }
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Boom', file: 'A.al', line: 5, body: 'still breaks' }] as any;
    const r = await applyInlineFindings(1, findings, config);

    expect(r).toEqual({ created: 0, updated: 1, stale: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads/7/comments/30?api-version=7.0');
    expect(calls[0]!.body.content).toContain(markerFor(key));
    expect(calls[0]!.body.content).toContain('still breaks');
  });

  test('a finding that stopped being raised appends a stale notice via appendToThread, never PATCHes or creates', async () => {
    const key = findingKey('A.al', 'Gone');
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 9,
            comments: [{ id: 90, content: `${markerFor(key)}\nold`, commentType: 'text' }],
            threadContext: { filePath: '/A.al', rightFileStart: { line: 5 } },
          }],
        }), { status: 200 }));
      }
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    // findings must be non-empty — an EMPTY findings array hits the early-return
    // guard (Step 1's first test) before threads are even fetched. This finding
    // has no `file`, so it is ineligible for create/update and excluded from the
    // "still detected" set — it exists purely to keep the array non-empty.
    const findings = [{ severity: 'critical', title: 'Unrelated, locationless', body: 'x' }] as any;
    const r = await applyInlineFindings(1, findings, config, { today: '2026-07-29' });

    expect(r).toEqual({ created: 0, updated: 0, stale: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads/9/comments?api-version=7.0');
    expect(calls[0]!.url).not.toContain('/threads?api-version=7.0'); // not the create endpoint
    expect(calls[0]!.body.content).toBe('_Not detected in review of 2026-07-29._');
    expect(calls[0]!.body.status).toBeUndefined(); // never closes the thread
  });
});

describe('reviewPR call site — inline posting honours PR_REVIEW_NO_POST', () => {
  // The guard is the single most important line in this feature: an A/B runner
  // sets PR_REVIEW_NO_POST on every arm and expects zero side effects. Reading
  // the actual source pins the guard at the REAL call site, since exercising it
  // via reviewPR() would require standing up the full agent + DB stack.
  test('the inline-post call is guarded by `!noPost &&`', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');
    expect(src).toMatch(/if\s*\(\s*!noPost\s*&&\s*result\.output\?\.findingsList\?\.length\s*\)\s*\{\s*\n\s*await applyInlineFindings\(/);
  });
});
