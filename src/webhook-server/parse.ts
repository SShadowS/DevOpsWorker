import { z } from 'zod';

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

const repositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
});

const prResourceSchema = z.object({
  pullRequestId: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  repository: repositorySchema,
  sourceRefName: z.string(),
  targetRefName: z.string(),
  status: z.enum(['active', 'completed', 'abandoned']).optional(),
  isDraft: z.boolean().optional(),
  createdBy: z.object({ displayName: z.string(), uniqueName: z.string().optional() }),
  url: z.string().optional(),
});

const prCreatedSchema = z.object({
  eventType: z.literal('git.pullrequest.created'),
  createdDate: z.string(),
  resource: prResourceSchema,
});

const prUpdatedSchema = z.object({
  eventType: z.literal('git.pullrequest.updated'),
  createdDate: z.string(),
  resource: prResourceSchema,
  /**
   * Azure DevOps' own description of what changed — "Jane Roe published the pull
   * request", "…approved pull request 53373", "…updated pull request 53373". It is
   * the only field that distinguishes one kind of update from another: the resource
   * is the PR's full current state and looks identical whichever event produced it.
   *
   * Optional so a payload without it parses and is then ignored, rather than throwing
   * and turning a routine update into an error in the log.
   */
  message: z.object({ text: z.string() }).optional(),
});

/**
 * Did this update publish a draft?
 *
 * Both signals are required. `isDraft: false` is true of EVERY update to a published
 * PR — a push, an approval, a reviewer change — so on its own it would turn all of
 * them into reviews. The message text names the transition and appears only on the
 * publish itself. Requiring both also means a payload where the two disagree is
 * ignored rather than guessed at.
 */
function isDraftPublished(payload: z.infer<typeof prUpdatedSchema>): boolean {
  if (payload.resource.isDraft !== false) return false;
  const text = payload.message?.text ?? '';
  return /\bpublished the pull request\b/i.test(text);
}

const commentResourceSchema = z.object({
  comment: z.object({
    id: z.number(),
    content: z.string().optional(),
    isDeleted: z.boolean().optional(),
    _links: z.object({
      self: z.object({ href: z.string() }),
    }),
  }),
  pullRequest: prResourceSchema,
});

const commentEventSchema = z.object({
  eventType: z.literal('ms.vss-code.git-pullrequest-comment-event'),
  createdDate: z.string(),
  resource: commentResourceSchema,
});

export interface PRWebhookEvent {
  eventType: string;
  pr: {
    id: number;
    repositoryId: string;
    repositoryName: string;
    project: string;
    sourceBranch: string;
    targetBranch: string;
    author: string;
    status?: string;
    isDraft?: boolean;
    url?: string;
    title?: string;
    description?: string;
  };
  /**
   * True when this event is a draft being published, rather than a PR being created.
   * The review itself is identical; what differs is the dedup rule, because unlike a
   * creation a publish can happen more than once on the same PR (draft → published →
   * draft → published).
   */
  publishedFromDraft?: true;
  commentKey?: string;
  /** Set when the triggering comment was `/review-full` — forces the full seven-agent
   *  review even for a PR `chooseReviewPath` would otherwise route to the backport
   *  reviewer. Absent (not `false`) for a plain `/review`. */
  forceFull?: boolean;
}

/**
 * Parse an Azure DevOps webhook payload.
 * Returns null for unknown/unsupported event types.
 * Throws on invalid payloads or stale timestamps.
 */
