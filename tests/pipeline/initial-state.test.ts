import { describe, test, expect } from 'bun:test';
import { createInitialState } from '../../src/pipeline/initial-state.ts';

describe('createInitialState', () => {
  test('creates state with given starting stage', () => {
    const state = createInitialState('analyzer');
    expect(state.currentStage).toBe('analyzer');
    expect(state.telemetry.totalCostUsd).toBe(0);
    expect(state.telemetry.totalDurationMs).toBe(0);
    expect(state.telemetry.stages).toEqual([]);
    expect(state.startedAt).toBeTruthy();
  });
});
