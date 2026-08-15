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

// ---------------------------------------------------------------------------
// UTC basis, not local time.
//
// `executeReflection` keys `cycleDate` off `now.toISOString().slice(0, 10)`
// (UTC), and `reflect.ts`'s own default cycle date is the same UTC-based
// string. `shouldDispatchReflection` MUST gate on the same calendar the key
// uses (`getUTCDate()`), or a host whose local clock and UTC clock land on
// different calendar days can either miss the dispatch entirely or, worse,
// have two ticks either side of UTC midnight both read "local 15th", each
// compute a DIFFERENT `cycleDate`, each see `findByCycle` return null for
// their own key, and each dispatch — defeating the advisory lock, which only
// ever serialises access to ONE key at a time.
//
// Below, `process.env['TZ']` mutated mid-process to prove the local/UTC
// divergence with concrete ISO instants was tried first and abandoned: V8's
// `Date.prototype.getDate()` locks in the process's local-timezone offset the
// first time ANY local-time computation happens anywhere in the process
// (including inside `bun test`'s own harness, before user test code ever
// runs) and does not re-read `process.env.TZ` afterwards — only
// `Intl.DateTimeFormat().resolvedOptions().timeZone` does. So a mid-test
// `process.env['TZ'] = ...` assignment silently has no effect on `getDate()`
// here, and would have made these tests pass or fail based on the actual
// developer machine's timezone rather than on what the guard does — useless
// as regression protection, and it would break in CI the moment the runner's
// own host timezone happened to equal UTC (local == UTC everywhere, so any
// local/UTC divergence the test tried to assert would vanish). A minimal
// Date-like stub sidesteps this entirely: it proves which method the guard
// calls directly, independent of the test host's real timezone or of any
// engine caching quirk.
// ---------------------------------------------------------------------------

describe('shouldDispatchReflection — UTC basis, not local time', () => {
  test('host-timezone-neutral: 2026-08-15T23:30:00+02:00 is UTC 15th (21:30Z) -> true', () => {
    // A real Date, no stubbing needed: toISOString()/getUTCDate() never depend on the
    // host's local timezone. Same instant the coordinator's finding named.
    const now = new Date('2026-08-15T23:30:00+02:00');
    expect(now.toISOString()).toBe('2026-08-15T21:30:00.000Z');
    expect(shouldDispatchReflection(now, null)).toBe(true);
  });

  test('regression: UTC day 15 dispatches even when local calendar reads a different day', () => {
    // A minimal Date-like stub whose getUTCDate() says 15 and whose getDate() (local)
    // says a day that would give the WRONG answer if the guard ever regressed to
    // reading local time — e.g. a host east of UTC where local has already rolled to
    // the 16th while UTC (and cycleDate) are still on the 15th. Throwing from getDate()
    // proves the guard never reads it at all, rather than merely happening to agree with it.
    const utc15local16 = {
      getUTCDate: () => 15,
      getDate: () => { throw new Error('shouldDispatchReflection must not read local time'); },
    } as unknown as Date;
    expect(shouldDispatchReflection(utc15local16, null)).toBe(true);
  });

  test('regression: local calendar reading 15 must NOT dispatch when UTC day is not 15', () => {
    // The inverse: a host west of UTC where local is still on the 15th (getDate() = 15)
    // but UTC (and cycleDate) has already rolled to the 16th. The pre-fix guard
    // (`now.getDate() === 15`) would have returned true here — dispatching a container
    // whose --cycle-date (computed from the SAME instant via toISOString()) reads
    // '...-16', a gate/key mismatch that is exactly how two ticks either side of UTC
    // midnight could both pass with two different cycleDate keys.
    const local15utc16 = {
      getUTCDate: () => 16,
      getDate: () => 15,
    } as unknown as Date;
    expect(shouldDispatchReflection(local15utc16, null)).toBe(false);
  });
});
