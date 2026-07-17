import { describe, test, expect } from 'bun:test';
import {
  detectWork,
  isCheckpointScannable,
  isPrCompletedCandidate,
  isReprovisionCandidate,
  sinceFor,
  type WorkDetectionInputs,
  type CheckpointScan,
  type PlanApprovedItem,
} from '../../../src/cli/watch/work-detector.ts';
import type { PipelineState, TestCaseFailure } from '../../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    currentStage: 'x',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a WorkDetectionInputs with empty defaults for every path. */
function inputs(overrides: Partial<WorkDetectionInputs> = {}): WorkDetectionInputs {
  return {
    skipIds: new Set<number>(),
    needInputIds: new Set<number>(),
    analyseIds: [],
    planApproved: [],
    checkpointScans: [],
    prCompleted: [],
    reprovision: [],
    ...overrides,
  };
}

function scan(overrides: Partial<CheckpointScan> & { id: number }): CheckpointScan {
  return {
    rerunPlanFeedback: null,
    fixFeedback: null,
    fixTestFeedback: null,
    fixTestSource: null,
    ...overrides,
  };
}

const FAILURES: TestCaseFailure[] = [
  { testCaseId: 1, title: 'T', outcome: 'Failed', failedSteps: [] },
];

// ---------------------------------------------------------------------------
// Path 1 — analyse tag → start-fresh
// ---------------------------------------------------------------------------

describe('detectWork — analyse tag', () => {
  test('emits start-fresh for each analyse id', () => {
    const actions = detectWork(inputs({ analyseIds: [101, 102] }));
    expect(actions).toEqual([
      { kind: 'start-fresh', workItemId: 101 },
      { kind: 'start-fresh', workItemId: 102 },
    ]);
  });

  test('honours analyse even when state exists / need-input present', () => {
    // analyse is an explicit "restart from scratch" signal — never gated by need-input
    const actions = detectWork(inputs({ analyseIds: [101], needInputIds: new Set([101]) }));
    expect(actions.map(a => a.kind)).toEqual(['start-fresh']);
  });

  test('skips ids in the skip set', () => {
    const actions = detectWork(inputs({ analyseIds: [101, 102, 103], skipIds: new Set([102]) }));
    expect(actions.map(a => a.workItemId)).toEqual([101, 103]);
  });
});

// ---------------------------------------------------------------------------
// Path 2 — plan-approved tag → continue (checkpoint-ready OR error-resume)
// ---------------------------------------------------------------------------

