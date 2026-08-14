import type { PRMetadata } from './pull-requests.ts';
import { checkoutBranch, checkoutSha } from '../git-checkout.ts';
import { recoverFromRef } from '../git-diff.ts';

/**
 * One rung of the ladder a full review may check out.
 *
 * `target-tip` names a branch rather than a sha because the target branch is
 * already in the clone — no fetch needed — while the two commit rungs generally
 * are not.
 */
export type ReviewTreeCandidate =
  | { kind: 'merge-preview'; sha: string }
  | { kind: 'source-head'; sha: string }
  | { kind: 'target-tip'; branch: string };

/**
 * The rungs a full review may check out, best first.
 *
 * The full path historically checked out nothing, leaving the clone on the repo
 * registry's DEFAULT branch while telling agents that clone is where to read a
 * called procedure's real behaviour (`calleeGuide`). Half of all PRs target a
 * different release line, so half of all reviews resolved callees against code
 * from another line — and, in the words of the comment on the fix that was
 * applied to the backport path, that "would answer from a different release line
 * and look verified".
 *
 * **The caller WALKS this list until one lands.** Returning a single choice is
 * the bug that shipped in `c11dcf4`: the merge preview lives on
 * `refs/pull/<id>/merge`, which no clone fetches, so one pick with no descent
 * left the tree on the default branch — and a real acceptance run recorded
 * exactly that, on the very image carrying the fix.
 *
 * The ladder, in order:
 *
 * 1. `lastMergeCommit` — Azure DevOps' merge preview, the PR merged into its
 *    target. Measured live: present on an ACTIVE PR when `mergeStatus` is
 *    `succeeded`, absent when it is `conflicts`.
 * 2. `lastMergeSourceCommit` — the PR head, when no preview exists.
 * 3. The target branch tip. This is the floor, and it is deliberately NOT the
 *    repo default: falling back to the default reproduces the defect being
 *    fixed. The tip needs no fetch, exists for every PR including completed
 *    ones, and on files the PR does not touch it is identical to the merge
 *    preview by definition of a merge — and unchanged files are where the
 *    measured damage was.
 *
 * The chosen tree supplies CALLEE CONTEXT only. Finding line numbers and the
 * `replacesText` a suggested fix quotes continue to come from the source-branch
 * fetch, because the orchestrator requires right-side line numbers and
 * `resolveSuggestion` verifies against `lastMergeSourceCommit`. Deriving those
 * from the preview would drift wherever the target also touched the same file,
 * silently dropping suggestions and misplacing inline anchors.
 */
export function reviewTreeCandidates(meta: PRMetadata | undefined): ReviewTreeCandidate[] {
  if (!meta) return [];

  const rungs: ReviewTreeCandidate[] = [];
  if (meta.lastMergeCommit) rungs.push({ kind: 'merge-preview', sha: meta.lastMergeCommit });
  if (meta.lastMergeSourceCommit) rungs.push({ kind: 'source-head', sha: meta.lastMergeSourceCommit });

  const branch = (meta.targetBranch ?? '').replace(/^refs\/heads\//, '');
  // A leading `-` is read as a flag by `git checkout`, and the container's git
  // 2.39.5 does not support `--end-of-options` there — `checkoutBranch` rejects
  // the same shape for the same reason. Dropping an unusable branch must not
  // discard the commit rungs above it.
  if (branch && !branch.startsWith('-')) rungs.push({ kind: 'target-tip', branch });

  return rungs;
}

export type ReviewTreeSource = ReviewTreeCandidate['kind'] | 'default-branch';

export interface ReviewTreeResult {
  source: ReviewTreeSource;
  /** What won: the commit's first 12 hex chars, or the branch name. Absent for `default-branch`. */
  detail?: string;
}

/**
 * Which refs can recover a rung's missing object.
 *
 * The merge preview exists only at `refs/pull/<id>/merge`. For the source head the
 * direct ref is `/head`, with `/merge` as a second chance: the merge commit's
 * second parent IS the source head, so fetching it carries the head object along.
 *
 * Both are open-PR only — this instance retains `refs/pull/*` while a PR is open
 * and drops it on completion (measured: 4/4 active PRs had it, 2/2 completed did
 * not). A completed PR reaches its code through the other rungs instead: its
 * `lastMergeCommit` is a real commit on the target branch and is already cloned.
 */
const RECOVERY_REFS: Record<'merge-preview' | 'source-head', (prId: number) => string[]> = {
  'merge-preview': (id) => [`refs/pull/${id}/merge`],
  'source-head': (id) => [`refs/pull/${id}/head`, `refs/pull/${id}/merge`],
};

/**
 * Walk the ladder until a rung lands, fetching a missing object from
 * `refs/pull/*` before giving up on that rung.
 *
 * This is the piece `c11dcf4` lacked. It picked the top rung, whose object no
 * clone fetches, and stopped — nine green selector tests beside a dead feature,
 * and an acceptance run that recorded the default branch on the very image
 * carrying the fix.
 *
 * After a fetch the SPECIFIC sha is re-tested, because Azure DevOps recomputes
 * previews and the ref may hold a newer commit than the metadata named. That
 * shape descends rather than binding to the wrong tree.
 *
 * Never throws — same contract as `git-checkout.ts`. A `default-branch` result
 * means the tree was left where the entrypoint's clone put it, and the CALLER is
 * responsible for saying so to the agent: the prompt must not claim the PR's code
 * over a default-branch tree.
 */
export async function checkoutReviewTree(
  cwd: string,
  prId: number,
  meta: PRMetadata | undefined,
): Promise<ReviewTreeResult> {
  for (const candidate of reviewTreeCandidates(meta)) {
    if (candidate.kind === 'target-tip') {
      const co = await checkoutBranch(cwd, candidate.branch);
      if (co.ok) {
        console.log(`[review-tree] checked out target-tip (${candidate.branch})`);
        return { source: 'target-tip', detail: candidate.branch };
      }
      console.log(`[review-tree] target-tip ${candidate.branch} failed (${co.error}) — trying the next rung`);
      continue;
    }

    let co = await checkoutSha(cwd, candidate.sha);
    if (!co.ok) {
      for (const ref of RECOVERY_REFS[candidate.kind](prId)) {
        await recoverFromRef(cwd, ref);
        co = await checkoutSha(cwd, candidate.sha);
        if (co.ok) break;
      }
    }
    if (co.ok) {
      console.log(`[review-tree] checked out ${candidate.kind} (${candidate.sha.slice(0, 12)})`);
      return { source: candidate.kind, detail: candidate.sha.slice(0, 12) };
    }
    console.log(
      `[review-tree] ${candidate.kind} ${candidate.sha.slice(0, 12)} is not in the clone ` +
      `and could not be fetched — trying the next rung`,
    );
  }

  console.log('[review-tree] no usable tree — the clone stays on the default branch');
  return { source: 'default-branch' };
}

/**
 * Transitional shim — `review-pr.ts` still imports this until the rewiring lands,
 * at which point both this and the type below are deleted.
 */
export type ReviewTreeChoice = ReviewTreeCandidate | { kind: 'none' };
export function chooseReviewTree(meta: PRMetadata | undefined): ReviewTreeChoice {
  return reviewTreeCandidates(meta)[0] ?? { kind: 'none' };
}
