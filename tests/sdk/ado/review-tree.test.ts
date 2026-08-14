import { describe, test, expect } from 'bun:test';
import { reviewTreeCandidates } from '../../../src/sdk/ado/review-tree.ts';
import type { PRMetadata } from '../../../src/sdk/ado/pull-requests.ts';

// ---------------------------------------------------------------------------
// Why this exists
//
// The full review path never checked out the PR: the only `checkoutBranch` call
// was guarded by `if (route.path === 'sanity')`. Agents are nonetheless told the
// clone at the cwd is where to read a callee's real behaviour. Measured over 14
// days: 49.7% of reviews target a branch other than the repo default, and of 18
// files actually read from the clone during such reviews, 12 held different
// content than the PR's line — 1,491 lines against 1,326 in one case, and in
// another 460 against 460 with the content still different.
//
// The first fix for that returned ONE choice. Its top rung (the merge preview)
// lives on a ref no clone fetches, so the checkout failed and the wiring had
// nothing to descend to — the tree stayed on the default branch and a real
// acceptance run recorded exactly that. Hence a ladder: this returns every rung,
// in order, and the caller walks it.
//
// These are pure ordering tests. The WALK is pinned separately, against a real
// clone, in review-tree-checkout.test.ts — because nine green tests of this
// shape sat beside a dead feature once already.
// ---------------------------------------------------------------------------

const base: PRMetadata = {
  title: 't',
  description: 'd',
  sourceBranch: 'refs/heads/bug/123',
  targetBranch: 'refs/heads/release/27.x',
};

describe('reviewTreeCandidates', () => {
  test('returns the FULL ladder in order when everything is known — not just the top rung', () => {
    // The shape the failed acceptance run had: active PR, merge succeeded, so all
    // three rungs exist. Returning only the first is what made the fix inert.
    expect(reviewTreeCandidates({ ...base, lastMergeCommit: 'aaa', lastMergeSourceCommit: 'bbb' }))
      .toEqual([
        { kind: 'merge-preview', sha: 'aaa' },
        { kind: 'source-head', sha: 'bbb' },
        { kind: 'target-tip', branch: 'release/27.x' },
      ]);
  });

  test('omits the merge preview when the merge conflicts', () => {
    // Measured live: an active PR with mergeStatus `conflicts` carries no
    // lastMergeCommit, while one with `succeeded` does.
    expect(reviewTreeCandidates({ ...base, mergeStatus: 'conflicts', lastMergeSourceCommit: 'bbb' }))
      .toEqual([
        { kind: 'source-head', sha: 'bbb' },
        { kind: 'target-tip', branch: 'release/27.x' },
      ]);
  });

  test('the floor is the target tip, never the repo default', () => {
    // Falling back to the default branch would reproduce the very defect this
    // exists to fix. The tip needs no fetch, exists for every PR, and on files
    // the PR does not touch it equals the merge preview by definition of a merge.
    expect(reviewTreeCandidates(base)).toEqual([{ kind: 'target-tip', branch: 'release/27.x' }]);
  });

  test('strips refs/heads/ from the target branch', () => {
    expect(reviewTreeCandidates({ ...base, targetBranch: 'refs/heads/development/26.x' }))
      .toEqual([{ kind: 'target-tip', branch: 'development/26.x' }]);
  });

  test('no metadata means no rungs', () => {
    expect(reviewTreeCandidates(undefined)).toEqual([]);
  });

  test('drops a target branch git would read as a flag, but keeps the commit rungs', () => {
    // git 2.39.5 has no --end-of-options on checkout; checkoutBranch refuses the
    // same shape. Dropping the branch must not discard the usable rungs above it.
    expect(reviewTreeCandidates({ ...base, targetBranch: 'refs/heads/-oops', lastMergeCommit: 'aaa' }))
      .toEqual([{ kind: 'merge-preview', sha: 'aaa' }]);
  });

  test('neither commit nor a usable branch means no rungs', () => {
    expect(reviewTreeCandidates({ ...base, targetBranch: '' })).toEqual([]);
  });
});
