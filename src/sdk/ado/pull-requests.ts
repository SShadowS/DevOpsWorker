import type { PipelineConfig } from '../../types/pipeline.types.ts';
import { adoFetch } from './http.ts';

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
