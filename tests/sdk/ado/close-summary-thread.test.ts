import { describe, test, expect } from 'bun:test';
import {
  isApprovedRecommendation,
  findBotSummaryThread,
} from '../../../src/sdk/ado/pull-requests.ts';
import type { ReviewThread } from '../../../src/sdk/ado/pull-requests.ts';

// ---------------------------------------------------------------------------
// Closing the review thread when the reviewer approves
//
// An approved review leaves its summary sitting open on the pull request, so a
// reader has to open it to learn there is nothing to do. Closing it says the
// same thing at a glance.
//
// Only on approve. "request changes" and "needs discussion" are asking the
// author for something, and closing a thread that wants an answer is how the
// answer stops arriving.
// ---------------------------------------------------------------------------

const thread = (id: number, rawContent: string): ReviewThread => ({
  id,
  firstCommentId: id * 10,
  rawContent,
  lastCommentIsStaleNotice: false,
});

describe('isApprovedRecommendation', () => {
  test('the three values the reviewer actually produces', () => {
    // Measured over 60 days: approve 494, request changes 233, needs discussion
    // 188 — no other value, and no free-form drift.
    expect(isApprovedRecommendation('approve')).toBe(true);
    expect(isApprovedRecommendation('request changes')).toBe(false);
    expect(isApprovedRecommendation('needs discussion')).toBe(false);
  });

  test('tolerates case and surrounding space', () => {
    expect(isApprovedRecommendation('  Approve ')).toBe(true);
  });

  test('a hedged approval is not an approval', () => {
    // "approve with changes requested" contains "approve"; a substring test
    // would close a thread that is asking the author for work.
    expect(isApprovedRecommendation('approve with changes requested')).toBe(false);
    expect(isApprovedRecommendation('approve, but needs discussion')).toBe(false);
  });

  test('null or empty is not an approval', () => {
    expect(isApprovedRecommendation(null)).toBe(false);
    expect(isApprovedRecommendation(undefined)).toBe(false);
    expect(isApprovedRecommendation('')).toBe(false);
  });
});

describe('findBotSummaryThread', () => {
  test('finds the summary by its heading', () => {
    const threads = [
      thread(1, 'A human asking a question'),
      thread(2, '## Code Review — Adds retry backoff\n\nNo findings.'),
    ];

    expect(findBotSummaryThread(threads)?.id).toBe(2);
  });

  test('accepts either heading level', () => {
    // The prompt templates `##`; the constant deliberately pins only the words,
    // leaving heading-level tolerance to the caller.
    expect(findBotSummaryThread([thread(3, '# Code Review — x')])?.id).toBe(3);
  });

  test('prefers the summary over the in-progress placeholder', () => {
    // Both start with the same words. The placeholder is replaced in place, but
    // a run that posted a fresh one would otherwise leave two candidates and the
    // wrong one could be closed.
    const threads = [
      thread(4, '## Code Review In Progress'),
      thread(5, '## Code Review — Adds retry backoff'),
    ];

    expect(findBotSummaryThread(threads)?.id).toBe(5);
  });

  test('falls back to the placeholder when that is all there is', () => {
    expect(findBotSummaryThread([thread(6, '## Code Review In Progress')])?.id).toBe(6);
  });

  test('ignores a human comment that merely mentions a code review', () => {
    // Matching the words anywhere would close a person's thread.
    const threads = [thread(7, 'Can you redo the code review on this?')];

    expect(findBotSummaryThread(threads)).toBeNull();
  });

  test('returns null when the bot has posted nothing', () => {
    expect(findBotSummaryThread([thread(8, 'unrelated')])).toBeNull();
  });

  test('takes the newest summary when a PR carries several', () => {
    // Re-reviews update in place, but an older run may have left one behind.
    // Threads arrive oldest-first from the API.
    const threads = [
      thread(9, '## Code Review — first pass'),
      thread(10, '## Code Review — second pass'),
    ];

    expect(findBotSummaryThread(threads)?.id).toBe(10);
  });
});
