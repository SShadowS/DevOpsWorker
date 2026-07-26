import { describe, test, expect } from 'bun:test';
import {
  formatErrorComment,
  summarizeStalledLoop,
  isPipelineComment,
  truncateFinding,
  blockingFindings,
} from '../../src/formatters/devops-comment.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Stalled-loop diagnostics on the error comment
//
// "Revision loop exhausted 2 attempts without approval" plus three generic
// recovery options told the human nothing about what was blocking it, whether it
// was improving, or what they had to decide — so the only available move was to
// resume and hope, against the same reviewers that had just deadlocked.
// ---------------------------------------------------------------------------

function stateWithReviews(rounds: Array<Array<{ severity: string; comment: string; filePath?: string }>>, extra?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'coding',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: 'now',
    codeReviews: rounds.map((issues, i) => ({
      verdict: 'revise',
      feedback: `round ${i + 1} summary`,
      issues,
      revisionInstructions: i === rounds.length - 1 ? 'Fix the permission set first.' : undefined,
    })),
    ...extra,
  } as unknown as PipelineState;
}

describe('summarizeStalledLoop', () => {
  test('null when there are no reviews — nothing honest to report', () => {
    expect(summarizeStalledLoop(undefined, 'coding')).toBeNull();
    expect(summarizeStalledLoop(stateWithReviews([]), 'coding')).toBeNull();
  });

  test('derives counts from the reviews when the loop recorded none', () => {
    const s = summarizeStalledLoop(stateWithReviews([
      [{ severity: 'critical', comment: 'a' }, { severity: 'minor', comment: 'b' }],
      [{ severity: 'critical', comment: 'a' }],
    ]), 'coding')!;
    expect(s.issueCounts).toEqual([2, 1]);
  });

  test('prefers the loop-recorded counts when present', () => {
    const s = summarizeStalledLoop(
      stateWithReviews([[{ severity: 'critical', comment: 'a' }]], {
        revisionIssueCounts: { coding: [9, 9, 9] },
      }),
      'coding',
    )!;
    expect(s.issueCounts).toEqual([9, 9, 9]);
  });

  test('names findings raised in more than one round', () => {
    const s = summarizeStalledLoop(stateWithReviews([
      [{ severity: 'critical', comment: 'missing permission set' }, { severity: 'minor', comment: 'nit' }],
      [{ severity: 'critical', comment: 'missing permission set' }],
    ]), 'coding')!;
    expect(s.recurring).toEqual(['missing permission set']);
  });

  test('orders the latest round worst-first', () => {
    const s = summarizeStalledLoop(stateWithReviews([[
      { severity: 'minor', comment: 'c' },
      { severity: 'critical', comment: 'a' },
      { severity: 'major', comment: 'b' },
    ]]), 'coding')!;
    expect(s.latest.map(i => i.comment)).toEqual(['a', 'b', 'c']);
  });

  test('carries the last reviewer instructions', () => {
    const s = summarizeStalledLoop(stateWithReviews([[{ severity: 'critical', comment: 'a' }]]), 'coding')!;
    expect(s.revisionInstructions).toBe('Fix the permission set first.');
  });
});

