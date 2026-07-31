import { describe, test, expect } from 'bun:test';
import { buildReviewPrActionFeedback } from '../../src/webhook-server/index.ts';
import type { PRWebhookEvent } from '../../src/webhook-server/parse.ts';

// ---------------------------------------------------------------------------
// buildReviewPrActionFeedback — one hop of the webhook -> action -> argv bridge
// that action-processor.ts's buildReviewPrExtraArgs (tests/cli/watch/
// action-processor.test.ts) and review-pr.ts's parseReviewPrArgs
// (tests/cli/review-pr.test.ts) pin at the other two ends. This is the exact
// shape of bridge that let `prTitle` go missing before: threaded into the
// payload correctly here but never read back out on the other side. A field
// dropped from the JSON.stringify object below fails one of these tests.
// ---------------------------------------------------------------------------

function baseEvent(overrides: Partial<PRWebhookEvent> = {}): PRWebhookEvent {
  return {
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
    pr: {
      id: 100,
      repositoryId: 'repo-guid-456',
      repositoryName: 'My Repo',
      project: 'My Project',
      sourceBranch: 'refs/heads/feature/review-me',
      targetBranch: 'refs/heads/master',
      author: 'Jane Doe',
      url: 'https://dev.azure.com/org/proj/_apis/git/repositories/repo-id/pullRequests/100',
      title: 'Cherry-pick: fix posting date',
      description: 'Cherry-picked from pull request !456',
    },
    commentKey: '5001:1',
    ...overrides,
  };
}

describe('buildReviewPrActionFeedback', () => {
  test('threads forceFull through when the event carries it (a /review-full comment)', () => {
    const feedback = JSON.parse(buildReviewPrActionFeedback(baseEvent({ forceFull: true }), 'DocumentOutput'));
    expect(feedback.forceFull).toBe(true);
  });

  test('omits forceFull entirely for a plain /review — no property leaking as false', () => {
    const feedback = JSON.parse(buildReviewPrActionFeedback(baseEvent(), 'DocumentOutput'));
    expect('forceFull' in feedback).toBe(false);
  });

  test('omits forceFull for a PR-creation event (no commentKey at all)', () => {
    const feedback = JSON.parse(buildReviewPrActionFeedback(baseEvent({ commentKey: undefined }), 'DocumentOutput'));
    expect('forceFull' in feedback).toBe(false);
    expect('commentKey' in feedback).toBe(false);
  });

  test('still forwards every pre-existing field untouched', () => {
    const feedback = JSON.parse(buildReviewPrActionFeedback(baseEvent(), 'DocumentOutput'));
    expect(feedback).toEqual({
      prId: 100,
      repoKey: 'DocumentOutput',
      repositoryId: 'repo-guid-456',
      project: 'My Project',
      sourceBranch: 'refs/heads/feature/review-me',
      targetBranch: 'refs/heads/master',
      prUrl: 'https://dev.azure.com/org/proj/_apis/git/repositories/repo-id/pullRequests/100',
      prTitle: 'Cherry-pick: fix posting date',
      prDescription: 'Cherry-picked from pull request !456',
      commentKey: '5001:1',
    });
  });
});
