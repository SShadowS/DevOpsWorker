import { describe, test, expect } from 'bun:test';
import { parseWebhookPayload } from '../../src/webhook-server/parse.ts';

function prCreatedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'git.pullrequest.created',
    createdDate: new Date().toISOString(),
    resource: {
      pullRequestId: 123,
      repository: {
        id: 'repo-guid-123',
        name: 'My Repo',
        project: { id: 'proj-id', name: 'My Project' },
      },
      sourceRefName: 'refs/heads/feature/my-branch',
      targetRefName: 'refs/heads/master',
      status: 'active',
      createdBy: { displayName: 'John Doe' },
    },
    ...overrides,
  };
}

describe('parseWebhookPayload', () => {
  test('parses PR created event', () => {
    const result = parseWebhookPayload(prCreatedPayload());
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('git.pullrequest.created');
    expect(result!.pr.id).toBe(123);
    expect(result!.pr.repositoryId).toBe('repo-guid-123');
    expect(result!.pr.sourceBranch).toBe('refs/heads/feature/my-branch');
  });

  test('ignores PR updated event', () => {
    const result = parseWebhookPayload({
      ...prCreatedPayload(),
      eventType: 'git.pullrequest.updated',
    });
    expect(result).toBeNull();
  });

  test('rejects stale timestamps', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(() => parseWebhookPayload(prCreatedPayload({ createdDate: stale }))).toThrow('too old');
  });

  test('returns null for unknown event types', () => {
    const result = parseWebhookPayload({ eventType: 'build.completed', createdDate: new Date().toISOString() });
    expect(result).toBeNull();
  });

  test('throws on missing eventType', () => {
    expect(() => parseWebhookPayload({})).toThrow('missing eventType');
  });

  test('throws on non-object payload', () => {
    expect(() => parseWebhookPayload('string')).toThrow('expected object');
  });

  test('extracts author name', () => {
    const result = parseWebhookPayload(prCreatedPayload());
    expect(result!.pr.author).toBe('John Doe');
  });

  test('extracts PR title from resource', () => {
    const payload = prCreatedPayload();
    (payload.resource as any).title = 'Cherry-pick Fix posting date';
    const result = parseWebhookPayload(payload);
    expect(result!.pr.title).toBe('Cherry-pick Fix posting date');
  });

  test('extracts PR description from resource', () => {
    const payload = prCreatedPayload();
    (payload.resource as any).title = 'Cherry-pick Fix posting date';
    (payload.resource as any).description = 'Cherry-picked from pull request !456';
    const result = parseWebhookPayload(payload);
    expect(result!.pr.description).toBe('Cherry-picked from pull request !456');
  });

  test('handles missing title gracefully', () => {
    const result = parseWebhookPayload(prCreatedPayload());
    expect(result!.pr.title).toBeUndefined();
  });

  test('propagates isDraft true', () => {
    const payload = prCreatedPayload();
    (payload.resource as any).isDraft = true;
    const result = parseWebhookPayload(payload);
    expect(result!.pr.isDraft).toBe(true);
  });

  test('isDraft undefined when absent', () => {
    const result = parseWebhookPayload(prCreatedPayload());
    expect(result!.pr.isDraft).toBeUndefined();
  });
});

function commentEventPayload(
  commentContent: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
    createdDate: new Date().toISOString(),
    resource: {
      comment: {
        id: 1,
        content: commentContent,
        publishedDate: new Date().toISOString(),
        lastContentUpdatedDate: new Date().toISOString(),
        _links: {
          self: {
            href: 'https://dev.azure.com/org/_apis/git/repositories/repo-id/pullRequests/100/threads/5001/comments/1',
          },
        },
      },
      pullRequest: {
        pullRequestId: 100,
        repository: {
          id: 'repo-guid-456',
          name: 'My Repo',
          project: { id: 'proj-id', name: 'My Project' },
        },
        sourceRefName: 'refs/heads/feature/review-me',
        targetRefName: 'refs/heads/master',
        status: 'active',
        createdBy: { displayName: 'Jane Doe' },
        url: 'https://dev.azure.com/org/proj/_apis/git/repositories/repo-id/pullRequests/100',
      },
    },
    ...overrides,
  };
}

describe('comment event parsing', () => {
  test('parses comment with /review command', () => {
    const result = parseWebhookPayload(commentEventPayload('/review'));
    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('ms.vss-code.git-pullrequest-comment-event');
    expect(result!.pr.id).toBe(100);
    expect(result!.pr.repositoryId).toBe('repo-guid-456');
    expect(result!.pr.sourceBranch).toBe('refs/heads/feature/review-me');
    expect(result!.pr.author).toBe('Jane Doe');
    expect(result!.commentKey).toBe('5001:1');
  });

  test('ignores comment without /review', () => {
    const result = parseWebhookPayload(commentEventPayload('Looks good to me!'));
    expect(result).toBeNull();
  });

  test('/review with surrounding whitespace matches', () => {
    const result = parseWebhookPayload(commentEventPayload('  /review  '));
    expect(result).not.toBeNull();
    expect(result!.commentKey).toBe('5001:1');
  });

  test('/review on its own line in multi-line comment matches', () => {
    const result = parseWebhookPayload(
      commentEventPayload('Please take another look\n/review\nThanks!'),
    );
    expect(result).not.toBeNull();
  });

  test('/reviewed does NOT match', () => {
    const result = parseWebhookPayload(commentEventPayload('/reviewed'));
    expect(result).toBeNull();
  });

  test('/review-code does NOT match', () => {
    const result = parseWebhookPayload(commentEventPayload('/review-code'));
    expect(result).toBeNull();
  });

  test('rejects stale comment event', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(() =>
      parseWebhookPayload(commentEventPayload('/review', { createdDate: stale })),
    ).toThrow('too old');
  });

  test('strips HTML before checking for /review', () => {
    const result = parseWebhookPayload(
      commentEventPayload('<p>/review</p>'),
    );
    expect(result).not.toBeNull();
  });

  test('ignores deleted comment (no content, isDeleted true)', () => {
    const payload = commentEventPayload('/review');
    const resource = payload.resource as Record<string, any>;
    delete resource.comment.content;
    resource.comment.isDeleted = true;
    const result = parseWebhookPayload(payload);
    expect(result).toBeNull();
  });

  test('ignores comment with no content field', () => {
    const payload = commentEventPayload('/review');
    const resource = payload.resource as Record<string, any>;
    delete resource.comment.content;
    const result = parseWebhookPayload(payload);
    expect(result).toBeNull();
  });
});
