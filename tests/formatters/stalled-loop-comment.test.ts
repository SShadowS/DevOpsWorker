import { describe, test, expect } from 'bun:test';
import {
  formatErrorComment,
  summarizeStalledLoop,
  isPipelineComment,
  truncateFinding,
  blockingFindings,
  formatStalledLoopComment,
  pipelineErrorComment,
  leadSentence,
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

// ---------------------------------------------------------------------------
// Markdown edition — headings, collapsibles, grouping, numbering
// ---------------------------------------------------------------------------

describe('formatStalledLoopComment (markdown)', () => {
  const state = stateWithReviews([
    [{ severity: 'critical', comment: 'A. '.repeat(200) }],
    [
      { severity: 'critical', comment: 'First claim. Then a long justification that follows it.', filePath: 'Cloud/Al/Table/Table 1 X.al' },
      { severity: 'major', comment: 'Second claim. More detail here.', filePath: 'Cloud/Al/Table/Table 1 X.al' },
      { severity: 'major', comment: 'Third claim. Detail.', filePath: 'Test/Src/Y.Codeunit.al' },
      { severity: 'minor', comment: 'a nit', filePath: 'Cloud/Al/Table/Table 1 X.al' },
    ],
  ]);

  const md = () => formatStalledLoopComment(
    63396, 'coding', 'Revision loop "coding" exhausted 2 attempts without approval', state,
  )!;

  test('numbers run 1..N in display order, with no gaps across file groups', () => {
    const nums = [...md().matchAll(/<b>(\d+)\.<\/b>/g)].map(m => Number(m[1]));
    expect(nums).toEqual([1, 2, 3]);
  });

  test('groups findings by file basename, not the full path', () => {
    const out = md();
    expect(out).toContain('**`Table 1 X.al`**');
    expect(out).toContain('**`Y.Codeunit.al`**');
    expect(out).not.toContain('Cloud/Al/Table/Table 1 X.al');
  });

  test('carries the FULL finding text inside the collapsible, not a truncation', () => {
    const out = md();
    expect(out).toContain('First claim. Then a long justification that follows it.');
    expect(out).not.toContain('…</summary>');
  });

  test('the summary line is the opening sentence', () => {
    expect(md()).toContain('<b>critical</b> — First claim.');
  });

  test('minor findings are counted out, not listed', () => {
    const out = md();
    expect(out).toContain('Blocking findings — 3 of 4');
    expect(out).toContain('1 further minor/suggestion finding(s) omitted');
    expect(out).not.toContain('a nit');
  });

  test('gives a copyable reply template referencing the numbers', () => {
    expect(md()).toContain('/fix fix 1, 3; drop 2');
  });

  test('says plainly that resuming without an answer changes nothing', () => {
    expect(md()).toContain('retries against the same reviewers with the same inputs');
  });

  test('null when the state shows no stalled loop', () => {
    expect(formatStalledLoopComment(1, 'coder', 'boom', stateWithReviews([]))).toBeNull();
  });

  // The reply template puts `/fix ...` at the START of a line inside a fenced
  // block — precisely the shape findRerunCommandInComments matches. If this were
  // not recognised as bot output, the pipeline would read its own example back
  // as the human's answer.
  test('is recognised as pipeline output despite quoting /fix at line start', () => {
    const out = md();
    expect(out).toMatch(/\n\/fix /);
    expect(isPipelineComment(out)).toBe(true);
  });
});

describe('pipelineErrorComment', () => {
  test('a stalled loop gets markdown', () => {
    const r = pipelineErrorComment(
      1, 'coding', new Error('exhausted'),
      stateWithReviews([[{ severity: 'critical', comment: 'x' }]]),
    );
    expect(r.format).toBe('markdown');
    expect(r.text).toContain('a decision is needed');
  });

  test('a crashed container keeps the plain HTML comment', () => {
    const r = pipelineErrorComment(1, 'coder', new Error('container exited 137'));
    expect(r.format).toBe('html');
    expect(r.text).toContain('🚨 Pipeline Error');
    expect(r.text).not.toContain('a decision is needed');
  });
});

describe('leadSentence', () => {
  test('stops at the first sentence', () => {
    expect(leadSentence('One. Two. Three.')).toBe('One.');
  });

  test('falls back to a length-trim when there is no sentence break', () => {
    const out = leadSentence('word '.repeat(80), 40);
    expect(out.endsWith('…')).toBe(true);
  });

  test('a decimal point does not end the sentence', () => {
    // `. ` requires whitespace, so "6175284." mid-token is not a break
    expect(leadSentence('Version 1.2 is affected. Next.')).toBe('Version 1.2 is affected.');
  });
});

// ---------------------------------------------------------------------------
// The other two loops
//
// The diagnostic was written for the coding loop and read only `codeReviews`.
// A planning loop that exhausted its budget therefore fell through to the bare
// "exhausted 5 attempts" comment with generic recovery options — the exact
// failure this section exists to prevent, on the loop that hits it most.
// Work item 81098 exhausted planning with five reviews on file and reported
// none of them.
// ---------------------------------------------------------------------------

/** A plan-reviewer issue: `description`/`relatedObject`/`category`, not `comment`/`filePath`. */
function stateWithPlanReviews(
  rounds: Array<Array<{ severity: string; description: string; relatedObject?: string; category?: string }>>,
  extra?: Partial<PipelineState>,
): PipelineState {
  return {
    currentStage: 'planning',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: 'now',
    planReviews: rounds.map((issues, i) => ({
      verdict: 'revise',
      feedback: `round ${i + 1} summary`,
      issues,
      revisionInstructions: i === rounds.length - 1 ? 'Cut the scope creep.' : undefined,
    })),
    ...extra,
  } as unknown as PipelineState;
}

describe('summarizeStalledLoop on the planning loop', () => {
  test('reads planReviews, not codeReviews', () => {
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [{ severity: 'critical', description: 'AC 4 has no test' }],
      [{ severity: 'critical', description: 'AC 4 has no test' }],
    ]), 'planning');

    expect(s).not.toBeNull();
    expect(s!.issueCounts).toEqual([1, 1]);
  });

  test('reads the issue text out of `description`', () => {
    const s = summarizeStalledLoop(
      stateWithPlanReviews([[{ severity: 'critical', description: 'AC 4 has no test' }]]),
      'planning',
    )!;

    expect(s.latest[0]!.comment).toBe('AC 4 has no test');
  });

  test('reads the location out of `relatedObject`', () => {
    const s = summarizeStalledLoop(
      stateWithPlanReviews([[
        { severity: 'critical', description: 'AC 4 has no test', relatedObject: 'CDO Events' },
      ]]),
      'planning',
    )!;

    expect(s.latest[0]!.filePath).toBe('CDO Events');
  });

  test('spots a recurring objection even when it is reworded each round', () => {
    // Reviewers restate an objection in new words every round, so matching on
    // exact text finds nothing. What repeats is the thing being objected to.
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [{ severity: 'critical', description: 'AC 4 has no test', relatedObject: 'CDO Events', category: 'testing' }],
      [{ severity: 'critical', description: 'Acceptance criterion 4 still lacks coverage', relatedObject: 'CDO Events', category: 'testing' }],
    ]), 'planning')!;

    expect(s.recurring).toHaveLength(1);
    expect(s.recurring[0]).toContain('CDO Events');
  });

  test('the error comment carries the diagnostic instead of bare recovery options', () => {
    // The shape work item 81098 produced: 5 rounds, counts 7/8/15/10/10.
    const rounds = [7, 8, 15, 10, 10].map((n, r) =>
      Array.from({ length: n }, (_, i) => ({
        severity: i === 0 ? 'critical' : 'minor',
        description: `round ${r + 1} issue ${i + 1}`,
        relatedObject: `Object ${i + 1}`,
        category: 'design',
      })),
    );
    const err = new Error('Revision loop "planning" exhausted 5 attempts without approval');

    const out = formatErrorComment(81098, 'planning', err, stateWithPlanReviews(rounds));

    expect(out).toContain('Why it is stuck');
    // `/rerun-plan`, not `/fix` — see "the reply command matches the stalled
    // loop" below. `/fix` rewinds to coding, which planning never reached.
    expect(out).toContain('/rerun-plan');
    // The bare form promoted a plain resume as "preferred"; with a diagnostic
    // attached, answering the reviewer is the option that changes anything.
    expect(out).not.toContain('(preferred)');
  });
});

