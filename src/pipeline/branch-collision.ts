import type { PipelineState } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Branch collision — stop before the coder writes code onto a name it cannot push
//
// Branch names are deterministic (`bug/#<id>-<slug>`, `userstory/#<id>-<slug>`,
// always from master), and nothing handled the branch already existing. What
// happens today, reproduced against a real remote:
//
//   $ git checkout -b 'bug/#123-fix'
//   Switched to a new branch 'bug/#123-fix'   <- succeeds, silently, from master
//   $ git push origin 'bug/#123-fix'
//   ! Updates were rejected because the tip of your current branch is behind
//
// The checkout succeeds, so the agent writes everything and only fails at push,
// after the spend — and the message points at a stale master rather than at a
// taken name. Worse, the slug comes from the work item title by way of the
// model, so a re-run can land on `bug/#123-fix-posting` instead and orphan the
// old branch with no error at all.
//
// This runs once before the coding loop's first attempt and answers three
// different questions that all look alike from the remote's side. Getting them
// confused is the whole risk: the remedy for one is destructive for another.
// ---------------------------------------------------------------------------

/** One branch on the remote, as `git ls-remote --heads` reports it. */
export interface RemoteBranch {
  sha: string;
  /** Short name, e.g. `bug/#123-fix` — `refs/heads/` stripped. */
  name: string;
}

export type CollisionKind =
  /** No changeset, and a branch for this work item exists that this run did not push. */
  | 'leftover'
  /** No changeset, and the branch is one THIS run pushed before a rewind to planning. */
  | 'replanned'
  /** A changeset names a branch, and the remote no longer has it. */
  | 'branch-gone';

export interface BranchCollision {
  kind: CollisionKind;
  branch: string;
  /** Absent for `branch-gone` — there is no remote tip to name. */
  sha?: string;
  /** Ready to post or throw: says what happened and what the human can do. */
  message: string;
}

/** Matches `bug/#123-slug` and bare `bug/#123`, and not `bug/#1234-slug`. */
export function branchBelongsToWorkItem(name: string, workItemId: number): boolean {
  return new RegExp(`^(bug|userstory)/#${workItemId}(-|$)`).test(name);
}

/**
 * Parse `git ls-remote --heads` output.
 *
 * Lines are `<sha>\t<ref>`. Anything that does not look like that is skipped
 * rather than throwing: this check must never be the reason a run dies.
 */
export function parseRemoteBranches(stdout: string): RemoteBranch[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split('\t');
      if (!sha || !ref) return null;
      return { sha, name: ref.replace(/^refs\/heads\//, '') };
    })
    .filter((b): b is RemoteBranch => b !== null);
}

/**
 * Is the coding loop starting from nothing, or resuming work it already did?
 *
 * `changeset.branchName` is the marker, and it survives every rewind that lands
 * BACK on coding — `/fix`, the `continue` tag, a resume after an error. It does
 * not survive a rewind to PLANNING, which clears the changeset deliberately.
 * That difference is why `priorBranches` exists.
 */
export function isFreshCodingStart(state: PipelineState): boolean {
  return !state.changeset?.branchName;
}

/**
 * Decide what the remote is telling us. Pure — all the judgement lives here.
 *
 * Returns null to proceed.
 */
