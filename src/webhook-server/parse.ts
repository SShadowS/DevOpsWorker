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
});

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
  commentKey?: string;
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

  if (eventType === 'git.pullrequest.created') {
    const result = prCreatedSchema.safeParse(payload);
    if (!result.success) throw new Error(`Invalid PR created payload: ${result.error.message}`);
    resource = result.data.resource;
    createdDate = result.data.createdDate;
  } else if (eventType === 'git.pullrequest.updated') {
    // Ignore PR updates — only review on creation to avoid re-reviewing on every push
    return null;
  } else if (eventType === 'ms.vss-code.git-pullrequest-comment-event') {
    const result = commentEventSchema.safeParse(payload);
    if (!result.success) throw new Error(`Invalid comment event payload: ${result.error.message}`);

    // Ignore deleted comments or comments with no content
    const commentContent = result.data.resource.comment.content;
    if (!commentContent || result.data.resource.comment.isDeleted) {
      return null;
    }

    // Strip HTML and check for /review command
    const plainText = commentContent.replace(/<[^>]+>/g, '').trim();
    if (!/^\s*\/review\s*$/m.test(plainText)) {
      return null; // No /review command — skip silently
    }

    // Extract commentKey from self link: .../threads/{threadId}/comments/{commentId}
    const selfHref = result.data.resource.comment._links.self.href;
    const linkMatch = selfHref.match(/threads\/(\d+)\/comments\/(\d+)/);
    if (!linkMatch) throw new Error(`Cannot extract thread/comment ID from: ${selfHref}`);
    const commentKey = `${linkMatch[1]}:${linkMatch[2]}`;

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
