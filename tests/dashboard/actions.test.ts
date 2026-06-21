import { describe, test, expect } from 'bun:test';
import { validateAction, getAvailableActions } from '../../src/dashboard/actions.ts';
import type { PipelineAction } from '../../src/dashboard/actions.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    currentStage: 'analyzer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAction(overrides: Partial<PipelineAction> = {}): PipelineAction {
  return {
    workItemId: 42,
    type: 'continue',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------------------

describe('actions: validateAction', () => {
  test('returns invalid for null state', () => {
    const result = validateAction(makeAction(), null);
    expect(result.valid).toBe(false);
  });

  // approve-plan
  test('approve-plan: valid when at plan-approved checkpoint', () => {
    const state = freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:00:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'approve-plan' }), state);
    expect(result.valid).toBe(true);
  });

  test('approve-plan: invalid when not at checkpoint', () => {
    const state = freshState({ currentStage: 'coding' });
    const result = validateAction(makeAction({ type: 'approve-plan' }), state);
    expect(result.valid).toBe(false);
  });

  // rerun-plan
  test('rerun-plan: valid when at plan-approved checkpoint', () => {
    const state = freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:00:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'rerun-plan' }), state);
    expect(result.valid).toBe(true);
  });

  test('rerun-plan: valid when failed during planning', () => {
    const state = freshState({
      currentStage: 'planning',
      error: { type: 'RevisionExhaustedError', stage: 'planning', message: 'exhausted', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'rerun-plan' }), state);
    expect(result.valid).toBe(true);
  });

  test('rerun-plan: invalid when running at coding stage', () => {
    const state = freshState({ currentStage: 'coding' });
    const result = validateAction(makeAction({ type: 'rerun-plan' }), state);
    expect(result.valid).toBe(false);
  });

  // fix
  test('fix: valid when at pr-published checkpoint', () => {
    const state = freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'fix' }), state);
    expect(result.valid).toBe(true);
  });

  test('fix: valid when failed during coding', () => {
    const state = freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'fail', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'fix' }), state);
    expect(result.valid).toBe(true);
  });

  test('fix: invalid when at plan checkpoint', () => {
    const state = freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:00:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'fix' }), state);
    expect(result.valid).toBe(false);
  });

  // continue
  test('continue: valid when pipeline has error', () => {
    const state = freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'crash', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    const result = validateAction(makeAction({ type: 'continue' }), state);
    expect(result.valid).toBe(true);
  });

  test('continue: invalid when no error', () => {
    const state = freshState({ currentStage: 'coding' });
    const result = validateAction(makeAction({ type: 'continue' }), state);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAvailableActions
// ---------------------------------------------------------------------------

describe('actions: getAvailableActions', () => {
  test('running pipeline → no actions', () => {
    const state = freshState({ currentStage: 'coding', startedAt: new Date().toISOString() });
    expect(getAvailableActions(state)).toEqual([]);
  });

  test('stalled pipeline → continue action', () => {
    const state = freshState({
      currentStage: 'coding',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(getAvailableActions(state)).toEqual(['continue']);
  });

  test('completed pipeline → no actions', () => {
    const state = freshState({
      currentStage: 'documenter',
      completedAt: '2024-01-01T01:00:00.000Z',
    });
    expect(getAvailableActions(state)).toEqual([]);
  });

  test('plan checkpoint → approve-plan + rerun-plan', () => {
    const state = freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:20:00.000Z' },
    });
    expect(getAvailableActions(state)).toEqual(['approve-plan', 'rerun-plan']);
  });

  test('pr checkpoint → rerun-plan + fix', () => {
    const state = freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
    });
    expect(getAvailableActions(state)).toEqual(['rerun-plan', 'fix']);
  });

  test('failed during planning → rerun-plan + continue', () => {
    const state = freshState({
      currentStage: 'planning',
      error: { type: 'RevisionExhaustedError', stage: 'planning', message: 'exhausted', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    expect(getAvailableActions(state)).toEqual(['rerun-plan', 'continue']);
  });

  test('failed during coding → rerun-plan + fix + continue', () => {
    const state = freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'crash', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    expect(getAvailableActions(state)).toEqual(['rerun-plan', 'fix', 'continue']);
  });

  test('failed at unrelated stage → only continue', () => {
    const state = freshState({
      currentStage: 'analyzer',
      error: { type: 'ExternalServiceError', stage: 'analyzer', message: 'timeout', timestamp: '2024-01-01T00:30:00.000Z' },
    });
    expect(getAvailableActions(state)).toEqual(['continue']);
  });
});

// ---------------------------------------------------------------------------
// getAvailableActions - environment
// ---------------------------------------------------------------------------

describe('getAvailableActions - environment', () => {
  test('returns env actions when environment exists', () => {
    const state = {
      currentStage: 'coding',
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
      environment: { envId: 'env-1', url: 'https://env.test', description: 'WI-123', profileId: 'p1', createdAt: new Date().toISOString() },
    } as PipelineState;

    const actions = getAvailableActions(state);
    expect(actions).toContain('env-start');
    expect(actions).toContain('env-stop');
    expect(actions).toContain('env-delete');
    expect(actions).toContain('env-share');
  });

  test('does not return env actions when no environment', () => {
    const state = {
      currentStage: 'coding',
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: new Date().toISOString(),
    } as PipelineState;

    const actions = getAvailableActions(state);
    expect(actions).not.toContain('env-start');
  });
});

// ---------------------------------------------------------------------------
// reprovision-env
// ---------------------------------------------------------------------------

const DRAFT_PR = { id: 1, url: 'x', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 't', description: 'd', linkedWorkItemId: 1 };

describe('actions: validateAction - reprovision-env', () => {
  test('valid when draftPR exists', () => {
    const state = freshState({ draftPR: DRAFT_PR });
    expect(validateAction(makeAction({ type: 'reprovision-env' }), state)).toEqual({ valid: true });
  });

  test('invalid when no draftPR', () => {
    const state = freshState();
    const result = validateAction(makeAction({ type: 'reprovision-env' }), state);
    expect(result.valid).toBe(false);
  });

  test('invalid when completed', () => {
    const state = freshState({ draftPR: DRAFT_PR, completedAt: '2024-01-02T00:00:00Z' });
    const result = validateAction(makeAction({ type: 'reprovision-env' }), state);
    expect(result.valid).toBe(false);
  });
});

describe('getAvailableActions - reprovision-env', () => {
  test('includes reprovision-env when draftPR exists and not completed', () => {
    const state = freshState({ draftPR: DRAFT_PR, startedAt: new Date().toISOString() });
    expect(getAvailableActions(state)).toContain('reprovision-env');
  });

  test('excludes reprovision-env when no draftPR', () => {
    const state = freshState({ startedAt: new Date().toISOString() });
    expect(getAvailableActions(state)).not.toContain('reprovision-env');
  });

  test('excludes reprovision-env when pipeline is completed', () => {
    const state = freshState({ draftPR: DRAFT_PR, completedAt: '2024-01-02T00:00:00Z' });
    expect(getAvailableActions(state)).not.toContain('reprovision-env');
  });
});
