import { describe, test, expect } from 'bun:test';
import { revisionLoop, hasPlateaued, recurringFindings } from '../../src/pipeline/revision-loop.ts';
import { countCodeReviewIssues, collectCodeReviewFindings } from '../../src/pipeline/pipeline-definition.ts';
import { isCheckpointScannable, isConvergenceCheckpoint } from '../../src/cli/watch/work-detector.ts';
import { formatConvergenceEscalation } from '../../src/formatters/devops-comment.ts';
import type { Stage, PipelineState, PipelineContext } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Convergence trigger + third loop outcome (design §4.1 / §4.3)
//
// Before this the only exits were approval and budget exhaustion, so a loop that
// could not converge spent its whole budget proving it. WI 63396: 8 rounds,
// into three figures of spend, 0 merges — and a rerun capped at 2 attempts still exhausted.
// ---------------------------------------------------------------------------

describe('hasPlateaued', () => {
  test('falling counts are not a plateau', () => {
    expect(hasPlateaued([9, 6, 3], 3)).toBe(false);
  });

  test('flat counts are a plateau — same findings round after round', () => {
    expect(hasPlateaued([5, 5, 5], 3)).toBe(true);
  });

  test('rising counts are a plateau', () => {
    expect(hasPlateaued([3, 5, 8], 3)).toBe(true);
  });

  test('only the most recent window counts — an old improvement does not excuse a current stall', () => {
    expect(hasPlateaued([20, 4, 4, 4], 3)).toBe(true);
  });

  test('a single decrease inside the window clears it', () => {
    expect(hasPlateaued([5, 5, 4], 3)).toBe(false);
  });

  test('does not fire before the window is full', () => {
    expect(hasPlateaued([5, 5], 3)).toBe(false);
  });

  test('a window below 2 can never plateau — guards a misconfiguration', () => {
    expect(hasPlateaued([5, 5, 5], 1)).toBe(false);
    expect(hasPlateaued([5, 5, 5], 0)).toBe(false);
  });
});

describe('recurringFindings', () => {
  test('returns only findings seen in more than one round', () => {
    expect(recurringFindings([
      ['missing permission set', 'add SetLoadFields'],
      ['missing permission set', 'unrelated nit'],
    ])).toEqual(['missing permission set']);
  });

  test('a repeat within one round is not recurrence across rounds', () => {
    expect(recurringFindings([['same', 'same']])).toEqual([]);
  });

  test('no overlap yields nothing — reviewers raising fresh objections each round', () => {
    expect(recurringFindings([['a'], ['b'], ['c']])).toEqual([]);
  });
});