describe('detectWork — plan-approved tag', () => {
  test('continues an item paused at the plan-approved checkpoint (no delta)', () => {
    const pa: PlanApprovedItem = { id: 200, state: baseState({ checkpoint: { name: 'plan-approved', enteredAt: 't' } }) };
    const actions = detectWork(inputs({ planApproved: [pa] }));
    expect(actions.length).toBe(1);
    expect(actions[0]!.kind).toBe('continue');
    expect(actions[0]!.workItemId).toBe(200);
    expect(actions[0]!.stateDelta).toBeUndefined();
  });

  test('error-resume: clears error when need-input is absent', () => {
    const pa: PlanApprovedItem = {
      id: 201,
      state: baseState({ error: { type: 'AgentExecutionError', stage: 'coding', message: 'boom', timestamp: 't' } }),
    };
    const actions = detectWork(inputs({ planApproved: [pa] }));
    expect(actions.length).toBe(1);
    expect(actions[0]!.kind).toBe('continue');
    expect(actions[0]!.stateDelta).toEqual({ error: undefined });
    // Non-revision-exhausted must NOT set skipResetState
    expect('skipResetState' in (actions[0]!.stateDelta ?? {})).toBe(false);
  });

  test('error-resume: sets skipResetState when error is revision-exhausted', () => {
    const pa: PlanApprovedItem = {
      id: 202,
      state: baseState({ error: { type: 'revision-exhausted', stage: 'coding', message: 'boom', timestamp: 't' } }),
    };
    const actions = detectWork(inputs({ planApproved: [pa] }));
    expect(actions[0]!.stateDelta).toEqual({ error: undefined, skipResetState: true });
  });

  test('error-resume suppressed while need-input tag is present', () => {
    const pa: PlanApprovedItem = {
      id: 203,
      state: baseState({ error: { type: 'AgentExecutionError', stage: 'coding', message: 'boom', timestamp: 't' } }),
    };
    const actions = detectWork(inputs({ planApproved: [pa], needInputIds: new Set([203]) }));
    expect(actions).toEqual([]);
  });

  test('no action when plan-approved item has neither the checkpoint nor an error', () => {
    const pa: PlanApprovedItem = { id: 204, state: baseState({ checkpoint: { name: 'pr-published', enteredAt: 't' } }) };
    expect(detectWork(inputs({ planApproved: [pa] }))).toEqual([]);
  });

  test('null state yields no action', () => {
    const pa: PlanApprovedItem = { id: 205, state: null };
    expect(detectWork(inputs({ planApproved: [pa] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Paths 3/4/5 — /rerun-plan, /fix, /fix-test comment scans
// ---------------------------------------------------------------------------

describe('detectWork — /rerun-plan', () => {
  test('rewinds to planning, strips the command from humanFeedback, removes both tags', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 300, rerunPlanFeedback: '/rerun-plan tighten the spec' })],
    }));
    expect(actions.length).toBe(1);
    const a = actions[0]!;
    expect(a.kind).toBe('rerun');
    expect(a.workItemId).toBe(300);
    expect(a.stateDelta).toEqual({
      error: undefined,
      checkpoint: undefined,
      revisionFeedback: { source: 'work-item-comment', feedback: '/rerun-plan tighten the spec', targetStage: 'planning' },
      humanFeedback: { rerunComment: 'tighten the spec', source: 'work-item-comment' },
    });
    expect(a.tagOps).toEqual({ remove: ['need-input', 'plan-approved'] });
  });

  test('falls back to the raw feedback when nothing follows the command', () => {
    const actions = detectWork(inputs({ checkpointScans: [scan({ id: 301, rerunPlanFeedback: '/rerun-plan' })] }));
    expect(actions[0]!.stateDelta!.humanFeedback!.rerunComment).toBe('/rerun-plan');
  });
});

describe('detectWork — /fix', () => {
  test('rewinds to coding with rerunMode fix, removes need-input only', () => {
    const actions = detectWork(inputs({ checkpointScans: [scan({ id: 310, fixFeedback: '/fix null-ref in codeunit' })] }));
    const a = actions[0]!;
    expect(a.kind).toBe('rerun');
    expect(a.stateDelta).toEqual({
      error: undefined,
      checkpoint: undefined,
      rerunMode: 'fix',
      revisionFeedback: { source: 'work-item-comment', feedback: '/fix null-ref in codeunit', targetStage: 'coding' },
      humanFeedback: { rerunComment: 'null-ref in codeunit', source: 'work-item-comment' },
    });
    expect(a.tagOps).toEqual({ remove: ['need-input'] });
  });
});

describe('detectWork — /fix-test', () => {
  test('work-item source: attaches test case failures, rerunMode fix-test', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 320, fixTestFeedback: '/fix-test see failing steps', fixTestSource: 'work-item-comment', testCaseFailures: FAILURES })],
    }));
    const a = actions[0]!;
    expect(a.kind).toBe('rerun');
    expect(a.stateDelta).toEqual({
      error: undefined,
      checkpoint: undefined,
      rerunMode: 'fix-test',
      revisionFeedback: { source: 'work-item-comment', feedback: '/fix-test see failing steps', targetStage: 'coding' },
      humanFeedback: { rerunComment: 'see failing steps', source: 'work-item-comment', testCaseFailures: FAILURES },
    });
    expect(a.tagOps).toEqual({ remove: ['need-input'] });
  });

  test('pr-comment source: revisionFeedback + humanFeedback both tagged pr-comment', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 321, fixTestFeedback: '/fix-test', fixTestSource: 'pr-comment', testCaseFailures: undefined })],
    }));
    const a = actions[0]!;
    expect(a.stateDelta!.revisionFeedback!.source).toBe('pr-comment');
    expect(a.stateDelta!.humanFeedback!.source).toBe('pr-comment');
    expect(a.stateDelta!.humanFeedback!.testCaseFailures).toBeUndefined();
  });
});