export function classifyCollision(
  state: PipelineState,
  workItemId: number,
  remoteBranches: readonly RemoteBranch[],
): BranchCollision | null {
  const named = state.changeset?.branchName;

  if (named) {
    // Resuming. The branch it names should still be there.
    if (remoteBranches.some((b) => b.name === named)) return null;

    // It is not. Azure DevOps deletes the source branch when a pull request
    // completes (`deleteSourceBranch`), and `/fix` is armed at the pr-completed
    // checkpoint — so this is what a `/fix` on already-merged work looks like.
    // Left alone the coder is told to check out a branch that no longer exists.
    return {
      kind: 'branch-gone',
      branch: named,
      message:
        `The branch this run was working on, \`${named}\`, is no longer on the remote. ` +
        `The recorded changeset still points at it, so the coder would try to check out a branch that is gone.\n\n` +
        `The usual cause is that its pull request completed and the source branch was deleted with it. ` +
        `It can also mean the branch was removed by hand, or that an earlier run recorded the branch ` +
        `without managing to push it.\n\n` +
        `What you can do:\n` +
        `- If the work merged and this is a follow-up, re-tag the work item with \`analyse\` to start a fresh branch.\n` +
        `- If the branch was deleted by mistake, restore it from the pull request and add the \`continue\` tag.`,
    };
  }

  // Fresh start. Any branch for this work item is in the way.
  const inTheWay = remoteBranches.filter((b) => branchBelongsToWorkItem(b.name, workItemId));
  if (inTheWay.length === 0) return null;

  const ours = inTheWay.find((b) => state.priorBranches?.includes(b.name));
  if (ours) {
    // This run pushed it, then a rewind to planning threw the changeset away.
    // Telling the human to delete it would kill a pull request that is probably
    // still open, and telling them to "resume the existing work" contradicts the
    // replan they just asked for. Neither remedy from the leftover case applies.
    return {
      kind: 'replanned',
      branch: ours.name,
      sha: ours.sha,
      message:
        `This run already pushed \`${ours.name}\`, and the plan was then sent back for rework. ` +
        `The new plan needs a branch, and that name is taken by the old one.\n\n` +
        `The old branch is still on the remote, and any pull request opened from it is still open.\n\n` +
        `What you can do:\n` +
        `- Abandon the pull request and delete \`${ours.name}\`, then add the \`continue\` tag — the new plan gets the name.\n` +
        `- Rename \`${ours.name}\` to keep it for reference, then add the \`continue\` tag.\n` +
        `- If the replan was a mistake, the old branch already holds the previous attempt's work.`,
    };
  }

  const first = inTheWay[0]!;
  return {
    kind: 'leftover',
    branch: first.name,
    sha: first.sha,
    message:
      `\`${first.name}\` already exists on the remote (at \`${first.sha.slice(0, 8)}\`), ` +
      `and this run has no code of its own yet.\n\n` +
      `Left alone the coder would branch from master under that same name, write everything, and only ` +
      `fail at push — with a message about being "behind" that points at the wrong problem.\n\n` +
      `What you can do:\n` +
      `- Rename \`${first.name}\` to keep its history, then add the \`continue\` tag.\n` +
      `- Delete it if it holds nothing worth keeping, then add the \`continue\` tag.\n` +
      `- Or leave it alone and work from that branch by hand instead of re-running the pipeline.`,
  };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface GitRunResult {
  stdout: string;
  exitCode: number;
}

/** Runs `git` with an argument array. Replaceable so tests never spawn git. */
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

const defaultGitRunner: GitRunner = (args, cwd) => {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
};

/**
 * Ask the remote which branches exist for this work item, and classify.
 *
 * The argument array matters: branch names contain `#`, which a shell mangles.
 * Passing args directly removes the question — the same reason `branch-diff.ts`
 * exists.
 *
 * **Fails open, loudly.** If `git` itself errors, this returns null and the run
 * proceeds to the late failure we have today. Failing closed would block every
 * coding run whenever the remote hiccups, which is a worse outage than the one
 * being prevented. But the swallow is logged: this codebase has already lost
 * ~36 agent-hours to a guard that silently did nothing.
 */
export function detectBranchCollision(
  state: PipelineState,
  workItemId: number,
  repoDir: string,
  log?: (message: string) => void,
  run: GitRunner = defaultGitRunner,
): BranchCollision | null {
  let result: GitRunResult;
  try {
    result = run(
      [
        'ls-remote', '--heads', 'origin',
        `refs/heads/bug/#${workItemId}-*`,
        `refs/heads/bug/#${workItemId}`,
        `refs/heads/userstory/#${workItemId}-*`,
        `refs/heads/userstory/#${workItemId}`,
      ],
      repoDir,
    );
  } catch (err) {
    log?.(`[branch-check] could not reach the remote, skipping: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Exit 0 with no output is a real answer — no such branch — not a failure.
  // Only a non-zero exit means we did not find out.
  if (result.exitCode !== 0) {
    log?.(`[branch-check] git ls-remote exited ${result.exitCode}, skipping the branch check`);
    return null;
  }

  const named = state.changeset?.branchName;
  const remote = parseRemoteBranches(result.stdout);

  // The resume case asks about one specific branch, which the work-item globs
  // above will not match if its slug was written differently. Ask for it by name.
  if (named && !remote.some((b) => b.name === named)) {
    let exact: GitRunResult;
    try {
      exact = run(['ls-remote', '--heads', 'origin', `refs/heads/${named}`], repoDir);
    } catch {
      return null;
    }
    if (exact.exitCode !== 0) return null;
    remote.push(...parseRemoteBranches(exact.stdout));
  }

  return classifyCollision(state, workItemId, remote);
}
