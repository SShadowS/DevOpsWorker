import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkoutReviewTree } from '../../../src/sdk/ado/review-tree.ts';
import type { PRMetadata } from '../../../src/sdk/ado/pull-requests.ts';

// ---------------------------------------------------------------------------
// Why this exists
//
// The first attempt at this feature shipped with nine green tests beside a dead
// feature. Every one of them exercised the pure selector; none touched a clone.
// The acceptance run then chose the merge preview, whose object lives only on
// `refs/pull/<id>/merge` — a ref no clone fetches — and the wiring gave up
// instead of fetching or descending. The tree stayed on the default branch.
//
// These tests pin the WALK against a real clone: a rung whose object is absent
// must be recovered by fetch or fallen through, and the result must name the
// rung that actually won. Test 1 fails against that shipped code by
// construction.
// ---------------------------------------------------------------------------

const PR_ID = 77;
let work: string;         // repo the fixture is built in
let bareOrigin: string;   // origin with refs/pull/77/merge parked
let bareNoSource: string; // origin where the source branch is gone; head only on refs/pull/77/head
let shaMerge = '';        // merge of source into target — reachable ONLY via refs/pull/77/merge
let shaSource = '';       // the PR head
let shaNowhere = '';      // a real commit present in NO origin and NO clone (stale-preview shape)
const clones: string[] = [];

