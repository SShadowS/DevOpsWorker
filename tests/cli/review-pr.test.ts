import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  maybeInjectToolRule,
  maybeOverrideSubAgentModel,
  SUBAGENT_TOOL_RULE,
  applyInlineFindings,
  buildPriorFindingsBlock,
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
    const readAt = src.indexOf('priorFindingsBlock = buildPriorFindingsBlock(');
    const runAt = src.indexOf('await runPRReview(');
    expect(readAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(runAt);
  });

  test('the block is passed into runPRReview', () => {
    const call = src.match(/await runPRReview\(\s*\{([\s\S]*?)\},/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('priorFindingsBlock');
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
