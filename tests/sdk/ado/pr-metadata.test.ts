import { describe, test, expect, mock, afterEach } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  fetchPRMetadata,
  fetchPRIterationCommits,
  fetchPRDiffCommits,
  fetchPRDiff,
} from '../../../src/sdk/ado/pull-requests.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'p', repositoryId: 'r', pat: 'x' },
} as any;

describe('fetchPRMetadata', () => {
  test('returns the fields cherry-pick detection and staleness need', async () => {
    let url: string | undefined;
    globalThis.fetch = mock((u: string) => {
      url = u;
      return Promise.resolve(new Response(JSON.stringify({
        title: 'Bug #80692: Skip DO app registration',
        description: 'Cherry picked from !52117',
        sourceRefName: 'refs/heads/bug/x-on-hotfix-28.3.2',
        targetRefName: 'refs/heads/hotfix/28.3.2',
        lastMergeSourceCommit: { commitId: 'aaa' },
        lastMergeTargetCommit: { commitId: 'bbb' },
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const m = await fetchPRMetadata(52307, config);

    expect(url).toContain('/pullrequests/52307?api-version=7.0');
    expect(m.title).toBe('Bug #80692: Skip DO app registration');
    expect(m.description).toBe('Cherry picked from !52117');
    expect(m.sourceBranch).toBe('refs/heads/bug/x-on-hotfix-28.3.2');
    expect(m.targetBranch).toBe('refs/heads/hotfix/28.3.2');
    expect(m.lastMergeSourceCommit).toBe('aaa');
    expect(m.lastMergeTargetCommit).toBe('bbb');
  });

  test('tolerates a PR with no description', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      title: 't', sourceRefName: 's', targetRefName: 'g',
    }), { status: 200 }))) as unknown as typeof fetch;

    const m = await fetchPRMetadata(1, config);
    expect(m.description).toBe('');
  });
});

// ---------------------------------------------------------------------------
// fetchPRIterationCommits
//
// This replaces a test that asserted `fetchPRDiff` requested
// `/pullrequests/{id}/changes` and hand-wrote a `{files:[{path,patch}]}` reply.
// That endpoint does not exist — probed live, it answers 404 with an ASP.NET
// "controller not found" page — and the shape it invented was the ADO **MCP
// server's** composition, never an API response. A mocked `fetch` confirmed the
// request against its own imagined reply and so pinned the bug in place through
// nine reviews. The lesson, worth more than the test: a mock is evidence about
// OUR parsing, never about whether an endpoint exists.
//
// So the mock below is deliberately narrow. It stands in only for the parsing,
// and the response SHAPE and field names are transcribed from a live probe of
// PR 52117 (2 iterations, `commonRefCommit` a5d7a9ad…, `sourceRefCommit`
// f729c8fe… on the newest), which returned 200. The shas are padded to full
// length for realism; this function does not inspect their form.
// ---------------------------------------------------------------------------

const iteration = (id: number, common: string, source: string) => ({
  id,
  commonRefCommit: { commitId: common },
  sourceRefCommit: { commitId: source },
  targetRefCommit: { commitId: common },
});

const A5 = 'a5d7a9ad00000000000000000000000000000000';
const FD = 'fdd3651c00000000000000000000000000000000';
const F7 = 'f729c8fe00000000000000000000000000000000';

