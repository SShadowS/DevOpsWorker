import { describe, test, expect } from 'bun:test';
import { sessionChangeKey } from '../../src/dashboard/session-key.ts';
import type { DashboardSession } from '../../src/dashboard/types.ts';

function baseSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    workItemId: 1,
    status: 'running',
    currentStage: 'planning',
    startedAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-01T00:00:00.000Z',
    stages: [],
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    ...overrides,
  };
}

describe('sessionChangeKey', () => {
  test('changes when activeAgent role changes', () => {
    const a = sessionChangeKey(baseSession({ activeAgent: { name: 'planner', loop: 'planning', role: 'producer', iteration: 1, startedAt: 't' } }));
    const b = sessionChangeKey(baseSession({ activeAgent: { name: 'plan-reviewer', loop: 'planning', role: 'reviewer', iteration: 1, startedAt: 't' } }));
    expect(a).not.toBe(b);
  });

  test('changes when activeAgent goes from set to undefined', () => {
    const withMarker = sessionChangeKey(baseSession({ activeAgent: { name: 'planner', loop: 'planning', role: 'producer', iteration: 1, startedAt: 't' } }));
    const without = sessionChangeKey(baseSession());
    expect(withMarker).not.toBe(without);
  });

  test('stable for identical sessions', () => {
    expect(sessionChangeKey(baseSession())).toBe(sessionChangeKey(baseSession()));
  });
});
