import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  maybeInjectToolRule,
  maybeOverrideSubAgentModel,
  SUBAGENT_TOOL_RULE,
  applyInlineFindings,
  buildPriorFindingsBlock,
  parseReviewPrArgs,
} from '../../src/cli/review-pr.ts';
import { findingKey, markerFor } from '../../src/sdk/ado/finding-key.ts';
import type { ReviewThread } from '../../src/sdk/ado/pull-requests.ts';

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

  test('applyInlineFindings itself makes no fetch call when PR_REVIEW_NO_POST is set — the internal guard, called directly rather than through the call-site guard', async () => {
    // Unlike the test above, this calls applyInlineFindings unconditionally — it
    // must refuse on its own. The call site is guarded today, but the function is
    // exported and an upcoming A/B harness calls it directly across many arms; a
    // caller that forgets the site guard must still be unable to write to a live PR.
    const spy = mock(() => Promise.resolve(new Response('{"value":[]}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    process.env['PR_REVIEW_NO_POST'] = '1';
    try {
      const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
      const r = await applyInlineFindings(1, findings, config);
      expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
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

  test('suppressStale: true reaches reconcileFindings — no stale notice is appended, even though the finding above would trigger one', async () => {
    // Pins the FORWARDING, not just reconcileFindings' own behaviour (already
    // pinned in tests/sdk/ado/reconcile-findings.test.ts): a correct
    // reconcileFindings wired to an applyInlineFindings that forgets to pass
    // opts.suppressStale through is the failure that actually matters here.
    const key = findingKey('A.al', 'Gone');
    const calls: { method: string; url: string }[] = [];
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
      calls.push({ method, url: u });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Unrelated, locationless', body: 'x' }] as any;
    const r = await applyInlineFindings(1, findings, config, { today: '2026-07-29', suppressStale: true });

    expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
    expect(calls).toHaveLength(0); // no write of any kind — nothing to create/update, stale suppressed
  });
});

// ---------------------------------------------------------------------------
// buildPriorFindingsBlock
//
// The lookup the whole reconciliation rests on. Sub-agents regenerate their
// findings from scratch every run, so unless the orchestrator is SHOWN the
// previous file+title pairs it has nothing to be stable against, and every
// re-review forks each thread while this suite stays green — every other test
// here hand-constructs its titles and so cannot detect drift.
// ---------------------------------------------------------------------------

function markerThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 1,
    firstCommentId: 1,
    lastCommentIsStaleNotice: false,
    rawContent: '',
    filePath: '/A.al',
    line: 3,
    ...over,
  };
}

/** The shape `buildCommentBody` renders — see the round-trip test for the real thing. */
function bodyFor(key: string, severity: string, title: string, body = 'why it matters'): string {
  return `${markerFor(key)}\n\n**${severity}** — ${title}\n\n${body}`;
}

function rowFor(block: string, filePrefix: string): string | undefined {
  return block.split('\n').find((l) => l.startsWith(`| ${filePrefix}`));
}

describe('buildPriorFindingsBlock', () => {
  test('lists prior findings so a re-review can reuse their titles', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).toContain('Missing timeout');
    expect(block).toContain('A.al');
    expect(block).toContain('| File | Title |');
  });

  test('is empty when the PR has no prior inline findings', () => {
    expect(buildPriorFindingsBlock([])).toBe('');
  });

  test('the file and title it prints hash back to the thread\'s own key', () => {
    // The whole point of the block: what the model copies out of the table must
    // produce the SAME findingKey as the marker on the thread it should update.
    // ADO stores the anchor as `/App/...` while the model reports `App/...`, so
    // a block that passes the leading slash through would hand the model a path
    // that hashes to a different key — a duplicate thread on every re-review,
    // with the containment assertions above still green.
    const file = 'App/Cloud/Al/Codeunits/X.Codeunit.al';
    const key = findingKey(file, 'Missing HTTP timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ filePath: `/${file}`, rawContent: bodyFor(key, '🟠 Major', 'Missing HTTP timeout') }),
    ]);

    const row = rowFor(block, 'App/');
    expect(row).toBeDefined();
    const [, printedFile, printedTitle] = row!.split('|').map((c) => c.trim());
    expect(findingKey(printedFile!, printedTitle!)).toBe(key);
  });

  test('parses a body written by the real inline renderer, not an approximation', async () => {
    // `buildCommentBody` is private, so reach it the way production does: post a
    // finding, capture the exact bytes ADO stores, and feed those back in. If
    // either side of that format drifts independently the parser silently stops
    // emitting rows — titles fork again and no hand-built fixture would notice.
    const realFetch = globalThis.fetch;
    let posted = '';
    globalThis.fetch = mock((_u: string, init?: any) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
      }
      posted = JSON.parse(init.body).comments[0].content;
      return Promise.resolve(new Response('{"id":1}', { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const file = 'App/Cloud/Al/Codeunits/X.Codeunit.al';
      const findings = [{ severity: 'critical', title: 'HttpClient has no timeout', file, line: 12, body: 'b' }] as any;
      const r = await applyInlineFindings(1, findings, config);
      expect(r.created).toBe(1);
      expect(posted).not.toBe('');

      const block = buildPriorFindingsBlock([markerThread({ filePath: `/${file}`, rawContent: posted })]);
      expect(block).toContain(`| ${file} | HttpClient has no timeout |`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a human thread carries no marker and never reaches the table', () => {
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: 'Please rename this to something clearer.' }),
    ]);
    expect(block).toBe('');
  });

  test('keeps the marker thread and drops the human one when both are present', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ id: 1, rawContent: 'By design — see the linked ticket.' }),
      markerThread({ id: 2, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).toContain('Missing timeout');
    expect(block).not.toContain('By design');
    expect(block.split('\n').filter((l) => l.startsWith('| A.al')).length).toBe(1);
  });

  test('a marker thread with no severity line yields no row and does not throw', () => {
    const key = findingKey('A.al', 'Whatever');
    expect(buildPriorFindingsBlock([
      markerThread({ rawContent: `${markerFor(key)}\n\nsomeone reflowed this by hand\n\nbody` }),
    ])).toBe('');
    // Marker and nothing else — the body was deleted in the ADO web UI.
    expect(buildPriorFindingsBlock([markerThread({ rawContent: markerFor(key) })])).toBe('');
  });

  test('only the first line after the marker can be the title', () => {
    // A parser that scanned the whole body would lift this severity-shaped line
    // out of the prose and emit a garbage row the model is then told to reuse.
    const key = findingKey('A.al', 'x');
    expect(buildPriorFindingsBlock([
      markerThread({
        rawContent: `${markerFor(key)}\n\nsomeone replaced the heading with prose\n\n**🔴 Critical** — quoted from an earlier review\n`,
      }),
    ])).toBe('');
  });

  test('a bold em-dash line that is not a severity line is not taken for the title', () => {
    // Dropping the Critical/Major requirement from the parser would lift `a
    // hand-written reply` here — the row would look plausible and be wrong.
    const key = findingKey('A.al', 'x');
    expect(buildPriorFindingsBlock([
      markerThread({ rawContent: `${markerFor(key)}\n\n**Note** — a hand-written reply\n` }),
    ])).toBe('');
  });

  test('an unanchored marker thread is skipped', () => {
    // The orchestrator reads existing PR comments in Phase 2; if it ever echoes a
    // marker into the summary it posts, that thread has no filePath and no path
    // for the model to reuse. Same guard reconcileFindings applies.
    const key = findingKey('A.al', 'Missing timeout');
    expect(buildPriorFindingsBlock([
      markerThread({ filePath: undefined, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ])).toBe('');
  });

  test('a CRLF body still yields a clean title', () => {
    // ADO round-trips comment bodies through JSON and can hand back CRLF. A
    // parser that splits on \n alone leaves a trailing \r glued to the title,
    // which changes nothing about the key but prints a broken table row.
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout').replace(/\n/g, '\r\n') }),
    ]);
    expect(block).toContain('| A.al | Missing timeout |');
    expect(block).not.toContain('\r');
  });

  test('a pipe in a title is escaped, and escaping cannot fork the key', () => {
    const title = 'Error() | ErrorInfo() mismatch';
    const key = findingKey('A.al', title);
    const block = buildPriorFindingsBlock([markerThread({ rawContent: bodyFor(key, '🟠 Major', title) })]);

    expect(rowFor(block, 'A.al')).toBe('| A.al | Error() \\| ErrorInfo() mismatch |');
    // Safe because findingKey collapses every non-alphanumeric run to one space:
    // the escaped form the model copies back normalises to the same key.
    expect(findingKey('A.al', 'Error() \\| ErrorInfo() mismatch')).toBe(key);
  });

  test('escaping a pipe is idempotent — a title copied back already escaped does not accrete a second backslash', () => {
    // The re-review cycle this guards against: the model copies a title verbatim
    // out of a previous prior-findings row, which already contains `\|`. A naive
    // `replace(/\|/g, '\\|')` would then escape the pipe a second time on top of
    // the existing backslash — one extra backslash per re-review, unbounded on a
    // long-lived PR.
    const alreadyEscaped = 'Error() \\| ErrorInfo() mismatch'; // one backslash, as printed by a prior row
    const key = findingKey('A.al', alreadyEscaped);
    const block = buildPriorFindingsBlock([markerThread({ rawContent: bodyFor(key, '🟠 Major', alreadyEscaped) })]);
    expect(rowFor(block, 'A.al')).toBe('| A.al | Error() \\| ErrorInfo() mismatch |');
  });

  test('a file reported with a leading slash prints the spelling that hashes back', () => {
    // `findingKey` applies no slash normalisation, and `postInlineThread` tolerates
    // a leading slash — so the key on this thread may have been built from
    // '/App/…'. ADO stores the anchor with a leading slash either way, so the
    // thread alone does not say which spelling was hashed. Stripping it
    // unconditionally prints a pair that names a DIFFERENT identity than the
    // thread it sits on: the model reuses the row verbatim, reconcileFindings
    // matches nothing, and the re-review both creates a duplicate and drops a
    // false "not detected" reply on the original.
    const reported = '/App/Cloud/Al/Codeunits/X.Codeunit.al';
    const key = findingKey(reported, 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ filePath: reported, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);

    const row = block.split('\n').find((l) => l.includes('Missing timeout'));
    expect(row).toBeDefined();
    const [, printedFile, printedTitle] = row!.split('|').map((c) => c.trim());
    expect(findingKey(printedFile!, printedTitle!)).toBe(key);
  });

  test('a title that spans lines never prints a truncated pair', () => {
    // `PRFinding.title` is a bare z.string(), so a newline is reachable. findingKey
    // normalises it to a space; parseFindingTitle only ever sees the first line.
    const title = 'Missing timeout\nin the document sender';
    const key = findingKey('A.al', title);
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', title) }),
    ]);

    // This is the row an unguarded strip prints. It hashes to a different identity
    // than the thread it names, so the model would reuse it and still fork.
    expect(block).not.toContain('| A.al | Missing timeout |');
    // Asserting the invariant rather than `toBe('')`: a parser that recovered the
    // whole title would print a row that DOES reproduce the key, and that is a
    // better outcome this test should not forbid.
    for (const row of block.split('\n').filter((l) => l.startsWith('| A.al'))) {
      const [, file, printedTitle] = row.split('|').map((c) => c.trim());
      expect(findingKey(file!, printedTitle!)).toBe(key);
    }
  });

  test('a hand-edited body whose title no longer matches its marker is dropped and logged', () => {
    // Someone reworded the comment in the ADO web UI, so no parse can recover the
    // title the key was built from. The row must be withheld — and visibly: Task 8
    // measures duplicate threads on a live re-review, and a silent drop makes a
    // duplicate unattributable between "the model reworded" and "the table withheld
    // the row it was supposed to reuse".
    const key = findingKey('A.al', 'Missing timeout');
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      expect(buildPriorFindingsBlock([
        markerThread({ id: 42, rawContent: bodyFor(key, '🔴 Critical', 'Reworded by a reviewer') }),
      ])).toBe('');
    } finally {
      console.log = realLog;
    }
    expect(logs.join('\n')).toContain('42');
  });

  test('two threads sharing a key print one row', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ id: 1, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
      markerThread({ id: 2, rawContent: bodyFor(key, '🟠 Major', 'Missing timeout') }),
    ]);
    expect(block.split('\n').filter((l) => l.startsWith('| A.al')).length).toBe(1);
  });

  test('states the consequence of rewording rather than forbidding it', () => {
    // Prohibition wording is measured on this codebase to suppress the behaviour
    // outright instead of redirecting it.
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).not.toMatch(/\bnever\b|\bdo not\b|\bdon't\b|\bavoid\b/i);
    expect(block).toContain('reuse');
  });
});