describe('fetchPRIterationCommits', () => {
  test('reads the newest iteration from the endpoint that actually exists', async () => {
    let url: string | undefined;
    globalThis.fetch = mock((u: string) => {
      url = u;
      return Promise.resolve(new Response(JSON.stringify({
        count: 2,
        value: [iteration(1, A5, FD), iteration(2, A5, F7)],
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);

    // The URL a live probe answered 200 on — not the 404 one this replaced.
    expect(url).toContain('/pullrequests/52117/iterations?api-version=7.0');
    expect(url).not.toContain('/changes');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commits).toEqual({ base: A5, head: F7 });
  });

  test('selects by max id, not by array position', async () => {
    // The API returns them ascending today and nothing documents that it must.
    // Diffing against a superseded push would look entirely plausible in the
    // output, so the selection must not depend on the order.
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      value: [iteration(2, A5, F7), iteration(1, A5, FD)],
    }), { status: 200 }))) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commits.head).toBe(F7);
  });

  test('a 404 is the only failure reported as "the PR is missing"', async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response('{"message":"nope"}', { status: 404, statusText: 'Not Found' }),
    )) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(999999, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prMissing).toBe(true);
  });

  test('a 500 is NOT reported as a missing PR — the regression that hid this bug', async () => {
    // The whole class of bug: every failure used to collapse into `sourcePrExists
    // = false`, whose route reason reads "source PR !<id> not found in this
    // repository". A server error, an auth failure and a dead endpoint all
    // produced that same confident, unfalsifiable sentence in `review_path`.
    globalThis.fetch = mock(() => Promise.resolve(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    )) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.prMissing).toBe(false);
      expect(r.error).toContain('500');
    }
  });

  test('a network failure returns a result rather than throwing', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.prMissing).toBe(false);
      expect(r.error).toContain('ECONNRESET');
    }
  });

  test('reports a PR with no iterations instead of guessing commits', async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response(JSON.stringify({ count: 0, value: [] }), { status: 200 }),
    )) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prMissing).toBe(false);
  });

  test('reports an iteration missing either commit rather than returning undefined', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      value: [{ id: 1, commonRefCommit: { commitId: A5 } }],
    }), { status: 200 }))) as unknown as typeof fetch;

    const r = await fetchPRIterationCommits(52117, config);
    expect(r.ok).toBe(false);
  });
});

describe('fetchPRDiffCommits picks the pair the clone can actually reach', () => {
  // Measured against the live instance, and the reason this function exists at all:
  //
  //  * `refs/pull/<id>/merge` is retained only while a PR is ACTIVE — 4/4 active PRs
  //    had one, 2/2 completed did not, 11 in the whole repository.
  //  * In a FULL clone (what the container makes), both completed PRs of a real
  //    backport pair had their `sourceRefCommit` MISSING and their merge commit
  //    present. The iteration pair is therefore undiffable for a completed PR, and
  //    no fetch recovers it.
  //  * `lastMergeTargetCommit..lastMergeCommit` was verified content-identical, via
  //    `compareDiffs`, to the PR's own `commonRefCommit..sourceRefCommit` diff.
  //
  // An earlier revision of this fix used iterations unconditionally. It passed every
  // test and worked in a `--filter=blob:none` probe clone — which can lazily fetch
  // ANY object by sha — and would have failed on every completed source PR in
  // production. Hence: these two branches, and a test for each.

  const prBody = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    status,
    lastMergeCommit: { commitId: 'aa4ec8c1000000000000000000000000000000ff' },
    lastMergeTargetCommit: { commitId: 'f7374c64000000000000000000000000000000ff' },
    ...extra,
  });

  /** Answers the PR endpoint one way and the iterations endpoint another. */
  const routeFetch = (prJson: string) => {
    const seen: string[] = [];
    globalThis.fetch = mock((u: string) => {
      seen.push(u);
      const body = u.includes('/iterations')
        ? JSON.stringify({ value: [iteration(1, A5, F7)] })
        : prJson;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    return seen;
  };

  test('a COMPLETED PR is diffed across its merge commit, which lives on the target branch', async () => {
    const seen = routeFetch(prBody('completed'));
    const r = await fetchPRDiffCommits(52117, config);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.commits.via).toBe('merge-commit');
      expect(r.commits.base).toBe('f7374c64000000000000000000000000000000ff');
      expect(r.commits.head).toBe('aa4ec8c1000000000000000000000000000000ff');
    }
    // And it does not pay for an iterations round-trip it cannot use.
    expect(seen.some((u) => u.includes('/iterations'))).toBe(false);
  });

  test('an ACTIVE PR uses its iteration pair — there is no final merge commit yet', async () => {
    routeFetch(prBody('active'));
    const r = await fetchPRDiffCommits(52110, config);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.commits.via).toBe('iteration');
      expect(r.commits).toMatchObject({ base: A5, head: F7 });
    }
  });

  test('a completed PR with no merge commit recorded falls back rather than inventing one', async () => {
    routeFetch(JSON.stringify({ status: 'completed' }));
    const r = await fetchPRDiffCommits(52117, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commits.via).toBe('iteration');
  });

  test('an abandoned PR is not treated as completed', async () => {
    routeFetch(prBody('abandoned'));
    const r = await fetchPRDiffCommits(52117, config);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commits.via).toBe('iteration');
  });

  test('a 404 on the PR itself is still the only "missing" signal', async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response('{}', { status: 404, statusText: 'Not Found' }),
    )) as unknown as typeof fetch;

    const r = await fetchPRDiffCommits(999999, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prMissing).toBe(true);
  });

  test('a 500 on the PR itself is not reported as missing', async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    )) as unknown as typeof fetch;

    const r = await fetchPRDiffCommits(52117, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.prMissing).toBe(false);
  });
});