describe('formatErrorComment with a stalled loop', () => {
  const state = stateWithReviews([
    [{ severity: 'critical', comment: 'missing permission set', filePath: 'Cloud/Al/P.al' }, { severity: 'major', comment: 'wrap in TryFunction' }],
    [{ severity: 'critical', comment: 'missing permission set', filePath: 'Cloud/Al/P.al' }, { severity: 'major', comment: 'remove the Try wrapper' }],
  ]);
  const err = new Error('Revision loop "coding" exhausted 2 attempts without approval');

  test('reports the trend, what recurs, what is outstanding, and what to decide', () => {
    const out = formatErrorComment(63396, 'coding', err, state);

    expect(out).toContain('Why it is stuck');
    expect(out).toContain('2 → 2');
    expect(out).toContain('not going down');
    expect(out).toContain('missing permission set');
    expect(out).toContain('Cloud/Al/P.al');
    expect(out).toContain('Fix the permission set first.');
    expect(out).toContain('What you need to decide');
    expect(out).toContain('wrong or out of scope');
  });

  test('leads with the option that actually changes the inputs', () => {
    const out = formatErrorComment(63396, 'coding', err, state);
    const answerAt = out.indexOf('Answer and resume');
    const resumeAt = out.indexOf('Resume from failed stage');
    expect(answerAt).toBeGreaterThan(-1);
    expect(answerAt).toBeLessThan(resumeAt);
    // and a plain resume is honestly labelled as changing nothing
    expect(out).toContain('retries with the same inputs');
  });

  test('a falling trend is not described as a deadlock', () => {
    const falling = stateWithReviews([
      [{ severity: 'critical', comment: 'a' }, { severity: 'major', comment: 'b' }, { severity: 'minor', comment: 'c' }],
      [{ severity: 'critical', comment: 'a' }],
    ]);
    const out = formatErrorComment(1, 'coding', err, falling);
    expect(out).toContain('budget ran out first');
    expect(out).not.toContain('not going down');
  });

  test('non-overlapping findings are called out as underspecification', () => {
    const differing = stateWithReviews([
      [{ severity: 'critical', comment: 'first objection' }],
      [{ severity: 'critical', comment: 'entirely different objection' }],
    ]);
    const out = formatErrorComment(1, 'coding', err, differing);
    expect(out).toContain('underspecified');
  });

  test('escapes finding text into the HTML comment', () => {
    const nasty = stateWithReviews([[{ severity: 'critical', comment: 'use <Table> & "quotes"' }]]);
    const out = formatErrorComment(1, 'coding', err, nasty);
    expect(out).toContain('&lt;Table&gt;');
    expect(out).not.toContain('<Table>');
  });

  test('unchanged for an error with no loop state — a crash is still a crash', () => {
    const out = formatErrorComment(1, 'coder', new Error('container exited 137'));
    expect(out).not.toContain('Why it is stuck');
    expect(out).not.toContain('Answer and resume');
    expect(out).toContain('(preferred)');
  });
});

// ---------------------------------------------------------------------------
// The pipeline must not read its own comments as the human's reply
// ---------------------------------------------------------------------------

describe('bot-comment recognition', () => {
  test('the stalled-loop error comment is recognised as pipeline output', () => {
    const out = formatErrorComment(
      63396,
      'coding',
      new Error('exhausted'),
      stateWithReviews([[{ severity: 'critical', comment: 'a' }]]),
    );
    // It instructs the human to reply with `/fix ...`; if the rerun scan did not
    // recognise it as bot output, the pipeline could answer itself.
    expect(out).toContain('/fix');
    expect(isPipelineComment(out)).toBe(true);
  });

  test('a plain human comment is not mistaken for pipeline output', () => {
    expect(isPipelineComment('<p>/fix drop the Try wrapper, it was wrong</p>')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keeping the comment decision-shaped
//
// Real findings run to paragraph length — WI 63396's last round had 22, several
// over 1,500 characters. Rendered in full that is a wall of text nobody reads,
// which fails the same way the bare error did.
// ---------------------------------------------------------------------------

describe('truncateFinding', () => {
  test('leaves short text alone', () => {
    expect(truncateFinding('short', 100)).toBe('short');
  });

  test('cuts at a word boundary and marks the cut', () => {
    const out = truncateFinding('alpha beta gamma delta epsilon', 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain('gamm…');
  });

  test('a single long word is cut mid-word rather than emptied', () => {
    const out = truncateFinding('x'.repeat(50), 10);
    expect(out).toBe('x'.repeat(10) + '…');
  });
});

describe('blockingFindings', () => {
  test('keeps critical and major, drops minor and suggestion', () => {
    expect(blockingFindings([
      { severity: 'critical' }, { severity: 'major' },
      { severity: 'minor' }, { severity: 'suggestion' },
    ]).map(f => f.severity)).toEqual(['critical', 'major']);
  });
});

describe('comment length discipline', () => {
  test('lists blocking findings only, capped, with the omitted count', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      severity: i < 10 ? 'critical' : 'minor',
      comment: `finding number ${i} `.repeat(60),
    }));
    const out = formatErrorComment(
      1, 'coding', new Error('exhausted'), stateWithReviews([many]),
    );

    expect(out).toContain('Blocking after the last round (10 of 12 findings)');
    expect(out).toContain('and 2 more blocking');
    // every rendered finding is trimmed, not dumped whole
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(12000);
  });

  test('minor-only rounds render no blocking list at all', () => {
    const out = formatErrorComment(
      1, 'coding', new Error('exhausted'),
      stateWithReviews([[{ severity: 'minor', comment: 'nit' }]]),
    );
    expect(out).not.toContain('Blocking after the last round');
    // but the section still exists — the trend alone is worth reporting
    expect(out).toContain('Why it is stuck');
  });
});