export function parseWebhookPayload(payload: unknown): PRWebhookEvent | null {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Invalid payload: expected object');
  }

  const eventType = (payload as Record<string, unknown>).eventType;
  if (typeof eventType !== 'string') {
    throw new Error('Invalid payload: missing eventType');
  }

  let resource: z.infer<typeof prResourceSchema>;
  let createdDate: string;
  // Set only on the draft-publish path, and carried on the returned event so the
  // queueing side can dedup it differently from a creation — see index.ts.
  let publishedFromDraft = false;

  if (eventType === 'git.pullrequest.created') {
    const result = prCreatedSchema.safeParse(payload);
    if (!result.success) throw new Error(`Invalid PR created payload: ${result.error.message}`);
    resource = result.data.resource;
    createdDate = result.data.createdDate;
  } else if (eventType === 'git.pullrequest.updated') {
    // Updates are ignored — reviewing on every push would re-review the same PR all
    // day — with ONE exception: the update that publishes a draft. A draft is skipped
    // at creation by policy, and before this exception existed nothing ever looked at
    // it again, so a PR opened as a draft could never be auto-reviewed at all. That
    // is not a rare shape: in one week 28 PRs were created as drafts and exactly one
    // was ever reviewed, and only because a human typed /review.
    const result = prUpdatedSchema.safeParse(payload);
    // A malformed update is not worth an error: it is a class of event we ignore
    // wholesale, and throwing here would fill the log with failures for events that
    // were never going to be acted on.
    if (!result.success) return null;
    if (!isDraftPublished(result.data)) return null;
    resource = result.data.resource;
    createdDate = result.data.createdDate;
    publishedFromDraft = true;
  } else if (eventType === 'ms.vss-code.git-pullrequest-comment-event') {
    const result = commentEventSchema.safeParse(payload);
    if (!result.success) throw new Error(`Invalid comment event payload: ${result.error.message}`);

    // Ignore deleted comments or comments with no content
    const commentContent = result.data.resource.comment.content;
    if (!commentContent || result.data.resource.comment.isDeleted) {
      return null;
    }

    // Strip HTML and check for a review command. `/review` and `/review-full` are
    // separate commands: the second forces the full seven-agent review on a PR that
    // would otherwise route to the cheaper backport reviewer. Anchored so
    // `/review-fully` and `/reviewfull` match neither.
    const plainText = commentContent.replace(/<[^>]+>/g, '').trim();
    const isReview = /^\s*\/review\s*$/m.test(plainText);
    const isReviewFull = /^\s*\/review-full\s*$/m.test(plainText);
    if (!isReview && !isReviewFull) {
      return null; // No /review or /review-full command — skip silently
    }

    // Extract commentKey from self link: .../threads/{threadId}/comments/{commentId}
    const selfHref = result.data.resource.comment._links.self.href;
    const linkMatch = selfHref.match(/threads\/(\d+)\/comments\/(\d+)/);
    if (!linkMatch) throw new Error(`Cannot extract thread/comment ID from: ${selfHref}`);
    const commentKey = `${linkMatch[1]}:${linkMatch[2]}`;
    // Format is `threadId:commentId` — parseCommentKey below is its reader. Keep the
    // two together so the format cannot drift apart from the code that consumes it.

    // Replay protection (same 5-minute window as PR created)
    const age = Date.now() - new Date(result.data.createdDate).getTime();
    if (age > MAX_TIMESTAMP_AGE_MS) {
      throw new Error(`Webhook timestamp too old (${Math.round(age / 1000)}s)`);
    }

    const pr = result.data.resource.pullRequest;
    return {
      eventType,
      pr: {
        id: pr.pullRequestId,
        repositoryId: pr.repository.id,
        repositoryName: pr.repository.name,
        project: pr.repository.project.name,
        sourceBranch: pr.sourceRefName,
        targetBranch: pr.targetRefName,
        author: pr.createdBy.displayName,
        status: pr.status,
        isDraft: pr.isDraft,
        url: pr.url,
        title: pr.title,
        description: pr.description,
      },
      commentKey,
      ...(isReviewFull ? { forceFull: true } : {}),
    };
  } else {
    return null;
  }

  // Replay protection
  const age = Date.now() - new Date(createdDate).getTime();
  if (age > MAX_TIMESTAMP_AGE_MS) {
    throw new Error(`Webhook timestamp too old (${Math.round(age / 1000)}s)`);
  }

  return {
    eventType,
    ...(publishedFromDraft ? { publishedFromDraft: true as const } : {}),
    pr: {
      id: resource.pullRequestId,
      repositoryId: resource.repository.id,
      repositoryName: resource.repository.name,
      project: resource.repository.project.name,
      sourceBranch: resource.sourceRefName,
      targetBranch: resource.targetRefName,
      author: resource.createdBy.displayName,
      status: resource.status,
      isDraft: resource.isDraft,
      url: resource.url,
      title: resource.title,
      description: resource.description,
    },
  };
}

/**
 * Read back the `commentKey` this module writes — `threadId:commentId`.
 *
 * Returns `null` for anything that is not two positive integers separated by a single
 * colon, so a caller cannot silently address thread `NaN`. Consumers treat `null` as
 * "no comment to act on" rather than an error: the key only exists for
 * comment-triggered reviews, and nothing downstream should fail because a reaction
 * could not be placed.
 */
export function parseCommentKey(
  key: string | undefined | null,
): { threadId: number; commentId: number } | null {
  if (!key) return null;
  const match = /^(\d+):(\d+)$/.exec(key.trim());
  if (!match) return null;
  const threadId = Number(match[1]);
  const commentId = Number(match[2]);
  if (!Number.isSafeInteger(threadId) || !Number.isSafeInteger(commentId)) return null;
  if (threadId <= 0 || commentId <= 0) return null;
  return { threadId, commentId };
}