async function run(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

/**
 * A fresh clone per test — the walker moves HEAD, so tests must not share a tree.
 *
 * `--no-local` is load-bearing, not noise. Cloning a local PATH normally hardlinks
 * the ENTIRE object database across, unreferenced objects included, so the parked
 * `refs/pull` commit would arrive anyway and the recovery tests would pass without
 * the recovery ever running. Same reasoning as `tests/sdk/git-diff.test.ts`.
 */
async function cloneFrom(origin: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'review-tree-clone-'));
  const p = Bun.spawn(
    ['git', 'clone', '--quiet', '--no-local', '--branch', 'main', origin, dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await p.exited;
  clones.push(dir);
  return dir;
}

const meta = (over: Partial<PRMetadata> = {}): PRMetadata => ({
  title: 't',
  description: 'd',
  sourceBranch: 'refs/heads/feature/pr-code',
  targetBranch: 'refs/heads/release/27.x',
  ...over,
});

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'review-tree-work-'));
  await run(work, 'init', '-b', 'main');
  await run(work, 'config', 'user.email', 't@t');
  await run(work, 'config', 'user.name', 't');

  writeFileSync(join(work, 'base.txt'), 'base\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'A');

  // release/27.x forks from A; the PR branch forks from the release line.
  await run(work, 'checkout', '--quiet', '-b', 'release/27.x');
  writeFileSync(join(work, 'release-marker.txt'), 'release line\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'R1');
  await run(work, 'checkout', '--quiet', '-b', 'feature/pr-code');
  writeFileSync(join(work, 'pr-change.txt'), 'the PR change\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'S');
  shaSource = await run(work, 'rev-parse', 'HEAD');

  // The target moves on after the fork. `target-only.txt` is what discriminates
  // the merge preview and the target tip from the source head.
  await run(work, 'checkout', '--quiet', 'release/27.x');
  writeFileSync(join(work, 'target-only.txt'), 'later target work\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'R2');

  // The merge preview: source merged into target, left on no branch at all —
  // exactly what Azure DevOps parks at refs/pull/<id>/merge.
  await run(work, 'checkout', '--quiet', '-b', 'tmp-merge');
  await run(work, 'merge', '--no-ff', '--no-edit', 'feature/pr-code');
  shaMerge = await run(work, 'rev-parse', 'HEAD');
  await run(work, 'checkout', '--quiet', 'main');
  await run(work, 'branch', '-D', 'tmp-merge');

  // A real commit that will exist nowhere reachable: the stale-preview shape,
  // where the metadata names a preview the ref no longer holds.
  await run(work, 'checkout', '--quiet', '-b', 'tmp-nowhere');
  writeFileSync(join(work, 'nowhere.txt'), 'never pushed\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'nowhere');
  shaNowhere = await run(work, 'rev-parse', 'HEAD');
  await run(work, 'checkout', '--quiet', 'main');
  await run(work, 'branch', '-D', 'tmp-nowhere');

  // main moves too, so the default tip is discriminable.
  writeFileSync(join(work, 'main-only.txt'), 'default line only\n');
  await run(work, 'add', '.'); await run(work, 'commit', '-m', 'main-only');

  // Origin 1 — production shape: all branches, plus the preview under refs/pull.
  bareOrigin = mkdtempSync(join(tmpdir(), 'review-tree-origin-'));
  await run(work, 'init', '--bare', '-b', 'main', bareOrigin);
  await run(work, 'push', '--quiet', bareOrigin, 'main', 'release/27.x', 'feature/pr-code');
  await run(work, 'push', '--quiet', bareOrigin, `${shaMerge}:refs/pull/${PR_ID}/merge`);

  // Origin 2 — source branch deleted; its head survives only on refs/pull/77/head.
  bareNoSource = mkdtempSync(join(tmpdir(), 'review-tree-origin2-'));
  await run(work, 'init', '--bare', '-b', 'main', bareNoSource);
  await run(work, 'push', '--quiet', bareNoSource, 'main', 'release/27.x');
  await run(work, 'push', '--quiet', bareNoSource, `${shaSource}:refs/pull/${PR_ID}/head`);
});

afterAll(() => {
  for (const d of [work, bareOrigin, bareNoSource, ...clones]) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('checkoutReviewTree — the walk, against a real clone', () => {
  test('the regression: a preview absent from the clone but present on refs/pull is fetched, checked out and named', async () => {
    const clone = await cloneFrom(bareOrigin);

    // Assert the precondition honestly: without a fetch the object is NOT there.
    // If this ever passes, the fixture has stopped reproducing production and the
    // rest of this test proves nothing.
    const probe = Bun.spawn(['git', 'cat-file', '-e', `${shaMerge}^{commit}`], {
      cwd: clone, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await probe.exited).not.toBe(0);

    const r = await checkoutReviewTree(clone, PR_ID, meta({
      lastMergeCommit: shaMerge,
      lastMergeSourceCommit: shaSource,
    }));

    expect(r.source).toBe('merge-preview');
    expect(r.detail).toBe(shaMerge.slice(0, 12));
    // Verified by effect, not by the return value: the merged tree holds BOTH the
    // PR's change and the target's later work, and none of the default line's.
    expect(await run(clone, 'rev-parse', 'HEAD')).toBe(shaMerge);
    expect(existsSync(join(clone, 'pr-change.txt'))).toBe(true);
    expect(existsSync(join(clone, 'target-only.txt'))).toBe(true);
    expect(existsSync(join(clone, 'main-only.txt'))).toBe(false);
  });

  test('descends when the preview sha exists nowhere — a stale preview must not bind to whatever the ref now holds', async () => {
    const clone = await cloneFrom(bareOrigin);
    // The fetch of refs/pull/77/merge SUCCEEDS and brings a commit — just not the
    // one the metadata named. Azure DevOps recomputes previews, so the walker has
    // to re-test the specific sha rather than trust that the fetch helped.
    const r = await checkoutReviewTree(clone, PR_ID, meta({
      lastMergeCommit: shaNowhere,
      lastMergeSourceCommit: shaSource,
    }));

    expect(r.source).toBe('source-head');
    expect(await run(clone, 'rev-parse', 'HEAD')).toBe(shaSource);
    expect(existsSync(join(clone, 'pr-change.txt'))).toBe(true);
    // The source forked before R2, so the target's later work is absent — which is
    // the honest limitation of this rung, and worth pinning.
    expect(existsSync(join(clone, 'target-only.txt'))).toBe(false);
  });

  test('recovers a deleted source branch head via refs/pull/<id>/head', async () => {
    const clone = await cloneFrom(bareNoSource);
    const r = await checkoutReviewTree(clone, PR_ID, meta({ lastMergeSourceCommit: shaSource }));

    expect(r.source).toBe('source-head');
    expect(await run(clone, 'rev-parse', 'HEAD')).toBe(shaSource);
  });

  test('floor: neither commit resolvable lands on the target tip, attached to the branch', async () => {
    const clone = await cloneFrom(bareOrigin);
    const r = await checkoutReviewTree(clone, PR_ID, meta({ lastMergeCommit: shaNowhere }));

    expect(r.source).toBe('target-tip');
    expect(r.detail).toBe('release/27.x');
    expect(await run(clone, 'symbolic-ref', '--short', '-q', 'HEAD')).toBe('release/27.x');
    expect(existsSync(join(clone, 'target-only.txt'))).toBe(true);
    expect(existsSync(join(clone, 'pr-change.txt'))).toBe(false);
  });

  test('no metadata reports default-branch and leaves the tree untouched', async () => {
    const clone = await cloneFrom(bareOrigin);
    const r = await checkoutReviewTree(clone, PR_ID, undefined);

    expect(r).toEqual({ source: 'default-branch' });
    expect(await run(clone, 'symbolic-ref', '--short', '-q', 'HEAD')).toBe('main');
  });

  test('an unreachable origin never throws — the fetch fails and the ladder descends to what is local', async () => {
    const clone = await cloneFrom(bareOrigin);
    await run(clone, 'remote', 'set-url', 'origin', join(tmpdir(), 'does-not-exist-origin'));

    const r = await checkoutReviewTree(clone, PR_ID, meta({
      lastMergeCommit: shaMerge,
      lastMergeSourceCommit: shaSource,
    }));

    expect(r.source).toBe('source-head');
  });
});
