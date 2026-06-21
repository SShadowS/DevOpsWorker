import { describe, test, expect, mock, afterEach } from 'bun:test';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import { buildHumanFeedbackSection, summarizePRComments } from '../../src/pipeline/human-feedback.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — buildHumanFeedbackSection
// ---------------------------------------------------------------------------

describe('buildHumanFeedbackSection', () => {
  test('returns empty when no humanFeedback present', () => {
    const state = freshState();
    expect(buildHumanFeedbackSection(state)).toEqual([]);
  });

  test('renders rerun comment as blockquote', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan focus on error handling',
        source: 'work-item-comment',
      },
    });
    const result = buildHumanFeedbackSection(state).join('\n');

    expect(result).toContain('## Human Feedback (from rerun request)');
    expect(result).toContain('> /rerun-plan focus on error handling');
  });

  test('renders minimal rerun comment (just the command)', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix',
        source: 'pr-comment',
      },
    });
    const result = buildHumanFeedbackSection(state).join('\n');

    expect(result).toContain('> /fix');
    expect(result).not.toContain('### PR Review Comments');
  });

  test('renders multiline rerun comment with blockquote continuation', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan\nPlease focus on:\n- error handling\n- edge cases',
        source: 'work-item-comment',
      },
    });
    const result = buildHumanFeedbackSection(state).join('\n');

    expect(result).toContain('> /rerun-plan');
    expect(result).toContain('> Please focus on:');
    expect(result).toContain('> - error handling');
  });

  test('coding mode renders PR review comments grouped by file', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix fix review comments',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice',
            content: 'This logic is wrong',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.Merge.al',
            line: 42,
          },
          {
            threadId: 2, commentId: 2,
            author: 'Bob',
            content: 'Missing error handling',
            publishedDate: '2025-01-01T01:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.Merge.al',
            line: 85,
          },
          {
            threadId: 3, commentId: 3,
            author: 'Alice',
            content: 'Add a test for this scenario',
            publishedDate: '2025-01-01T02:00:00Z',
            filePath: '/Test/AL/src/Test.Merge.al',
            line: 10,
          },
        ],
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).toContain('### PR Review Comments');
    expect(result).toContain('**/Cloud/AL/src/Codeunit.Merge.al**');
    expect(result).toContain('- Alice (line 42): This logic is wrong');
    expect(result).toContain('- Bob (line 85): Missing error handling');
    expect(result).toContain('**/Test/AL/src/Test.Merge.al**');
    expect(result).toContain('- Alice (line 10): Add a test for this scenario');
  });

  test('coding mode renders general comments under "(general)"', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice',
            content: 'Overall looks good but needs tests',
            publishedDate: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).toContain('**(general)**');
    expect(result).toContain('- Alice: Overall looks good but needs tests');
  });

  test('coding mode omits line number when not present', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Bob',
            content: 'File-level comment',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Page.al',
          },
        ],
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).toContain('- Bob: File-level comment');
    expect(result).not.toContain('(line');
  });

  test('no PR review comments section when prReviewComments is undefined', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan',
        source: 'work-item-comment',
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).not.toContain('### PR Review Comments');
  });

  test('no PR review comments section when prReviewComments is empty', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan',
        source: 'work-item-comment',
        prReviewComments: [],
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).not.toContain('### PR Review Comments');
  });

  // ── Planning mode tests ──────────────────────────────────────────────

  test('planning mode renders commentSummary instead of raw comments', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice', content: 'This approach is wrong',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.al', line: 42,
          },
        ],
        commentSummary: 'Reviewers want a fundamentally different approach using event subscribers.',
      },
    });
    const result = buildHumanFeedbackSection(state, 'planning').join('\n');

    expect(result).toContain('### PR Review Summary');
    expect(result).toContain('Reviewers want a fundamentally different approach');
    expect(result).not.toContain('### PR Review Comments');
    expect(result).not.toContain('Alice (line 42)');
  });

  test('planning mode without commentSummary falls back to raw comments', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice', content: 'This is wrong',
            publishedDate: '2025-01-01T00:00:00Z',
          },
        ],
      },
    });
    const result = buildHumanFeedbackSection(state, 'planning').join('\n');

    // No summary → falls back to raw comments with "summary unavailable" heading
    expect(result).not.toContain('### PR Review Summary');
    expect(result).toContain('### PR Review Comments (summary unavailable)');
    expect(result).toContain('Alice: This is wrong');
    expect(result).toContain('> /rerun-plan');
  });

  test('default mode is coding', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice', content: 'Fix this',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/file.al', line: 1,
          },
        ],
      },
    });
    // No mode parameter → defaults to 'coding'
    const result = buildHumanFeedbackSection(state).join('\n');

    expect(result).toContain('### PR Review Comments');
    expect(result).toContain('Alice (line 1): Fix this');
  });

  test('renders work item discussion comments', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan Rethink it',
        source: 'work-item-comment',
        workItemComments: [
          { author: 'Bob', text: 'Use the helper codeunit for this', createdDate: '2024-06-01T00:00:00Z' },
          { author: 'Carol', text: 'Also check the posting routine', createdDate: '2024-07-01T00:00:00Z' },
        ],
      },
    });

    const result = buildHumanFeedbackSection(state);
    expect(result).toContain('### Discussion Context');
    expect(result).toContain('- **Bob** (2024-06-01): Use the helper codeunit for this');
    expect(result).toContain('- **Carol** (2024-07-01): Also check the posting routine');
  });

  test('omits discussion context when no work item comments', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan Rethink it',
        source: 'work-item-comment',
      },
    });

    const result = buildHumanFeedbackSection(state);
    const joined = result.join('\n');
    expect(joined).not.toContain('Discussion Context');
  });

  test('omits discussion context when work item comments is empty', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/rerun-plan Rethink it',
        source: 'work-item-comment',
        workItemComments: [],
      },
    });

    const result = buildHumanFeedbackSection(state);
    const joined = result.join('\n');
    expect(joined).not.toContain('Discussion Context');
  });
});
