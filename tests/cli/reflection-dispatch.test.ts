import { describe, test, expect } from 'bun:test';
import { shouldDispatchReflection } from '../../src/cli/watch/container-dispatcher.ts';
import type { ReflectionProposal } from '../../src/db/reflection-proposal-mapper.ts';

// ---------------------------------------------------------------------------
// shouldDispatchReflection — pure day-15 + no-existing-proposal guard.
//
// `existing` is expected to come from IReflectionStore.findByCycle, which
// already excludes 'superseded' rows before this function ever sees them —
// so a cycle that has ONLY a superseded proposal is exercised here the same
// way as a cycle with no proposal at all: by passing null.
// ---------------------------------------------------------------------------

function proposal(status: ReflectionProposal['status']): ReflectionProposal {
  return {
    id: 1,
    cycleDate: '2026-08-15',
    windowDays: 35,
    coverage: null,
    adjudications: [],
    clusters: [],
    proposedChanges: [],
    watchLedger: null,
    classifierNotes: null,
    expectedEffects: null,
    logEntryDraft: null,
    status,
    decidedBy: null,
    decidedAt: null,
    appliedAt: null,
    appliedCommits: null,
    costUsd: null,
    sessionId: null,
    error: null,
    createdAt: '2026-08-15T00:00:00Z',
  };
}

describe('shouldDispatchReflection', () => {
  test('day 15, no existing proposal -> true', () => {
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), null)).toBe(true);
  });

  test('day 15, a pending row already exists for this cycle -> false', () => {
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), proposal('pending'))).toBe(false);
  });

  test('day 15, an approved row already exists for this cycle -> false', () => {
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), proposal('approved'))).toBe(false);
  });

  test('day 15, an applied row already exists for this cycle -> false', () => {
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), proposal('applied'))).toBe(false);
  });

  test('day 15, a rejected row already exists for this cycle -> false', () => {
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), proposal('rejected'))).toBe(false);
  });

  test('not day 15, no existing proposal -> false', () => {
    expect(shouldDispatchReflection(new Date('2026-08-14T09:00:00Z'), null)).toBe(false);
    expect(shouldDispatchReflection(new Date('2026-08-16T09:00:00Z'), null)).toBe(false);
    expect(shouldDispatchReflection(new Date('2026-09-01T09:00:00Z'), null)).toBe(false);
  });

  test('day 15 but the only row for this cycle was superseded -> findByCycle already excludes it, so this sees null -> true', () => {
    // findByCycle's contract is "newest NON-superseded row, or null" — a cycle whose
    // only row is superseded is indistinguishable, at this function's boundary, from a
    // cycle with no row at all. This test documents that boundary by passing null.
    expect(shouldDispatchReflection(new Date('2026-08-15T09:00:00Z'), null)).toBe(true);
  });
});