describe('detectWork — comment-scan precedence', () => {
  test('rerun-plan wins over fix and fix-test', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 330, rerunPlanFeedback: '/rerun-plan a', fixFeedback: '/fix b', fixTestFeedback: '/fix-test c', fixTestSource: 'work-item-comment' })],
    }));
    expect(actions[0]!.stateDelta!.revisionFeedback!.targetStage).toBe('planning');
  });

  test('fix wins over fix-test', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 331, fixFeedback: '/fix b', fixTestFeedback: '/fix-test c', fixTestSource: 'work-item-comment' })],
    }));
    expect(actions[0]!.stateDelta!.rerunMode).toBe('fix');
  });

  test('an all-null scan produces no action', () => {
    expect(detectWork(inputs({ checkpointScans: [scan({ id: 332 })] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path 6 — completed PR → auto-continue
// ---------------------------------------------------------------------------

describe('detectWork — PR completed', () => {
  test('continues when PR status is completed', () => {
    const actions = detectWork(inputs({ prCompleted: [{ id: 400, prStatus: { status: 'completed', isDraft: false } }] }));
    expect(actions.length).toBe(1);
    expect(actions[0]!.kind).toBe('pr-completed');
    expect(actions[0]!.workItemId).toBe(400);
  });

  test('no action when PR is still active', () => {
    expect(detectWork(inputs({ prCompleted: [{ id: 401, prStatus: { status: 'active', isDraft: false } }] }))).toEqual([]);
  });

  test('no action when PR status is unavailable', () => {
    expect(detectWork(inputs({ prCompleted: [{ id: 402, prStatus: null }] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path 7 — /reprovision-env
// ---------------------------------------------------------------------------

describe('detectWork — /reprovision-env', () => {
  test('emits a reprovision action when the comment is found', () => {
    const actions = detectWork(inputs({ reprovision: [{ id: 500, commentFound: true }] }));
    expect(actions).toEqual([{ kind: 'reprovision', workItemId: 500, log: 'Found /reprovision-env PR comment — scheduling environment reprovision' }]);
  });

  test('no action when the comment is absent', () => {
    expect(detectWork(inputs({ reprovision: [{ id: 501, commentFound: false }] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Precedence / dedup across paths
// ---------------------------------------------------------------------------

describe('detectWork — cross-path precedence & dedup', () => {
  test('an item claimed by analyse is not re-detected by the comment scan', () => {
    const actions = detectWork(inputs({
      analyseIds: [600],
      checkpointScans: [scan({ id: 600, rerunPlanFeedback: '/rerun-plan x' })],
    }));
    expect(actions).toEqual([{ kind: 'start-fresh', workItemId: 600 }]);
  });

  test('a rerun-claimed item is not re-detected by PR-completed or reprovision', () => {
    const actions = detectWork(inputs({
      checkpointScans: [scan({ id: 601, fixFeedback: '/fix x' })],
      prCompleted: [{ id: 601, prStatus: { status: 'completed', isDraft: false } }],
      reprovision: [{ id: 601, commentFound: true }],
    }));
    expect(actions.length).toBe(1);
    expect(actions[0]!.kind).toBe('rerun');
  });

  test('analyse and plan-approved BOTH fire for the same id (behaviour preserved, not deduped)', () => {
    // The legacy poll intentionally does not dedup path 2 against path 1.
    const pa: PlanApprovedItem = { id: 602, state: baseState({ checkpoint: { name: 'plan-approved', enteredAt: 't' } }) };
    const actions = detectWork(inputs({ analyseIds: [602], planApproved: [pa] }));
    expect(actions.map(a => a.kind)).toEqual(['start-fresh', 'continue']);
  });

  test('skipIds are honoured on every path', () => {
    const actions = detectWork(inputs({
      skipIds: new Set([700, 701, 702, 703]),
      analyseIds: [700],
      planApproved: [{ id: 701, state: baseState({ checkpoint: { name: 'plan-approved', enteredAt: 't' } }) }],
      checkpointScans: [scan({ id: 702, fixFeedback: '/fix x' })],
      prCompleted: [{ id: 703, prStatus: { status: 'completed', isDraft: false } }],
    }));
    expect(actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Exported pure predicates (I/O gating shared with the gather layer)
// ---------------------------------------------------------------------------

describe('isCheckpointScannable', () => {
  test('true for error state', () => {
    expect(isCheckpointScannable(baseState({ error: { type: 'E', stage: 's', message: 'm', timestamp: 't' } }))).toBe(true);
  });
  test('true for plan-approved / pr-published checkpoints', () => {
    expect(isCheckpointScannable(baseState({ checkpoint: { name: 'plan-approved', enteredAt: 't' } }))).toBe(true);
    expect(isCheckpointScannable(baseState({ checkpoint: { name: 'pr-published', enteredAt: 't' } }))).toBe(true);
  });
  test('false for other checkpoints and for completed items', () => {
    expect(isCheckpointScannable(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' } }))).toBe(false);
    expect(isCheckpointScannable(baseState({ completedAt: 't', error: { type: 'E', stage: 's', message: 'm', timestamp: 't' } }))).toBe(false);
    expect(isCheckpointScannable(baseState())).toBe(false);
  });
});

describe('isPrCompletedCandidate', () => {
  const pr = { id: 9, url: 'u', isDraft: false, sourceBranch: 'b', targetBranch: 'm', title: 'T', description: 'D', linkedWorkItemId: 1 } as PipelineState['draftPR'];
  test('true for pr-completed / pr-published checkpoint with a PR and no error', () => {
    expect(isPrCompletedCandidate(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' }, draftPR: pr }))).toBe(true);
    expect(isPrCompletedCandidate(baseState({ checkpoint: { name: 'pr-published', enteredAt: 't' }, draftPR: pr }))).toBe(true);
  });
  test('false when errored, completed, or missing a PR', () => {
    expect(isPrCompletedCandidate(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' }, draftPR: pr, error: { type: 'E', stage: 's', message: 'm', timestamp: 't' } }))).toBe(false);
    expect(isPrCompletedCandidate(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' } }))).toBe(false);
    expect(isPrCompletedCandidate(baseState({ completedAt: 't', checkpoint: { name: 'pr-completed', enteredAt: 't' }, draftPR: pr }))).toBe(false);
  });
});

describe('isReprovisionCandidate', () => {
  const pr = { id: 9, url: 'u', isDraft: false, sourceBranch: 'b', targetBranch: 'm', title: 'T', description: 'D', linkedWorkItemId: 1 } as PipelineState['draftPR'];
  test('true when a PR exists and the item is at any checkpoint or in error', () => {
    expect(isReprovisionCandidate(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' }, draftPR: pr }))).toBe(true);
    expect(isReprovisionCandidate(baseState({ error: { type: 'E', stage: 's', message: 'm', timestamp: 't' }, draftPR: pr }))).toBe(true);
  });
  test('false without a PR, when completed, or when neither checkpoint nor error', () => {
    expect(isReprovisionCandidate(baseState({ checkpoint: { name: 'pr-completed', enteredAt: 't' } }))).toBe(false);
    expect(isReprovisionCandidate(baseState({ completedAt: 't', draftPR: pr, checkpoint: { name: 'pr-completed', enteredAt: 't' } }))).toBe(false);
    expect(isReprovisionCandidate(baseState({ draftPR: pr }))).toBe(false);
  });
});

describe('sinceFor', () => {
  test('prefers the error timestamp, else the checkpoint entry time', () => {
    expect(sinceFor(baseState({ error: { type: 'E', stage: 's', message: 'm', timestamp: 'E-TS' }, checkpoint: { name: 'x', enteredAt: 'C-TS' } }))).toBe('E-TS');
    expect(sinceFor(baseState({ checkpoint: { name: 'x', enteredAt: 'C-TS' } }))).toBe('C-TS');
    expect(sinceFor(baseState())).toBeUndefined();
  });
});
