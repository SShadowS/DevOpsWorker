import { describe, test, expect } from 'bun:test';
import type { PipelineState } from '../../../src/types/pipeline.types.ts';
import type { Changeset } from '../../../src/agents/coder/schema.ts';

import { applyCoderOutput } from '../../../src/agents/coder/config.ts';

const baseChangeset: Changeset = {
  branchName: 'bug/#73402-fix',
  branchUrl: 'https://...',
  filesCreated: [],
  filesModified: ['DocumentOutput/Cloud/X.al'],
  commitMessage: 'fix: ...',
  summary: 'Fixed.',
};

const baseState = (envOverrides: Partial<NonNullable<PipelineState['environment']>> = {}): PipelineState => ({
  telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
  startedAt: '2026-04-29T00:00:00Z',
  environment: {
    envId: 'e', url: 'u/', description: 'd', profileId: 'p', createdAt: '2026-04-29',
    coreActivated: true,
    ...envOverrides,
  },
} as unknown as PipelineState);

describe('coder applyOutput', () => {
  test('stores changeset and clears feedback/rerunMode (no wizard)', () => {
    const next = applyCoderOutput(baseState(), baseChangeset);
    expect(next.changeset).toEqual(baseChangeset);
    expect(next.humanFeedback).toBeUndefined();
    expect(next.rerunMode).toBeUndefined();
    expect(next.environment!.activated).toBeUndefined();
  });

  test('flips state.environment.activated to true when wizardActivated is true', () => {
    const next = applyCoderOutput(baseState({ activated: false }), { ...baseChangeset, wizardActivated: true });
    expect(next.environment!.activated).toBe(true);
  });

  test('does NOT flip activated when wizardActivated is false', () => {
    const next = applyCoderOutput(baseState({ activated: false }), { ...baseChangeset, wizardActivated: false });
    expect(next.environment!.activated).toBe(false);
  });

  test('preserves activated:true if wizardActivated is undefined and was already true', () => {
    const next = applyCoderOutput(baseState({ activated: true }), baseChangeset);
    expect(next.environment!.activated).toBe(true);
  });

  test('handles missing state.environment gracefully (no crash, no env field added)', () => {
    const stateNoEnv = { telemetry: {}, startedAt: '' } as unknown as PipelineState;
    const next = applyCoderOutput(stateNoEnv, { ...baseChangeset, wizardActivated: true });
    expect(next.environment).toBeUndefined();
  });
});