describe('reviewPR call site — the prior-findings block reaches the agent', () => {
  // The block is worthless if it is computed and dropped, and exercising reviewPR()
  // would need the full agent + DB stack — so pin the wiring in the real source.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the block is built from a pre-agent thread read', () => {
    expect(src).toMatch(/priorFindingsBlock\s*=\s*buildPriorFindingsBlock\(\s*await fetchReviewThreadsRaw\(prId, config\)\s*\)/);
  });

  test('the read happens before the agent runs, not after', () => {
    // `runPRReview` is now wrapped in a `runFullReview` closure so the sanity path can
    // fall back to it; the closure is DEFINED before the read but INVOKED after, so
    // anchor on the definition — that is where the argument list, and therefore the
    // block, is actually captured.
    const readAt = src.indexOf('priorFindingsBlock = buildPriorFindingsBlock(');
    const defAt = src.indexOf('const runFullReview = () => runPRReview(');
    expect(readAt).toBeGreaterThan(-1);
    expect(defAt).toBeGreaterThan(-1);
    // Both call sites go through the closure, so no invocation can precede the read.
    const invocations = src.match(/runFullReview\(\)/g) ?? [];
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const m of src.matchAll(/runFullReview\(\)/g)) {
      expect(m.index!).toBeGreaterThan(readAt);
    }
  });

  test('the block is passed into the full review', () => {
    const call = src.match(/const runFullReview = \(\) => runPRReview\(\s*\{([\s\S]*?)\},/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('priorFindingsBlock');
    // Exactly one runPRReview call site: two would let the fallback path drift from
    // the primary one, which is the whole reason it was extracted.
    expect((src.match(/runPRReview\(/g) ?? []).length).toBe(1);
  });

  test('the block also reaches runBackportReview — the sanity path forks threads too without it', () => {
    // Task 7 flagged this and Task 8 correctly declined to expand its own scope;
    // it belongs here because this task is about inline-thread identity. Without
    // it, every re-review of a backport opens a duplicate thread instead of
    // updating the one Task 8's sanity review already posted.
    const call = src.match(/await runBackportReview\(\s*\{([\s\S]*?)\},\s*\n\s*config,/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('priorFindingsBlock');
  });

  test('the read happens before runBackportReview too', () => {
    const readAt = src.indexOf('priorFindingsBlock = buildPriorFindingsBlock(');
    const runAt = src.indexOf('await runBackportReview(');
    expect(readAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(runAt);
  });
});

describe('reviewPR call site — inline posting honours PR_REVIEW_NO_POST', () => {
  // The guard is the single most important line in this feature: an A/B runner
  // sets PR_REVIEW_NO_POST on every arm and expects zero side effects. Reading
  // the actual source pins the guard at the REAL call site, since exercising it
  // via reviewPR() would require standing up the full agent + DB stack.
  test('the inline-post call is guarded by `!noPost &&`', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');
    // Allows an optional `inlineThreads = ` capture in front of the call — the
    // counters are persisted to pr_reviews — but still pins the call directly
    // inside the guard body, with nothing else between them.
    expect(src).toMatch(/if\s*\(\s*!noPost\s*&&\s*result\.output\?\.findingsList\?\.length\s*\)\s*\{\s*\n\s*(?:\w+\s*=\s*)?await applyInlineFindings\(/);
  });
});

describe('reviewPR call site — inlineThreads counters actually reach save()', () => {
  // The guard test above only pins that applyInlineFindings is called inside
  // `!noPost && ...` — it deliberately allows an optional capture, so it does
  // NOT catch a future edit that drops just the `inlineThreads = ` assignment
  // while leaving `await applyInlineFindings(...)` for its side effect. That
  // still typechecks (inlineThreads stays declared, always null) and still
  // satisfies the guard regex, but silently defeats this feature's whole
  // point — the counters would always persist as null instead of a measured
  // result. Pin the specific assignment, not just its optional shape.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the applyInlineFindings return value is captured into inlineThreads', () => {
    expect(src).toMatch(/inlineThreads\s*=\s*await applyInlineFindings\(/);
  });

  test('the success-branch save() call passes both findingsList and inlineThreads', () => {
    // Isolate the success-branch `prReviewStore.save({...})` object literal —
    // not the catch-block save(), which intentionally always persists null
    // for both fields since nothing was computed before the run errored.
    const saveMatch = src.match(/if \(prReviewStore\) \{\s*\n\s*try \{\s*\n\s*await prReviewStore\.save\(\{([\s\S]*?)\}\);/);
    expect(saveMatch).not.toBeNull();
    const body = saveMatch![1]!;
    expect(body).toContain('findingsList: result.output.findingsList ?? null');
    expect(body).toContain('inlineThreads,');
  });
});

describe('reviewPR call site — the sanity path suppresses stale notices', () => {
  // A sanity review deliberately never examines style/performance/security, so it
  // has no basis to declare a full-review finding "not detected" — reconcileFindings'
  // suppressStale option exists for exactly this, but a call site that forgets to
  // pass it through is the failure that actually matters (the pure-function
  // behaviour alone is pinned in tests/sdk/ado/reconcile-findings.test.ts).
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the applyInlineFindings call passes suppressStale: true only when route.path is sanity', () => {
    const call = src.match(/inlineThreads = await applyInlineFindings\(prId, result\.output\.findingsList, config, ([^;]*)\);/);
    expect(call).not.toBeNull();
    const optsArg = call![1]!.trim();
    expect(optsArg).toBe(`route.path === 'sanity' ? { suppressStale: true } : {}`);
  });

  test("negative control: the full-path arm of the ternary carries no suppressStale", () => {
    // Guards against a regression that suppresses stale notices unconditionally —
    // which would silently break the invariant that a full review's stale-marking
    // is unchanged. Matched as a whole expression (rather than splitting on ':',
    // which also appears inside the truthy arm's `{ suppressStale: true }`).
    expect(src).toMatch(/route\.path === 'sanity' \? \{ suppressStale: true \} : \{\}/);
    expect(src).not.toMatch(/route\.path === 'sanity' \? \{\} : \{ suppressStale: true \}/);
  });
});

describe('reviewPR routes before spending and records which path ran', () => {
  // Exercising this behaviourally would need the full agent + DB stack (same
  // trade-off already accepted throughout this file), so it is pinned in the
  // real source: the routing decision must precede BOTH agent calls, and the
  // chosen path must be recorded so a cheap review and a failed detection stay
  // distinguishable in `pr_reviews`.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('reviewPR routes before spending and records which path ran', () => {
    const routeAt = src.indexOf('chooseReviewPath(');
    const fullAt = src.indexOf('runPRReview(');
    const sanityAt = src.indexOf('runBackportReview(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(sanityAt).toBeGreaterThan(-1);
    expect(routeAt).toBeLessThan(fullAt);
    expect(routeAt).toBeLessThan(sanityAt);
    // A cheap review and a failed detection must be distinguishable in the data.
    expect(src).toMatch(/reviewPath:/);
  });

  test('a failed checkout reassigns the route to full rather than proceeding on a broken checkout', () => {
    // Pins the fallback itself, not just its ordering above: on `!checkout.ok`,
    // `route` must be reassigned to the 'full' variant before the second
    // `route.path === 'sanity'` check that decides which agent runs.
    expect(src).toMatch(/if\s*\(!checkout\.ok\)\s*\{[\s\S]*?route\s*=\s*\{\s*path:\s*'full'/);
  });

  test('the five model-echoed fields are overwritten from already-known values after the agent runs', () => {
    // Task 7's carried-forward concern: sourcePrId/sourceReviewStatus/sourceRecommendation/
    // checkoutOk/mergePreviewStale are known to TypeScript before the agent runs, so the
    // model's echo of them must be replaced rather than trusted — a transcription slip is
    // otherwise invisible, and mergePreviewStale alone can flip the verdict.
    const overwriteBlock = src.match(/result = \{\s*\.\.\.backportResult,\s*output: \{([\s\S]*?)\},\s*\};/);
    expect(overwriteBlock).not.toBeNull();
    const body = overwriteBlock![1]!;
    for (const field of ['sourcePrId', 'sourceReviewStatus', 'sourceRecommendation', 'checkoutOk', 'mergePreviewStale']) {
      expect(body).toContain(field);
    }
  });

  test('the sanity branch never calls runPRReview, and the full branch never calls runBackportReview', () => {
    // Discrimination, not just presence: a mis-wire that called the wrong reviewer
    // inside the wrong branch would still satisfy the ordering test above.
    // Plain indexOf slicing rather than one regex spanning the whole dispatch —
    // this file is CRLF in the Windows working tree (`.gitattributes` `text=auto`),
    // and a regex anchored on literal `\n\n` sequences is exactly the kind of thing
    // that passes on a fresh Linux checkout and silently stops matching here.
    //
    // Anchored on `runBackportReview(` — the one thing that is BY DEFINITION inside
    // the sanity dispatch — and walked outward from there.
    //
    // The previous anchor was "the first `} else {` after the first
    // `if (route.path === 'sanity')`", on the reasoning that guards would keep being
    // added above it but the else would stay the dispatch's. That held until a guard
    // grew an else of its OWN: the port-diff fallback became
    // `if (port.ok) { … } else { … }` when `fetchPRDiff` stopped throwing, and the
    // search then sliced out the guard instead of the dispatch. Walking out from the
    // call cannot be fooled that way, however many branches appear above it.
    const backportCallAt = src.indexOf('await runBackportReview(');
    expect(backportCallAt).toBeGreaterThan(-1);
    const dispatchSanityIf = src.lastIndexOf(`if (route.path === 'sanity') {`, backportCallAt);
    expect(dispatchSanityIf).toBeGreaterThan(-1);
    const elseAt = src.indexOf('} else {', backportCallAt);
    expect(elseAt).toBeGreaterThan(dispatchSanityIf);

    const likeliestAt = src.indexOf('// The likeliest way', elseAt);
    expect(likeliestAt).toBeGreaterThan(elseAt);

    const sanityBody = src.slice(dispatchSanityIf, elseAt);
    const fullBody = src.slice(elseAt, likeliestAt);

    expect(sanityBody).toContain('runBackportReview(');
    expect(fullBody).toContain('runFullReview(');
    expect(fullBody).not.toContain('runBackportReview(');

    // The sanity branch MAY reach the full reviewer, but only as a failure fallback:
    // a sanity-agent throw used to leave the PR with no review at all, which is worse
    // than the expensive review this path replaces. So the invariant is no longer
    // "never" — it is "only inside the catch".
    //
    // Assert the position, not merely the presence: on the SUCCESS path the sanity
    // branch must still never call it, or the cost saving is gone.
    const catchAt = sanityBody.indexOf('} catch (err) {');
    expect(catchAt).toBeGreaterThan(-1);
    expect(sanityBody.slice(0, catchAt)).not.toContain('runFullReview(');
    expect(sanityBody.slice(catchAt)).toContain('runFullReview(');
  });

  test('checkoutBranch and resolveRef target the repo subdirectory, not the bare session root', () => {
    // CRITICAL, caught by review: docker/entrypoint.sh clones the repo ONE LEVEL
    // BELOW the session root (MAIN_REPO_DIR="${SESSION_ROOT}/${REPO_KEY}") — the
    // session root itself is never a git repository. Passing it bare to
    // checkoutBranch/resolveRef makes every checkout fail in a container, silently:
    // route falls back to 'full' and the sanity path never runs, looking exactly
    // like the fail-safe working as designed. Pin that both calls go through the
    // joined directory instead.
    expect(src).toMatch(/const repoDir = join\(config\.paths\.sessionRoot, config\.repoKey\)/);
    expect(src).toMatch(/checkoutBranch\(repoDir,/);
    expect(src).toMatch(/resolveRef\(repoDir,/);
    // And the bug's exact shape must not reappear at either call site.
    expect(src).not.toMatch(/checkoutBranch\(config\.paths\.sessionRoot,/);
    expect(src).not.toMatch(/resolveRef\(config\.paths\.sessionRoot,/);
  });

  test('a sanity-agent failure falls back to a full review and records it as a cost signal', () => {
    // Measured: the sanity agent exhausted its turn budget on 1 of 2 runs of the same
    // PR, returned NULL structured output and threw — and the throw left the PR with
    // NO review at all, strictly worse than the expensive review this path replaces.
    //
    // Unlike the checkout and port-diff fallbacks, this one is not free: the sanity
    // attempt has already spent its turns, so falling back pays twice. That makes the
    // fallback RATE something to watch, which is why it must land in `review_path`
    // and not only in a log line nobody queries.
    expect(src).toMatch(/sanity review failed, falling back to the full review/);
    expect(src).toMatch(/reason: `sanity review failed: \$\{why\.slice\(0, 200\)\}`/);
    // Persisted, not just logged.
    expect(src).toMatch(/reviewPath = `full:\$\{route\.reason\}`/);
  });

  test('the checkout is offered lastMergeCommit, so a completed PR still takes the sanity path', () => {
    // Measured on PR 52308: completed PRs here carry
    // `completionOptions.deleteSourceBranch: true`, so the source branch is GONE and
    // the checkout cannot succeed. Without the fallback the sanity path degrades to
    // the full review for every completed PR — fail-safe, and therefore invisible,
    // at ~3x the cost. It also voids any A/B run over historical PRs, since every
    // arm silently takes the fallback and the null result looks like data.
    expect(src).toMatch(/checkoutBranch\(repoDir, effectiveSourceBranch, prMetadata\?\.lastMergeCommit\)/);
    // The two-argument shape is the bug — pin that it does not come back.
    expect(src).not.toMatch(/checkoutBranch\(repoDir, effectiveSourceBranch\)/);
  });

  test('a merge-commit checkout suppresses mergePreviewStale instead of computing it', () => {
    // Second-order trap: for a COMPLETED PR, `lastMergeTargetCommit` is the target
    // tip at merge time, and the merge itself moved the tip past it — so the computed
    // comparison is unconditionally "stale". That flag flips the verdict on its own
    // (review-pr.ts overwrites the model's echo of it), so leaving it computed makes
    // every completed-PR review return the same verdict: uniform, and worthless both
    // as a signal and as A/B data.
    expect(src).toMatch(/const mergePreviewStale = reviewedMergeCommit\s*\?\s*false/);
    // The suppression must be driven by the checkout result, not assumed.
    expect(src).toMatch(/reviewedMergeCommit = true/);
  });

  test('a failed port-diff fetch falls back to full rather than aborting the review', () => {
    // Important, caught by review: the source-diff fetch 80 lines above is
    // guarded, but the port's OWN diff fetch was not — a transient failure there
    // used to throw into the outer catch, saving an error row and giving the PR no
    // review at all (worse than before this feature existed, which always ran the
    // full review). No agent has run at this point, so falling back is still free
    // — same invariant as the checkout fallback above it.
    //
    // `fetchPRDiff` now returns a result instead of throwing, so the guard is an
    // `if (!port.ok)` rather than a catch. The fallback it protects is unchanged
    // and is what this pins.
    const guardMatch = src.match(/let portDiff: FileDiff\[\] = \[\];\s*\n\s*if \(route\.path === 'sanity'\) \{([\s\S]*?)\n\s{4}\}/);
    expect(guardMatch).not.toBeNull();
    const [, body] = guardMatch!;
    // The clone directory is required — a diff is computed with git now, not fetched.
    expect(body).toContain('fetchPRDiff(prId, repoDir, config)');
    expect(body).toMatch(/route = \{ path: 'full', reason:/);
    expect(body).toMatch(/reviewPath = `full:/);
  });

  test('an empty PORT diff falls back to full, symmetrically with the source side', () => {
    // The source side already refuses to route `sanity` on an empty diff
    // (`sourceDiffFetchable: sourceDiff.length > 0`), but the port side did not.
    // An empty port diff compares cleanly and reports EVERY source file as
    // `missingFromPort` — the safe direction, but it dresses a computation failure
    // up as a damning finding about the port, which is worse than saying nothing.
    const guardMatch = src.match(/let portDiff: FileDiff\[\] = \[\];\s*\n\s*if \(route\.path === 'sanity'\) \{([\s\S]*?)\n\s{4}\}/);
    expect(guardMatch).not.toBeNull();
    const [, body] = guardMatch!;
    expect(body).toMatch(/port\.ok && port\.files\.length === 0/);
    expect(body).toMatch(/reason: 'port PR changed no comparable files'/);
  });

  test('the source-diff failure distinguishes a missing PR from an uncomputable diff', () => {
    // The CRITICAL that hid a dead endpoint for this feature's whole lifetime:
    // `sourcePrExists` was set only inside the success branch, so EVERY failure —
    // 404, 500, auth, network, a URL that does not exist — reported
    // "source PR !<id> not found in this repository" and persisted that
    // unfalsifiable sentence into `review_path`. Only an ADO 404 may say that now.
    expect(src).toMatch(/sourcePrExists = !source\.prMissing/);
    expect(src).toMatch(/sourceDiffError = source\.error/);
    // And the reason reaches the router, so `review_path` carries the real cause.
    expect(src).toMatch(/sourceDiffError,/);
    // The old shape must not come back: a bare `sourcePrExists = true` right after
    // an unguarded fetch is exactly what made every failure look like absence.
    expect(src).not.toMatch(/sourceDiff = await fetchPRDiff\(/);
  });

  test('repoDir is declared before the first diff read, not just before the checkout', () => {
    // A diff is now computed with `git diff` inside the clone, so `repoDir` has to
    // exist by the time the SOURCE diff is read — which happens well above the
    // checkout it was originally declared for. Declared too late, this is a
    // use-before-declaration TypeScript catches; pinned here so a later reshuffle
    // that moves it back down is caught as the ordering decision it is.
    const repoDirAt = src.indexOf('const repoDir = join(config.paths.sessionRoot, config.repoKey)');
    const sourceFetchAt = src.indexOf('await fetchPRDiff(cherryPick.originalPrId, repoDir, config)');
    expect(repoDirAt).toBeGreaterThan(-1);
    expect(sourceFetchAt).toBeGreaterThan(-1);
    expect(repoDirAt).toBeLessThan(sourceFetchAt);
  });

  test("a mismatch between the model's echo and the computed mergePreviewStale/checkoutOk is logged, not just silently overwritten", () => {
    // Important, caught by review: the overwrite deletes the evidence that the
    // model misread the inverted "Merge preview current" prompt line unless a
    // mismatch is logged BEFORE the overwrite happens. The artifacts a mis-echo
    // corrupts (the posted comment, recommendation, reviewBody) are produced
    // during the run and cannot be fixed after the fact — a log line is the only
    // thing that would ever surface this to a human.
    // `...backportResult,` alone (not a multi-line literal spanning the `result = {`
    // opener) so this survives the file's CRLF line endings unchanged.
    const overwriteAt = src.indexOf('...backportResult,');
    expect(overwriteAt).toBeGreaterThan(-1);
    const beforeOverwrite = src.slice(0, overwriteAt);
    expect(beforeOverwrite).toMatch(/backportResult\.output\.mergePreviewStale !== mergePreviewStale/);
    expect(beforeOverwrite).toMatch(/backportResult\.output\.checkoutOk !== true/);
    expect(beforeOverwrite).toMatch(/console\.warn/);
  });

  test('the backport params repoKey is the folder name, not the registry key the save() calls persist', () => {
    // Caught alongside the CRITICAL directory fix: `params.repoKey` is now named
    // literally as the checkout subdirectory in cherry-pick-reviewer's prompt, so
    // it must be `config.repoKey` (the folder name `repoDir` is also built from),
    // not `repo.key` (the registry key `save()` persists as `repo_key`).
    const paramsMatch = src.match(/const backportResult = await runBackportReview\(\s*\{([\s\S]*?)\},\s*\n\s*config,/);
    expect(paramsMatch).not.toBeNull();
    expect(paramsMatch![1]).toMatch(/repoKey:\s*config\.repoKey/);
  });
});

describe('reviewPR resolves the PR title rather than always storing the fallback', () => {
  // action-processor.ts forwards no --pr-title, so on the watcher path prTitle is
  // always empty and this fallback used to be the ONLY value ever stored — pinned
  // here in the real source, since exercising reviewPR() would need the full
  // agent + DB stack (same reasoning as the call-site tests above).
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('reviewPR resolves the PR title rather than always storing the fallback', () => {
    // The fallback must remain as a fallback, not as the only value.
    expect(src).toMatch(/title:\s*resolvedTitle\s*\|\|\s*`PR #\$\{prId\}`/);
    expect(src).toMatch(/prTitle:\s*resolvedTitle/);

    // Both prReviewStore.save() call sites persist a `title` — the success path
    // and the catch block (used when the run errors before completing).
    // resolvedTitle is in scope at both, and a debugger looking at a failed
    // review deserves the real title too, not `PR #123` next to a sibling row
    // that has it. Asserting a count (rather than just the single `toMatch`
    // above, which is satisfied by one occurrence) is what actually catches a
    // regression at either site.
    const occurrences = src.match(/title:\s*resolvedTitle\s*\|\|\s*`PR #\$\{prId\}`/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // And no bare fallback-only spelling should remain anywhere.
    expect(src).not.toMatch(/title:\s*`PR #\$\{prId\}`,/);
  });
});

// ---------------------------------------------------------------------------
// parseReviewPrArgs — the CLI-flag end of the /review-full escape hatch.
//
// `--full` is the automated-caller half (eval harness, scripts); `/review-full`
// (webhook-server/parse.ts) is the human half. Both must independently be able
// to force `chooseReviewPath`'s full path, since a PR comment cannot serve an
// automated caller and vice versa.
// ---------------------------------------------------------------------------

describe('parseReviewPrArgs', () => {
  test('--full sets forceFull true', () => {
    expect(parseReviewPrArgs(['--pr-id', '1', '--repo-id', 'r', '--full']).forceFull).toBe(true);
  });

  test('forceFull defaults to false when --full is absent (the watcher never passes it today)', () => {
    expect(parseReviewPrArgs(['--pr-id', '1', '--repo-id', 'r']).forceFull).toBe(false);
  });

  test('every other flag still parses to the same shape as before the refactor', () => {
    const parsed = parseReviewPrArgs([
      '--pr-id', '5', '--repo-id', 'guid',
      '--source-branch', 'refs/heads/x', '--target-branch', 'refs/heads/y',
      '--pr-url', 'https://example/pr/5',
      '--pr-title', 'Cherry-pick: fix', '--pr-description', 'Cherry-picked from pull request !3',
      '--action-id', '9',
    ]);
    expect(parsed).toEqual({
      prId: 5,
      repoId: 'guid',
      sourceBranch: 'refs/heads/x',
      targetBranch: 'refs/heads/y',
      prUrl: 'https://example/pr/5',
      prTitle: 'Cherry-pick: fix',
      prDescription: 'Cherry-picked from pull request !3',
      actionId: 9,
      forceFull: false,
    });
  });

  test('an empty argv still defaults sourceBranch/targetBranch to empty strings, not undefined', () => {
    const parsed = parseReviewPrArgs([]);
    expect(parsed.sourceBranch).toBe('');
    expect(parsed.targetBranch).toBe('');
    expect(parsed.forceFull).toBe(false);
  });
});

describe('reviewPR forwards --full into chooseReviewPath as forceFull', () => {
  // parseReviewPrArgs' own tests above prove the flag parses correctly; this
  // pins that reviewPR actually uses its result rather than a stray hardcoded
  // value — the exact regression this feature had until this task landed
  // ("Task 10 wires `/review-full` and `--full`; until either exists ... this is
  // always false").
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('forceFull comes from parseReviewPrArgs(args), not a hardcoded false', () => {
    expect(src).toMatch(/const \{[^}]*forceFull[^}]*\} = parseReviewPrArgs\(args\)/);
    expect(src).not.toMatch(/const forceFull = false;/);
  });

  test('forceFull reaches the chooseReviewPath call', () => {
    const callBlock = src.match(/chooseReviewPath\(\{([\s\S]*?)\}\)/);
    expect(callBlock).not.toBeNull();
    expect(callBlock![1]).toMatch(/\bforceFull\b/);
  });
});
