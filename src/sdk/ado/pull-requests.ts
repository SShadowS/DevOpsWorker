import type { PipelineConfig } from '../../types/pipeline.types.ts';
import { adoFetch, AzureDevOpsError } from './http.ts';
import { diffCommits } from '../git-diff.ts';
import type { FileDiff } from './backport.ts';

// ---------------------------------------------------------------------------
// Private response types
// ---------------------------------------------------------------------------

interface PullRequestResponse {
  pullRequestId: number;
  isDraft: boolean;
  status: string; // 'active' | 'completed' | 'abandoned'
}

interface PRComment {
  id: number;
  content?: string;
  publishedDate: string;
  author?: { displayName: string; uniqueName: string };
  commentType?: string;
}

interface PRThread {
  id: number;
  comments: PRComment[];
  publishedDate: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
}

interface PRThreadsResponse {
  value: PRThread[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a pull request has been published (isDraft → false).
 */
export async function checkPullRequestPublished(
  prId: number,
  config: PipelineConfig,
): Promise<boolean> {
  const pr = await adoFetch<PullRequestResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
  );
  return !pr.isDraft;
}

/**
 * Check if a pull request is still active (not completed or abandoned).
 * Returns the PR status string, or null if the PR cannot be fetched.
 */
export async function getPullRequestStatus(
  prId: number,
  config: PipelineConfig,
): Promise<{ status: string; isDraft: boolean } | null> {
  try {
    const pr = await adoFetch<PullRequestResponse>(
      config.azureDevOps,
      `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
    );
    return { status: pr.status, isDraft: pr.isDraft };
  } catch {
    return null;
  }
}

/**
 * Scan pull request thread comments for a /rerun-* command.
 * Returns the comment text (as feedback) if found, null otherwise.
 */
export async function findRerunCommandInPRComments(
  prId: number,
  command: string,
  config: PipelineConfig,
  since?: string,
): Promise<string | null> {
  const response = await adoFetch<PRThreadsResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
  );

  // Flatten all comments from all threads, newest-first
  const allComments: PRComment[] = [];
  for (const thread of response.value) {
    for (const comment of thread.comments) {
      // commentType "text" = human comment; skip "system" (vote/ref/status changes have no content)
      if (comment.commentType != null && comment.commentType !== 'text') continue;
      if (comment.content == null) continue;
      allComments.push(comment);
    }
  }
  allComments.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));

  for (const comment of allComments) {
    if (since && comment.publishedDate <= since) continue;
    const commandRegex = new RegExp(`(?:^|\\n)\\s*${command.replace('/', '\\/')}`, 'm');
    const plainText = comment.content!.replace(/<[^>]+>/g, '').trim();
    if (commandRegex.test(plainText)) {
      return plainText;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PR review comment types (public — used by learn-rules CLI)
// ---------------------------------------------------------------------------

export interface PRReviewComment {
  threadId: number;
  commentId: number;
  author: string;
  content: string;
  publishedDate: string;
  filePath?: string;
  line?: number;
}

/**
 * Fetch all human review comments from a pull request.
 * Filters out system-generated comments (commentType !== "text").
 */
export async function fetchPRReviewComments(
  prId: number,
  config: PipelineConfig,
): Promise<PRReviewComment[]> {
  const response = await adoFetch<PRThreadsResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
  );

  const comments: PRReviewComment[] = [];
  for (const thread of response.value) {
    for (const comment of thread.comments) {
      // commentType "text" = human comment, skip "system" and other types
      if (comment.commentType != null && comment.commentType !== 'text') continue;
      if (comment.content == null) continue;
      comments.push({
        threadId: thread.id,
        commentId: comment.id,
        author: comment.author?.displayName ?? 'Unknown',
        content: comment.content.replace(/<[^>]+>/g, '').trim(),
        publishedDate: comment.publishedDate,
        filePath: thread.threadContext?.filePath,
        line: thread.threadContext?.rightFileEnd?.line
          ?? thread.threadContext?.rightFileStart?.line,
      });
    }
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Raw thread reader (public — feeds finding reconciliation, markup intact)
// ---------------------------------------------------------------------------

export interface ReviewThread {
  id: number;
  firstCommentId: number;
  /** FIRST comment's body with markup INTACT — this is where the marker lives. */
  rawContent: string;
  /**
   * True when the newest comment on the thread is already a "not detected" notice.
   * Without this the reconciler cannot tell a thread it has already marked stale
   * from a fresh one, and appends another notice on every subsequent review.
   */
  lastCommentIsStaleNotice: boolean;
  filePath?: string;
  line?: number;
}

/** Prefix of the reply appended when a finding stops being raised. */
export const STALE_NOTICE_PREFIX = '_Not detected in review of ';

/**
 * Heading text of the pr-reviewer's own comments — the in-progress placeholder
 * ("## Code Review In Progress") and the final summary ("## Code Review — ..."),
 * both templated in `src/agents/pr-reviewer/CLAUDE.md`. Consumers that read PR
 * discussion (e.g. `private/scripts/sweep-outcomes.ts`,
 * `private/scripts/review-outcomes.ts`) match on `# ${BOT_SUMMARY_HEADING_TEXT}`
 * or `## ${BOT_SUMMARY_HEADING_TEXT}` to drop the bot's own comment out of the
 * human-discussion stream. Deliberately the bare heading text, not `## ` +
 * text: the heading-level tolerance belongs to the callers, this constant only
 * pins the wording to the prompt that produces it. Bump this if that heading
 * text changes — `tests/agents/pr-reviewer/bot-summary-heading.test.ts` fails
 * if it drifts out of sync.
 */
export const BOT_SUMMARY_HEADING_TEXT = 'Code Review';

/**
 * Fetch PR threads preserving raw comment content.
 *
 * Deliberately separate from `fetchPRReviewComments`, which strips every HTML
 * tag from the body. That strip would remove the `<!-- ai-finding:… -->` marker
 * this reconciliation depends on, so reusing it would silently match nothing and
 * open a duplicate thread on every re-review. The learn-rules CLI relies on the
 * stripped form, so the two readers stay separate rather than one being fixed.
 */
export async function fetchReviewThreadsRaw(
  prId: number,
  config: PipelineConfig,
): Promise<ReviewThread[]> {
  const response = await adoFetch<PRThreadsResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
  );

  const threads: ReviewThread[] = [];
  for (const thread of response.value) {
    const first = thread.comments?.[0];
    if (!first || first.content == null) continue;
    const last = thread.comments[thread.comments.length - 1];
    threads.push({
      id: thread.id,
      firstCommentId: first.id,
      rawContent: first.content,
      lastCommentIsStaleNotice: (last?.content ?? '').includes(STALE_NOTICE_PREFIX),
      filePath: thread.threadContext?.filePath,
      line: thread.threadContext?.rightFileEnd?.line
        ?? thread.threadContext?.rightFileStart?.line,
    });
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Anchored thread writer (public — posts/updates/replies for inline findings)
// ---------------------------------------------------------------------------

export interface InlineThreadArgs {
  filePath: string;
  line: number;
  content: string;
}

/**
 * Open a comment thread anchored to a line on the source-branch side of the diff.
 *
 * Status is `active` and never anything else: an inline finding is something a
 * human decides about. Pre-closing it (as `postPRComment` does with status 4)
 * would hide it from the PR's unresolved-comments count.
 */
export async function postInlineThread(
  prId: number,
  args: InlineThreadArgs,
  config: PipelineConfig,
): Promise<void> {
  const filePath = args.filePath.startsWith('/') ? args.filePath : `/${args.filePath}`;
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
    {
      method: 'POST',
      body: JSON.stringify({
        comments: [{ content: args.content, commentType: 1 }],
        status: 'active',
        threadContext: {
          filePath,
          rightFileStart: { line: args.line, offset: 1 },
          rightFileEnd: { line: args.line, offset: 1 },
        },
      }),
    },
  );
}

/** Rewrite an existing comment in place — used when a finding is raised again. */
export async function updateThreadComment(
  prId: number,
  threadId: number,
  commentId: number,
  content: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads/${threadId}/comments/${commentId}?api-version=7.0`,
    { method: 'PATCH', body: JSON.stringify({ content }) },
  );
}

/** Add a reply. Used for "not detected in review of <date>" — never closes the thread. */
export async function appendToThread(
  prId: number,
  threadId: number,
  content: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads/${threadId}/comments?api-version=7.0`,
    { method: 'POST', body: JSON.stringify({ content, commentType: 1 }) },
  );
}

/**
 * Add a Like reaction to a PR comment.
 *
 * Used to acknowledge a `/review` command the moment the pipeline starts working on
 * it. A review takes minutes, so without a signal the author cannot tell whether the
 * command was seen and tends to comment again.
 *
 * `POST`, not `PUT` — the real API answers `PUT` on this sub-resource with
 * *405 Method Not Allowed*. It takes no body: the liking identity is whoever owns the
 * PAT, so the reaction appears under that account rather than as a distinct bot.
 *
 * A Like is the only reaction Azure DevOps offers on PR comments — the resource is a
 * list of users, not of reaction types, and there is no `reactions` endpoint here
 * (work *item* comments are a separate API that does support typed reactions).
 */
export async function likePRComment(
  prId: number,
  threadId: number,
  commentId: number,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads/${threadId}/comments/${commentId}/likes?api-version=7.0`,
    { method: 'POST' },
  );
}

/**
 * Post a comment thread on a pull request.
 * Uses status=4 (closed) so it shows as informational without requiring resolution.
 */
export async function postPRComment(
  prId: number,
  text: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
    {
      method: 'POST',
      body: JSON.stringify({
        comments: [{ content: text, commentType: 1 }],
        status: 4,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// PR metadata + diff (public — feeds cherry-pick detection and backport diffing)
// ---------------------------------------------------------------------------

export interface PRMetadata {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  /** Present on active PRs; used to detect a stale merge preview. */
  lastMergeSourceCommit?: string;
  lastMergeTargetCommit?: string;
  /**
   * The commit the PR was merged AS. Present once a PR completes, absent on active
   * and abandoned ones (0/40 abandoned PRs measured had it).
   *
   * For a PR completed with `deleteSourceBranch: true` this is the only checkout
   * target that survives: the source branch is gone and its head is usually
   * unreachable after a squash-merge, while the merge commit sits on the target
   * branch, which is always cloned.
   */
  lastMergeCommit?: string;
}

/**
 * Read a PR's own metadata.
 *
 * The watcher's action payload carries the title and description, but
 * `action-processor.ts` does not forward them to the container, and a payload is a
 * creation-time snapshot: `webhook-server/parse.ts` ignores `pullrequest.updated`,
 * so a cherry-pick trailer added after the PR was opened would never be seen.
 * Reading over REST is always current and also gives the merge-preview commits.
 */
export async function fetchPRMetadata(
  prId: number,
  config: PipelineConfig,
): Promise<PRMetadata> {
  const pr = await adoFetch<{
    title?: string;
    description?: string;
    sourceRefName?: string;
    targetRefName?: string;
    lastMergeSourceCommit?: { commitId?: string };
    lastMergeTargetCommit?: { commitId?: string };
    lastMergeCommit?: { commitId?: string };
  }>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
  );

  return {
    title: pr.title ?? '',
    description: pr.description ?? '',
    sourceBranch: pr.sourceRefName ?? '',
    targetBranch: pr.targetRefName ?? '',
    ...(pr.lastMergeSourceCommit?.commitId ? { lastMergeSourceCommit: pr.lastMergeSourceCommit.commitId } : {}),
    ...(pr.lastMergeTargetCommit?.commitId ? { lastMergeTargetCommit: pr.lastMergeTargetCommit.commitId } : {}),
    ...(pr.lastMergeCommit?.commitId ? { lastMergeCommit: pr.lastMergeCommit.commitId } : {}),
  };
}

/**
 * The two commits a PR's diff is taken between: `git diff base head`.
 *
 * Which ADO facts they come from depends on the PR's state — see
 * `fetchPRDiffCommits`. From the iterations endpoint they are the merge base and
 * the PR head; for a completed PR they are the target tip and the merge commit.
 */
export interface PRIterationCommits {
  base: string;
  head: string;
}

export type PRIterationsResult =
  | { ok: true; commits: PRIterationCommits }
  | { ok: false; prMissing: boolean; error: string };

/**
 * Read the commits bounding a PR's diff, from its newest iteration.
 *
 * This is the endpoint that actually exists. `/pullrequests/{id}/changes` — what
 * the diff reader used to call — is not a route on this API and answers 404 with an
 * ASP.NET "controller not found" page; `/pullrequests/{id}/iterations` answers 200.
 * Both verified live against PR 52117 before this was written.
 *
 * An iteration is one push to the PR, so the NEWEST is the current state of the
 * branch. Selected by max `id` rather than by array position: the API returns them
 * ascending today, but nothing documents that, and picking the wrong iteration
 * would diff against a superseded push and look entirely plausible.
 */
export async function fetchPRIterationCommits(
  prId: number,
  config: PipelineConfig,
): Promise<PRIterationsResult> {
  try {
    const res = await adoFetch<{
      value?: {
        id?: number;
        commonRefCommit?: { commitId?: string };
        sourceRefCommit?: { commitId?: string };
      }[];
    }>(
      config.azureDevOps,
      `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/iterations?api-version=7.0`,
    );

    const iterations = res.value ?? [];
    if (iterations.length === 0) {
      return { ok: false, prMissing: false, error: `PR !${prId} reports no iterations` };
    }
    const newest = iterations.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a));
    const base = newest.commonRefCommit?.commitId;
    const head = newest.sourceRefCommit?.commitId;
    if (!base || !head) {
      return {
        ok: false,
        prMissing: false,
        error: `PR !${prId} iteration ${newest.id} carries no commonRefCommit/sourceRefCommit`,
      };
    }
    return { ok: true, commits: { base, head } };
  } catch (err) {
    // 404 is the ONLY status that means the PR is not in this repository. Every
    // other failure is a failure to ask, and must not be reported as absence.
    const status = err instanceof AzureDevOpsError ? err.status : undefined;
    return {
      ok: false,
      prMissing: status === 404,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Where a PR's bounding commits came from. Recorded so a failure names its route. */
export type DiffCommitSource = 'merge-commit' | 'iteration';

export interface PRDiffCommits extends PRIterationCommits {
  via: DiffCommitSource;
}

export type PRDiffCommitsResult =
  | { ok: true; commits: PRDiffCommits }
  | { ok: false; prMissing: boolean; error: string };

/** The PR fields that decide which pair of commits is reachable. Never throws. */
async function fetchPRCompletion(
  prId: number,
  config: PipelineConfig,
): Promise<
  | { ok: true; status: string; lastMergeCommit?: string; lastMergeTargetCommit?: string }
  | { ok: false; prMissing: boolean; error: string }
> {
  try {
    const pr = await adoFetch<{
      status?: string;
      lastMergeCommit?: { commitId?: string };
      lastMergeTargetCommit?: { commitId?: string };
    }>(
      config.azureDevOps,
      `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
    );
    return {
      ok: true,
      status: pr.status ?? '',
      ...(pr.lastMergeCommit?.commitId ? { lastMergeCommit: pr.lastMergeCommit.commitId } : {}),
      ...(pr.lastMergeTargetCommit?.commitId ? { lastMergeTargetCommit: pr.lastMergeTargetCommit.commitId } : {}),
    };
  } catch (err) {
    const status = err instanceof AzureDevOpsError ? err.status : undefined;
    return { ok: false, prMissing: status === 404, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Pick the two commits whose diff IS this PR's change, preferring the pair the
 * clone can actually reach.
 *
 * A completed PR's head is normally gone. The branch is deleted on completion, and
 * `refs/pull/<id>/merge` is retained only while a PR is ACTIVE — measured on this
 * instance: 4/4 active PRs had one, 2/2 completed PRs did not, and the whole
 * repository held 11 such refs in total. So for the case that matters most — the
 * SOURCE PR of a backport, which is almost always completed — no fetch recovers the
 * head, and `commonRefCommit..sourceRefCommit` cannot be diffed at all.
 *
 * The merge commit can be. It sits ON the target branch, so a full clone always has
 * it, and `lastMergeTargetCommit..lastMergeCommit` reproduces the PR's change for
 * every completion strategy: for a squash it is the squashed commit against its
 * parent, for a merge commit it is what the merge brought in, for a rebase it is the
 * rebased range. Verified content-identical (via `compareDiffs`) to the PR's own
 * `commonRefCommit..sourceRefCommit` diff on both PRs of a real backport pair.
 *
 * An ACTIVE PR has no final merge commit, but its branch exists, so the iteration
 * pair is both correct and reachable. That is the other half of the split.
 */
export async function fetchPRDiffCommits(
  prId: number,
  config: PipelineConfig,
): Promise<PRDiffCommitsResult> {
  const pr = await fetchPRCompletion(prId, config);
  if (!pr.ok) return { ok: false, prMissing: pr.prMissing, error: pr.error };

  if (pr.status === 'completed' && pr.lastMergeCommit && pr.lastMergeTargetCommit) {
    return {
      ok: true,
      commits: { base: pr.lastMergeTargetCommit, head: pr.lastMergeCommit, via: 'merge-commit' },
    };
  }

  const iteration = await fetchPRIterationCommits(prId, config);
  if (!iteration.ok) return iteration;
  return { ok: true, commits: { ...iteration.commits, via: 'iteration' } };
}

export type PRDiffResult =
  | { ok: true; files: FileDiff[] }
  | { ok: false; prMissing: boolean; error: string };

/**
 * Longest detail `fetchPRDiff` will emit before the ` (via <route>)` suffix.
 *
 * The suffix is the most diagnostic token in the whole message — it says WHICH of
 * the two commit-selection routes failed, and the two fail for entirely different
 * reasons. It also sits at the tail, where every downstream cap bites first: a
 * 5-digit PR id with an unreachable commit lands at 195 of `chooseReviewPath`'s 200,
 * so a 7-digit id would silently drop the route, and an ADO API error is long enough
 * to truncate it today. Capping the detail HERE keeps the whole message comfortably
 * inside that cap, so the suffix can never be the part that is lost.
 */
const MAX_ERROR_DETAIL = 160;

const capDetail = (s: string): string =>
  s.length > MAX_ERROR_DETAIL ? `${s.slice(0, MAX_ERROR_DETAIL)}…` : s;

/**
 * Fetch a PR's changed files and their patches.
 *
 * Composed rather than fetched: Azure DevOps REST serves no unified diffs, so the
 * bounding commits come from `/iterations` and the patches from `git diff` inside
 * the clone the container already has (`diffCommits`). The `{ path, patch }` shape
 * this returns is unchanged — it was always the ADO **MCP server's** composition,
 * never an API response, which is how a URL that 404s survived here.
 *
 * Lives in this module despite shelling out to git because it is the PR diff reader
 * its callers ask for by name; splitting it would put an import indirection between
 * two lines of code.
 *
 * Never throws. `prMissing` distinguishes "this PR is not in this repository" from
 * "the diff could not be computed" — the two used to be indistinguishable at the
 * call site, which is precisely what let a dead endpoint report every failure as
 * "source PR not found" and hide itself.
 */
export async function fetchPRDiff(
  prId: number,
  repoDir: string,
  config: PipelineConfig,
): Promise<PRDiffResult> {
  // Guarded before it reaches a fetch refspec below.
  if (!Number.isInteger(prId) || prId <= 0) {
    return { ok: false, prMissing: false, error: `invalid PR id: ${prId}` };
  }

  const picked = await fetchPRDiffCommits(prId, config);
  if (!picked.ok) {
    // Capped too, though it carries no route suffix: an ADO error body can run to
    // thousands of characters and this ends up in a column a human reads.
    return { ok: false, prMissing: picked.prMissing, error: capDetail(picked.error) };
  }

  // Only ever helps an ACTIVE PR whose branch the clone predates — a completed PR
  // has no `refs/pull/*` left to fetch, which is exactly why it takes the
  // merge-commit route above instead. `/merge` is what this instance exposes;
  // `/head` is tried second in case a repo is configured differently. Both are
  // no-ops unless a commit is genuinely missing.
  const diff = await diffCommits(repoDir, picked.commits.base, picked.commits.head, [
    `refs/pull/${prId}/merge`,
    `refs/pull/${prId}/head`,
  ]);
  if (!diff.ok) {
    // Naming the route is what makes a failure diagnosable from `review_path`:
    // "merge-commit" and "iteration" fail for entirely different reasons. The detail
    // is capped BEFORE the suffix is appended so the suffix survives — see
    // `MAX_ERROR_DETAIL`; appending first and capping later dropped exactly this.
    return {
      ok: false,
      prMissing: false,
      error: `${capDetail(diff.error)} (via ${picked.commits.via})`,
    };
  }
  return { ok: true, files: diff.files };
}