describe('fetchPRDiff error shape', () => {
  test('a git-side failure names its route, and says the clone is broken rather than blaming ADO', async () => {
    // Two fixes in one assertion, because they meet here:
    //  * the ` (via <route>)` suffix must be present and intact — it is the token
    //    that says WHICH commit-selection route failed;
    //  * a bad `repoDir` must not surface as "commit(s) not present in the clone",
    //    which would send a human hunting for commits in Azure DevOps.
    globalThis.fetch = mock((u: string) => Promise.resolve(new Response(
      u.includes('/iterations')
        ? JSON.stringify({ value: [iteration(1, A5, F7)] })
        : JSON.stringify({ status: 'active' }),
      { status: 200 },
    ))) as unknown as typeof fetch;

    const r = await fetchPRDiff(52110, join(tmpdir(), 'not-a-repo-at-all'), config);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('(via iteration)');
      expect(r.error).not.toContain('not present in the clone');
      expect(r.prMissing).toBe(false);
    }
  });

  test('an ADO-side failure is capped so it cannot flood review_path', async () => {
    globalThis.fetch = mock(() => Promise.resolve(
      new Response('x'.repeat(5000), { status: 500, statusText: 'Internal Server Error' }),
    )) as unknown as typeof fetch;

    const r = await fetchPRDiff(52117, tmpdir(), config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThanOrEqual(161);
  });
});

describe('the dead endpoint stays dead', () => {
  test('nothing under src/sdk/ requests /pullrequests/{id}/changes', () => {
    // Probed live: `/pullrequests/52117/changes` -> 404 (an ASP.NET "controller not
    // found" page — the route does not exist), `/iterations` -> 200. Azure DevOps
    // REST serves no unified diffs at all, so any reappearance of this path is the
    // same bug returning, and its only symptom is a review that silently costs full
    // price while `review_path` records a plausible lie.
    //
    // Matched as a PATTERN over the whole directory, not the literal
    // `'/changes?api-version'` in one file: a different query-parameter order, or
    // the URL reappearing in a sibling module, would walk straight past a
    // string-equality check on `pull-requests.ts` alone.
    const dir = fileURLToPath(new URL('../../../src/sdk/', import.meta.url));
    const dead = /pullrequests\/[^'"`\s]*\/changes/;

    // Comments are stripped first: both `pull-requests.ts` and `git-diff.ts`
    // deliberately NAME the dead endpoint in prose to explain why it is gone, and a
    // guard that fires on its own documentation would only teach people to delete
    // the explanation. `(^|[^:])` keeps `https://` from being read as a comment.
    const codeOnly = (s: string): string => s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && dead.test(codeOnly(readFileSync(full, 'utf-8')))) {
          offenders.push(full);
        }
      }
    };
    walk(dir);

    expect(offenders).toEqual([]);

    // The guard must be able to FAIL — a comment-stripper that ate everything would
    // pass this test forever while checking nothing.
    expect(dead.test(codeOnly('const u = `x/pullrequests/${id}/changes?api-version=7.0`;'))).toBe(true);
    expect(dead.test(codeOnly('// pullrequests/{id}/changes is dead'))).toBe(false);
  });
});