describe('code-review issue accessors', () => {
  test('counts the latest round only', () => {
    const state = {
      codeReviews: [
        { verdict: 'revise', feedback: '', issues: [{}, {}] },
        { verdict: 'revise', feedback: '', issues: [{}, {}, {}, {}] },
      ],
    } as unknown as PipelineState;
    expect(countCodeReviewIssues(state)).toBe(4);
  });

  test('undefined when no review has landed — the trigger then cannot fire', () => {
    expect(countCodeReviewIssues({} as PipelineState)).toBeUndefined();
    expect(countCodeReviewIssues({ codeReviews: [] } as unknown as PipelineState)).toBeUndefined();
  });

  test('undefined when the review carries no issues array', () => {
    const state = { codeReviews: [{ verdict: 'approve', feedback: '' }] } as unknown as PipelineState;
    expect(countCodeReviewIssues(state)).toBeUndefined();
  });

  test('collects finding texts per round', () => {
    const state = {
      codeReviews: [
        { verdict: 'revise', feedback: '', issues: [{ comment: 'one' }, { comment: '' }] },
        { verdict: 'revise', feedback: '', issues: [{ comment: 'two' }] },
      ],
    } as unknown as PipelineState;
    expect(collectCodeReviewFindings(state)).toEqual([['one'], ['two']]);
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function ctx(): PipelineContext {
  return {
    workItemId: 63396,
    workItem: { id: 63396, title: 'T', type: 'User Story', state: 'Active', areaPath: 'A', iterationPath: 'A', fields: {} },
    workItemType: 'User Story',
    config: {
      azureDevOps: { organization: 'o', orgUrl: 'https://o', project: 'P', repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2, areaPath: 'A', iterationPath: 'A', pat: 'p' },
      paths: { sessionRoot: '/s', targetRepo: '/s/r', stateDir: '/st' },
      checkpoints: { planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 }, prPublished: { fixCommand: '/f', timeoutHours: 1 }, pollIntervalMinutes: 1 },
      revisionLoops: { maxAttempts: 8 },
      models: { default: 'test' },
      costs: {},
      repoKey: 'R',
      layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
    },
  } as PipelineContext;
}

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'coding',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  } as PipelineState;
}

/** A loop whose reviewer emits a scripted issue count per round. */
function loopEmitting(counts: number[], opts?: { window?: number }) {
  let round = 0;
  const producerRuns: number[] = [];

  const producer: Stage = {
    name: 'coder',
    canRun: () => true,
    execute: async (s) => { producerRuns.push(++round); return { state: s }; },
  };
  const reviewer: Stage = {
    name: 'code-reviewer',
    canRun: () => true,
    execute: async (s) => ({
      state: {
        ...s,
        codeReviews: [
          ...(s.codeReviews ?? []),
          {
            verdict: 'revise',
            feedback: 'f',
            issues: Array.from({ length: counts[round - 1] ?? 0 }, (_, i) => ({ comment: 'finding-' + i })),
          },
        ] as never,
      },
    }),
  };

  return {
    producerRuns,
    stage: revisionLoop({
      name: 'coding',
      producer,
      reviewer,
      maxAttempts: 8,
      isApproved: () => false,
      countIssues: countCodeReviewIssues,
      collectFindingTexts: collectCodeReviewFindings,
      convergence: { window: opts?.window ?? 3, question: 'What should actually be fixed?' },
    }),
  };
}

describe('revisionLoop convergence escalation', () => {
  test('pauses instead of exhausting the budget when the count stops falling', async () => {
    const { stage, producerRuns } = loopEmitting([5, 5, 5, 5, 5, 5, 5, 5]);
    const result = await stage.execute(freshState(), ctx());

    expect(result.signal).toEqual({ kind: 'pause' });
    expect(result.state.checkpoint?.name).toBe('convergence:coding');
    expect(result.state.convergenceEscalation?.loop).toBe('coding');
    expect(result.state.convergenceEscalation?.issueCounts).toEqual([5, 5, 5]);
    expect(result.state.convergenceEscalation?.question).toContain('What should actually be fixed?');
    // stopped at round 3 of a budget of 8 — the whole point
    expect(producerRuns).toHaveLength(3);
  });

  test('names the findings that recurred across rounds', async () => {
    const { stage } = loopEmitting([2, 2, 2]);
    const result = await stage.execute(freshState(), ctx());
    // finding-0 and finding-1 are emitted every round
    expect(result.state.convergenceEscalation?.recurringFindings).toEqual(['finding-0', 'finding-1']);
  });

  test('keeps iterating while the count is still falling', async () => {
    // 9 -> 6 -> 3 -> 1 -> 0, never flat until late: runs past the window
    const { stage, producerRuns } = loopEmitting([9, 6, 3, 1, 0, 0, 0, 0]);
    await stage.execute(freshState(), ctx()).catch(() => undefined);
    expect(producerRuns.length).toBeGreaterThan(3);
  });

  test('an improvement resets the run of flat rounds', async () => {
    // 5,5 is 2 flat; the drop to 3 clears it, so escalation needs 3 more rounds
    const { stage } = loopEmitting([5, 5, 3, 3, 3]);
    const result = await stage.execute(freshState(), ctx());
    expect(result.state.convergenceEscalation?.issueCounts).toEqual([5, 5, 3, 3, 3]);
  });

  test('does nothing when no convergence config is supplied', async () => {
    // planning and test-cases keep budget exhaustion as their only exit
    const producer: Stage = { name: 'p', canRun: () => true, execute: async (s) => ({ state: s }) };
    const reviewer: Stage = { name: 'r', canRun: () => true, execute: async (s) => ({ state: s }) };
    const stage = revisionLoop({
      name: 'planning', producer, reviewer, maxAttempts: 2, isApproved: () => false,
    });
    await expect(stage.execute(freshState(), ctx())).rejects.toThrow(/exhausted 2 attempts/);
  });

  test('does not fire when countIssues cannot measure', async () => {
    const producer: Stage = { name: 'p', canRun: () => true, execute: async (s) => ({ state: s }) };
    const reviewer: Stage = { name: 'r', canRun: () => true, execute: async (s) => ({ state: s }) };
    const stage = revisionLoop({
      name: 'coding', producer, reviewer, maxAttempts: 2, isApproved: () => false,
      countIssues: () => undefined,
      convergence: { window: 2, question: 'q' },
    });
    await expect(stage.execute(freshState(), ctx())).rejects.toThrow(/exhausted 2 attempts/);
  });

  test('re-entry after escalation clears the marker and resets the history', async () => {
    // Without this the loop pauses again before running anything, and the stale
    // plateau re-escalates on the very next round.
    const { stage, producerRuns } = loopEmitting([5, 5, 5, 5, 5, 5]);
    const resumed = freshState({
      convergenceEscalation: {
        loop: 'coding', issueCounts: [5, 5, 5], recurringFindings: [], question: 'q',
        escalatedAt: new Date().toISOString(),
      },
      revisionIssueCounts: { coding: [5, 5, 5] },
      rerunMode: 'fix',
    });

    const result = await stage.execute(resumed, ctx());

    // it escalated again only after three FRESH flat rounds, not immediately
    expect(producerRuns).toHaveLength(3);
    expect(result.state.convergenceEscalation?.issueCounts).toEqual([5, 5, 5]);
  });

  test('an escalation from a different loop is left alone', async () => {
    const { stage } = loopEmitting([5, 5, 5]);
    const resumed = freshState({
      convergenceEscalation: {
        loop: 'planning', issueCounts: [1], recurringFindings: [], question: 'q',
        escalatedAt: new Date().toISOString(),
      },
    });
    const result = await stage.execute(resumed, ctx());
    // the coding loop set its own escalation rather than clearing planning's
    expect(result.state.convergenceEscalation?.loop).toBe('coding');
  });
});

// ---------------------------------------------------------------------------
// Reachability: the escalation must not be a dead end
// ---------------------------------------------------------------------------

describe('convergence escalations are reachable by the watcher', () => {
  test('a convergence pause is scanned for /fix', () => {
    const state = freshState({ checkpoint: { name: 'convergence:coding', enteredAt: 'now' } });
    expect(isConvergenceCheckpoint('convergence:coding')).toBe(true);
    expect(isCheckpointScannable(state)).toBe(true);
  });

  test('unrelated checkpoints are still gated by the allowlist', () => {
    const state = freshState({ checkpoint: { name: 'some-other-gate', enteredAt: 'now' } });
    expect(isCheckpointScannable(state)).toBe(false);
  });

  test('a completed item is never scanned', () => {
    const state = freshState({
      checkpoint: { name: 'convergence:coding', enteredAt: 'now' },
      completedAt: 'now',
    } as Partial<PipelineState>);
    expect(isCheckpointScannable(state)).toBe(false);
  });
});

describe('formatConvergenceEscalation', () => {
  test('reports the trend, the recurring findings, and the question', () => {
    const out = formatConvergenceEscalation(63396, freshState({
      convergenceEscalation: {
        loop: 'coding',
        issueCounts: [7, 7, 8],
        recurringFindings: ['missing permission set'],
        question: 'Reply with /fix <answer>.',
        escalatedAt: 'now',
      },
    }))!;

    expect(out).toContain('63396');
    expect(out).toContain('7 → 7 → 8');
    expect(out).toContain('missing permission set');
    expect(out).toContain('/fix <answer>');
  });

  test('calls out non-overlapping findings as its own signal', () => {
    const out = formatConvergenceEscalation(1, freshState({
      convergenceEscalation: {
        loop: 'coding', issueCounts: [4, 4, 4], recurringFindings: [], question: 'q', escalatedAt: 'now',
      },
    }))!;
    expect(out).toContain('different');
    expect(out).toContain('underspecified');
  });

  test('silent on a normal completion, so it can sit in the stage-keyed map', () => {
    expect(formatConvergenceEscalation(1, freshState())).toBeNull();
  });
});
