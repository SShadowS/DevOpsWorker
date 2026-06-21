import { describe, test, expect } from 'bun:test';
import type { PipelineState } from '../../../src/types/pipeline.types.ts';
import { buildRevisionSection } from '../../../src/agents/planner/config.ts';
import { buildHumanFeedbackSection } from '../../../src/pipeline/human-feedback.ts';
import type { PlanReview } from '../../../src/agents/plan-reviewer/schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'planner',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReview(overrides?: Partial<PlanReview>): PlanReview {
  return {
    verdict: 'revise',
    feedback: 'Needs changes',
    issues: [],
    strengths: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRevisionSection', () => {
  test('returns empty when no reviews exist', () => {
    const state = freshState();
    expect(buildRevisionSection(state)).toEqual([]);
  });

  test('returns empty when last review approved', () => {
    const state = freshState({
      planReviews: [makeReview({ verdict: 'approve' })] as any,
    });
    expect(buildRevisionSection(state)).toEqual([]);
  });

  test('includes previous devPlan when revising', () => {
    const devPlan = { summary: 'Test plan', objects: [] };
    const state = freshState({
      devPlan: devPlan as any,
      planReviews: [makeReview()] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).toContain('## Your Previous Plan');
    expect(result).toContain('"summary": "Test plan"');
    expect(result).toContain('```json');
  });

  test('omits previous plan section when devPlan is undefined', () => {
    const state = freshState({
      planReviews: [makeReview()] as any,
    });
    const result = buildRevisionSection(state).join('\n');
    expect(result).not.toContain('## Your Previous Plan');
  });

  test('includes suggestion for each issue', () => {
    const state = freshState({
      planReviews: [
        makeReview({
          issues: [
            {
              severity: 'critical',
              category: 'architectural-concern',
              description: 'Codeunit ID 6175368 is already taken',
              suggestion: 'Use a different ID in the 6175271-6175499 range',
            },
          ],
        }),
      ] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).toContain('[critical] Codeunit ID 6175368 is already taken');
    expect(result).toContain('→ Fix: Use a different ID in the 6175271-6175499 range');
  });

  test('includes revisionInstructions from latest review', () => {
    const state = freshState({
      planReviews: [
        makeReview({
          revisionInstructions: 'Focus on fixing the ID collision first.',
        }),
      ] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).toContain('**Revision Instructions:**');
    expect(result).toContain('Focus on fixing the ID collision first.');
  });

  test('omits revision instructions when not present', () => {
    const state = freshState({
      planReviews: [makeReview()] as any,
    });
    const result = buildRevisionSection(state).join('\n');
    expect(result).not.toContain('**Revision Instructions:**');
  });

  test('shows all reviews with older ones compact and latest detailed', () => {
    const review1 = makeReview({
      feedback: 'First feedback',
      issues: [
        { severity: 'critical', category: 'architectural-concern', description: 'Issue A', suggestion: 'Fix A' },
      ],
    });
    const review2 = makeReview({
      feedback: 'Second feedback',
      issues: [
        { severity: 'major', category: 'missing-edge-case', description: 'Issue B', suggestion: 'Fix B' },
      ],
    });
    const review3 = makeReview({
      feedback: 'Third feedback',
      issues: [
        { severity: 'major', category: 'anti-pattern', description: 'Issue C', suggestion: 'Fix C' },
      ],
      revisionInstructions: 'Fix C thoroughly.',
    });

    const state = freshState({
      planReviews: [review1, review2, review3] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    // Older reviews shown compactly
    expect(result).toContain('### Review History');
    expect(result).toContain('**Review 1 issues (now resolved — do not regress):**');
    expect(result).toContain('- [critical] Issue A');
    expect(result).toContain('**Review 2 issues (now resolved — do not regress):**');
    expect(result).toContain('- [major] Issue B');

    // Latest review has full detail
    expect(result).toContain('### Latest Review (Review 3)');
    expect(result).toContain('**Feedback:** Third feedback');
    expect(result).toContain('→ Fix: Fix C');
    expect(result).toContain('Fix C thoroughly.');

    // Attempt count
    expect(result).toContain('attempt 4');
  });

  test('flags recurring issues by relatedObject + category', () => {
    const review1 = makeReview({
      issues: [
        {
          severity: 'critical',
          category: 'architectural-concern',
          description: 'Codeunit ID collision',
          suggestion: 'Use different ID',
          relatedObject: 'Codeunit 6175368',
        },
      ],
    });
    const review2 = makeReview({
      issues: [
        { severity: 'major', category: 'missing-edge-case', description: 'Unrelated issue', suggestion: 'Fix it' },
      ],
    });
    const review3 = makeReview({
      issues: [
        {
          severity: 'critical',
          category: 'architectural-concern',
          description: 'Codeunit ID still colliding',
          suggestion: 'Verify next available ID',
          relatedObject: 'Codeunit 6175368',
        },
        { severity: 'minor', category: 'other', description: 'New issue', suggestion: 'Handle it' },
      ],
    });

    const state = freshState({
      planReviews: [review1, review2, review3] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    // Recurring issues section present
    expect(result).toContain('**⚠️ RECURRING ISSUES (fix these permanently):**');
    expect(result).toContain('(reviews 1, 3)');
    expect(result).toContain('Codeunit ID still colliding');

    // The non-recurring "New issue" should NOT appear in the recurring section
    const recurringSection = result.split('RECURRING ISSUES')[1]!;
    expect(recurringSection).not.toContain('New issue');
  });

  test('no recurring section when no issues recur', () => {
    const review1 = makeReview({
      issues: [
        { severity: 'critical', category: 'architectural-concern', description: 'Issue A', suggestion: 'Fix A' },
      ],
    });
    const review2 = makeReview({
      issues: [
        { severity: 'major', category: 'missing-edge-case', description: 'Issue B', suggestion: 'Fix B' },
      ],
    });

    const state = freshState({
      planReviews: [review1, review2] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).not.toContain('RECURRING ISSUES');
  });

  test('single review has no review history section', () => {
    const state = freshState({
      planReviews: [
        makeReview({
          issues: [
            { severity: 'major', category: 'other', description: 'Some issue', suggestion: 'Fix it' },
          ],
        }),
      ] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).not.toContain('### Review History');
    expect(result).toContain('### Latest Review (Review 1)');
    expect(result).toContain('attempt 2');
  });

  test('ends with instruction not to regress', () => {
    const state = freshState({
      planReviews: [makeReview()] as any,
    });
    const result = buildRevisionSection(state).join('\n');

    expect(result).toContain('Do NOT re-introduce problems from earlier reviews');
  });
});

describe('buildHumanFeedbackSection (planner integration)', () => {
  test('returns human feedback when humanFeedback is present in state', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan focus on error handling',
        source: 'work-item-comment',
      },
    });
    const result = buildHumanFeedbackSection(state, 'planning').join('\n');

    expect(result).toContain('## Human Feedback');
    expect(result).toContain('/rerun-plan focus on error handling');
  });

  test('returns empty when no humanFeedback', () => {
    const state = freshState();
    expect(buildHumanFeedbackSection(state, 'planning')).toEqual([]);
  });

  test('renders commentSummary in planning mode instead of raw comments', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan rethink the approach',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice', content: 'This approach is wrong',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.al', line: 42,
          },
        ],
        commentSummary: 'Reviewers rejected the overall authentication approach and suggested using OAuth instead of custom tokens.',
      },
    });
    const result = buildHumanFeedbackSection(state, 'planning').join('\n');

    expect(result).toContain('### PR Review Summary');
    expect(result).toContain('Reviewers rejected the overall authentication approach');
    // Should NOT render raw comments in planning mode
    expect(result).not.toContain('### PR Review Comments');
    expect(result).not.toContain('Alice (line 42)');
  });
});