describe('summarizeStalledLoop on the test-cases loop', () => {
  test('reads testCaseReviews', () => {
    const state = {
      currentStage: 'test-cases',
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: 'now',
      testCaseReviews: [
        { verdict: 'revise', feedback: 'r1', issues: [{ severity: 'major', description: 'step 3 is not verifiable' }] },
      ],
    } as unknown as PipelineState;

    const s = summarizeStalledLoop(state, 'test-cases')!;

    expect(s.latest[0]!.comment).toBe('step 3 is not verifiable');
  });
});

// ---------------------------------------------------------------------------
// Which repeated objections are worth naming
//
// Both flaws below were visible in the real WI 81098 comment once the planning
// loop started reporting at all: three of the seven "raised in more than one
// round" entries were things the reviewer had explicitly ACCEPTED — one was
// even "flagged as a positive" — and every entry printed at full paragraph
// length, which is the wall of text this section exists to avoid.
// ---------------------------------------------------------------------------

describe('recurring objections', () => {
  test('drops an objection that never blocked, however often it repeats', () => {
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [
        { severity: 'critical', description: 'the bracket leaks', relatedObject: 'Ctx', category: 'risk' },
        { severity: 'suggestion', description: 'nice pattern, accepted', relatedObject: 'Ctx', category: 'style' },
      ],
      [
        { severity: 'critical', description: 'the bracket still leaks', relatedObject: 'Ctx', category: 'risk' },
        { severity: 'suggestion', description: 'still a nice pattern', relatedObject: 'Ctx', category: 'style' },
      ],
    ]), 'planning')!;

    expect(s.recurring).toHaveLength(1);
    expect(s.recurring[0]).toContain('bracket');
  });

  test('keeps an objection that blocked in any one round', () => {
    // Severity moves between rounds. Blocking once is enough to have cost an
    // attempt, so it belongs in the list.
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [{ severity: 'minor', description: 'scope creep in the tests', relatedObject: 'Tests', category: 'scope-creep' }],
      [{ severity: 'major', description: 'scope creep in the tests, still', relatedObject: 'Tests', category: 'scope-creep' }],
    ]), 'planning')!;

    expect(s.recurring).toHaveLength(1);
  });

  test('quotes the newest blocking wording, not a later downgrade', () => {
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [{ severity: 'critical', description: 'FIRST blocking wording', relatedObject: 'Ctx', category: 'risk' }],
      [{ severity: 'major', description: 'SECOND blocking wording', relatedObject: 'Ctx', category: 'risk' }],
      [{ severity: 'suggestion', description: 'accepted now, no longer blocking', relatedObject: 'Ctx', category: 'risk' }],
    ]), 'planning')!;

    expect(s.recurring[0]).toContain('SECOND blocking wording');
  });

  test('still knows something repeated even when nothing blocking did', () => {
    // Otherwise the comment claims the reviewers raised different objections
    // every round — the opposite of what happened.
    const s = summarizeStalledLoop(stateWithPlanReviews([
      [{ severity: 'minor', description: 'a nit', relatedObject: 'Ctx', category: 'style' }],
      [{ severity: 'minor', description: 'the same nit', relatedObject: 'Ctx', category: 'style' }],
    ]), 'planning')!;

    expect(s.recurring).toEqual([]);
    expect(s.repeatedAny).toBe(true);
  });

  test('does not call it underspecified when only minor findings repeated', () => {
    const out = formatErrorComment(1, 'planning', new Error('exhausted'), stateWithPlanReviews([
      [{ severity: 'minor', description: 'a nit', relatedObject: 'Ctx', category: 'style' }],
      [{ severity: 'minor', description: 'the same nit', relatedObject: 'Ctx', category: 'style' }],
    ]));

    expect(out).not.toContain('underspecified');
  });

  test('trims a paragraph-length recurring finding', () => {
    const long = 'x'.repeat(900);
    const out = formatErrorComment(1, 'planning', new Error('exhausted'), stateWithPlanReviews([
      [{ severity: 'critical', description: long, relatedObject: 'Ctx', category: 'risk' }],
      [{ severity: 'critical', description: long, relatedObject: 'Ctx', category: 'risk' }],
    ]));

    expect(out).toContain('…');
    expect(out).not.toContain(long);
  });
});

