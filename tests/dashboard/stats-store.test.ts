import { describe, test, expect } from 'bun:test';
import { classifyWindowedResponse, classifyDriftResponse } from '../../src/dashboard/client/stats-store.ts';
import type { DriftStats } from '../../src/dashboard/stats.ts';

describe('classifyWindowedResponse', () => {
  test('sampleSize 0 -> empty (no data in this window, not an error)', () => {
    const result = classifyWindowedResponse({ sampleSize: 0, foo: 'bar' });
    expect(result).toEqual({ status: 'empty' });
  });

  test('sampleSize > 0 -> ready, carrying the full payload', () => {
    const data = { sampleSize: 5, foo: 'bar' };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
  });

  test('does not mutate or drop fields on the ready path', () => {
    const data = { sampleSize: 1, nested: { a: 1 }, list: [1, 2, 3] };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
    if (result.status === 'ready') {
      expect(result.data).toBe(data); // same reference — no cloning
    }
  });
});

// Fixture matching the real DriftStats shape (src/dashboard/stats.ts), so this
// test breaks if the response shape drifts rather than silently going stale.
function driftFixture(sampleSize: number): DriftStats {
  return {
    window: '7d',
    windowDays: 7,
    since: '2026-01-01T00:00:00.000Z',
    sampleSize,
    lowSample: sampleSize < 10,
    head: { value: '8129ee0', reason: null },
    composeService: { value: 'abc123', classification: 'sha', source: 'BUILD_SHA env var', commitsBehindHead: 2 },
    spawnedImage: {
      mostRecentSha: { value: null, classification: 'not-recorded', recordedAt: null, commitsBehindHead: null },
      distribution: [],
    },
    provenanceRecorded: false,
  };
}

describe('classifyDriftResponse', () => {
  // The whole point of Finding 1 (fix round 1): drift must NOT collapse to
  // 'empty' at sampleSize 0 the way every other windowed endpoint does —
  // head/composeService/mostRecentSha are unwindowed, and a zero-review
  // window's distribution is itself an informative reading, not a blank.
  test('sampleSize 0 -> still ready, never empty', () => {
    const data = driftFixture(0);
    expect(classifyDriftResponse(data)).toEqual({ status: 'ready', data });
  });

  test('sampleSize > 0 -> also ready (same rule regardless of sample size)', () => {
    const data = driftFixture(42);
    expect(classifyDriftResponse(data)).toEqual({ status: 'ready', data });
  });

  test('never returns an empty status for any sample size', () => {
    for (const n of [0, 1, 10, 1000]) {
      expect(classifyDriftResponse(driftFixture(n)).status).not.toBe('empty');
    }
  });
});
