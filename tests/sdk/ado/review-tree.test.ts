import { describe, test, expect } from 'bun:test';
import { chooseReviewTree } from '../../../src/sdk/ado/review-tree.ts';
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
// This picks which commit the review tree should hold. It is pure so the ladder
// can be pinned without a clone, a container, or Azure DevOps.
// ---------------------------------------------------------------------------

const base: PRMetadata = {
  title: 't',
  description: 'd',
  sourceBranch: 'refs/heads/bug/123',
  targetBranch: 'refs/heads/release/27.x',
};

describe('chooseReviewTree', () => {
  test('prefers the merge preview — the PR merged into its target', () => {
    // What a reviewer actually reasons about, and on the PR's release line by
    // construction: unchanged files come from the target tip, changed ones from
    // the PR.
    expect(chooseReviewTree({ ...base, lastMergeCommit: 'aaa', lastMergeSourceCommit: 'bbb' }))
      .toEqual({ kind: 'merge-preview', sha: 'aaa' });
  });

  test('falls back to the PR head when the merge conflicts', () => {
    // Measured: an active PR with mergeStatus `conflicts` carries no
    // lastMergeCommit (PR 52109), while an active PR with `succeeded` does
    // (PR 53254). So this rung is reached in practice, not just in theory.
    expect(chooseReviewTree({ ...base, mergeStatus: 'conflicts', lastMergeSourceCommit: 'bbb' }))
      .toEqual({ kind: 'source-head', sha: 'bbb' });
  });

  test('falls back to the target tip when neither commit is known', () => {
    // The floor is the target branch, NOT the repo default. The default branch is
    // the thing being fixed: falling back to it would reproduce the defect on the
    // half of reviews that target another line. The target tip needs no fetch, is
    // present for every PR, and equals the merge preview on files the PR does not
    // touch — which is where the measured damage was.
    expect(chooseReviewTree(base)).toEqual({ kind: 'target-tip', branch: 'release/27.x' });
  });

  test('strips refs/heads/ from the target branch', () => {
    const got = chooseReviewTree({ ...base, targetBranch: 'refs/heads/development/26.x' });
    expect(got).toEqual({ kind: 'target-tip', branch: 'development/26.x' });
  });

  test('gives up when there is no metadata at all', () => {
    expect(chooseReviewTree(undefined)).toEqual({ kind: 'none' });
  });

  test('gives up when metadata carries neither a commit nor a target branch', () => {
    expect(chooseReviewTree({ ...base, targetBranch: '' })).toEqual({ kind: 'none' });
  });

  test('a merge preview wins even when a target branch is also available', () => {
    // Ordering matters: the tip alone would answer unchanged-file callees
    // correctly but would miss the PR's own changes entirely.
    const got = chooseReviewTree({ ...base, lastMergeCommit: 'aaa' });
    expect(got).toEqual({ kind: 'merge-preview', sha: 'aaa' });
  });

  test('the PR head wins over the target tip', () => {
    const got = chooseReviewTree({ ...base, lastMergeSourceCommit: 'bbb' });
    expect(got).toEqual({ kind: 'source-head', sha: 'bbb' });
  });

  test('refuses a target branch that git would read as a flag', () => {
    // `checkoutBranch` rejects the same shape; the container ships git 2.39.5,
    // which does not support `--end-of-options` on checkout.
    expect(chooseReviewTree({ ...base, targetBranch: 'refs/heads/-oops' })).toEqual({ kind: 'none' });
  });
});