// ---------------------------------------------------------------------------
// The reply command must match the loop that stalled
//
// WI 81098: the planning loop ran out of budget, and both the error comment and
// the markdown report told the human to answer with `/fix`. `/fix` is wired to
// rewind to `coding`, which had never run, so the coder's fix prompt read a
// branch name off a changeset that did not exist and the stage died with
// "undefined is not an object (evaluating 'changeset.branchName')". The
// pipeline instructed a human straight into a crash.
// ---------------------------------------------------------------------------

describe('the reply command matches the stalled loop', () => {
  const planningState = stateWithPlanReviews([
    [{ severity: 'critical', description: 'The guard is not self-healing.', relatedObject: 'Dispatch Context' }],
    [{ severity: 'critical', description: 'The guard is not self-healing.', relatedObject: 'Dispatch Context' }],
  ]);

  test('a stalled planning loop asks for /rerun-plan, never /fix', () => {
    const md = formatStalledLoopComment(
      81098, 'planning', 'Revision loop "planning" exhausted 5 attempts without approval', planningState,
    )!;
    expect(md).toContain('/rerun-plan');
    expect(md).not.toContain('/fix');
  });

  test('the planning error comment offers /rerun-plan as the answer-and-resume option', () => {
    const html = formatErrorComment(
      81098, 'planning',
      new Error('Revision loop "planning" exhausted 5 attempts without approval'),
      planningState,
    );
    expect(html).toContain('/rerun-plan');
    expect(html).not.toContain('/fix');
  });

  test('a stalled coding loop still asks for /fix', () => {
    const codingState = stateWithReviews([
      [{ severity: 'critical', comment: 'Missing permission set.' }],
      [{ severity: 'critical', comment: 'Missing permission set.' }],
    ]);
    const md = formatStalledLoopComment(
      63396, 'coding', 'Revision loop "coding" exhausted 2 attempts without approval', codingState,
    )!;
    expect(md).toContain('/fix');
    expect(md).not.toContain('/rerun-plan');
  });
});
