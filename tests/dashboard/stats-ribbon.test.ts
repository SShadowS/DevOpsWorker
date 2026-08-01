import { describe, test, expect } from 'bun:test';
import {
  describeNonShaState,
  describeHeadUnresolved,
  formatDistance,
  buildHeadRow,
  buildProvenanceRow,
  buildProvenanceRows,
  assessDrift,
  assessModelIntegrity,
  assessLevers,
  assessErrorRate,
  ERROR_RATE_ATTENTION_THRESHOLD,
  buildDriftCard,
  buildModelIntegrityCard,
  buildLeversCard,
  buildErrorRateCard,
} from '../../src/dashboard/client/components/stats-ribbon.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { DriftStats, IntegrityStats } from '../../src/dashboard/stats.ts';
import type { ConfigReport, LeverStatus } from '../../src/dashboard/config-report.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/tool-breakdown.test.ts). Every
// function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// Fixtures — match the real shapes so these tests break if the response
// shape drifts, mirroring stats-store.test.ts's driftFixture().
// ---------------------------------------------------------------------------

function driftFixture(overrides: Partial<DriftStats> = {}): DriftStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 100,
    lowSample: false,
    head: { value: '8129ee0', reason: null },
    composeService: { value: '91ed870', classification: 'sha', source: "this dashboard process's BUILD_SHA env var", commitsBehindHead: 2 },
    spawnedImage: {
      mostRecentSha: { value: '91ed870', classification: 'sha', recordedAt: '2026-08-01T00:00:00.000Z', commitsBehindHead: 2 },
      distribution: [],
    },
    provenanceRecorded: true,
    ...overrides,
  };
}

function integrityFixture(overrides: Partial<IntegrityStats> = {}): IntegrityStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 100,
    lowSample: false,
    modelUsage: { breakdown: [], flaggedKeys: [] },
    dispatch: {
      sampleSize: 100, dispatchSampleSize: 100, medianDispatch: 5, p90Dispatch: 8,
      avgRosterCount: 4, mismatchCount: 0, mismatchRate: 0, note: '',
    },
    inferredEffort: { inferred: true, bands: { high: [43_000, 56_000], low: [21_000, 27_000] }, drift: { overall: { high: 0, low: 0, other: 0, unknown: 0 }, earlierHalf: { high: 0, low: 0, other: 0, unknown: 0 }, laterHalf: { high: 0, low: 0, other: 0, unknown: 0 } }, note: '' },
    findingsIntegrity: { comparedRows: 0, mismatchCount: 0, mismatchRate: null },
    errorRate: { count: 0, total: 100, rate: 0 },
    subAgentModelAttribution: { entries: [], note: '' },
    ...overrides,
  };
}

function leverFixture(state: LeverStatus['state'], key = 'PR_REVIEW_NO_POST'): LeverStatus {
  return { key, raw: state === 'absent' ? undefined : '1', state, sourceRef: 'x.ts:1', description: 'desc' };
}

function configFixture(evalLevers: LeverStatus[]): ConfigReport {
  return {
    generatedAt: '2026-08-01T00:00:00.000Z',
    orchestratorModel: {
      loadConfig: { raw: undefined, model: 'claude-opus-5', effort: { raw: undefined, parsed: undefined, effective: '(SDK default: high)' }, usedBy: [] },
      buildConfigFromRepo: { raw: undefined, model: 'claude-opus-5', effort: { raw: undefined, parsed: undefined, effective: '(SDK default: high)' }, usedBy: [] },
      agree: true,
      note: '',
    },
    perAgent: [],
    ruleLearnerAgent: { name: 'rule-learner', model: 'x', maxTurns: 1, disallowedTools: [], note: '' },
    subAgents: { groups: [], inline: [], totalFrontmatterFiles: 0 },
    credential: { prReview: { envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: false, length: null, mode: 'oauth-subscription' } },
    evalLevers,
    overlay: { agentOverrideCount: 0, agents: {} },
  };
}

// ---------------------------------------------------------------------------
// describeNonShaState / describeHeadUnresolved — words, never a blank or a
// fake sha (design-constraints.md #3).
// ---------------------------------------------------------------------------

describe('describeNonShaState', () => {
  test('unknown reads as words naming the cause', () => {
    expect(describeNonShaState('unknown')).toContain('docker compose build');
  });
  test('empty reads as words naming the cause', () => {
    expect(describeNonShaState('empty')).toContain('docker build');
  });
  test('not-recorded reads as "no provenance yet"', () => {
    expect(describeNonShaState('not-recorded')).toBe('no build provenance recorded yet');
  });
  test('the three non-sha states are textually distinct from each other', () => {
    const texts = new Set([describeNonShaState('unknown'), describeNonShaState('empty'), describeNonShaState('not-recorded')]);
    expect(texts.size).toBe(3);
  });
});

describe('describeHeadUnresolved', () => {
  test('every reason produces distinct, non-empty text', () => {
    const reasons = ['not-mounted', 'not-a-directory', 'command-failed', 'timeout', 'empty-output'] as const;
    const texts = reasons.map(describeHeadUnresolved);
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatDistance — the "never fall back to 0" contract.
// ---------------------------------------------------------------------------

describe('formatDistance', () => {
  test('null -> distance unknown, never a number', () => expect(formatDistance(null)).toBe('distance unknown'));
  test('0 -> in sync, a real distinct fact from unknown', () => expect(formatDistance(0)).toBe('in sync'));
  test('1 -> singular phrasing', () => expect(formatDistance(1)).toBe('1 commit behind'));
  test('2 -> plural phrasing', () => expect(formatDistance(2)).toBe('2 commits behind'));
});

// ---------------------------------------------------------------------------
// Row builders — the three-sha table's data.
// ---------------------------------------------------------------------------

describe('buildHeadRow', () => {
  test('a resolved HEAD renders the sha, mono, no distance text (it is the reference point)', () => {
    const row = buildHeadRow({ value: '8129ee0', reason: null });
    expect(row).toEqual({ label: 'HEAD', display: '8129ee0', isSha: true, distanceText: '', barPosition: 1 });
  });

  test('an unresolved HEAD renders words, not a blank or a fake sha', () => {
    const row = buildHeadRow({ value: null, reason: 'not-mounted' });
    expect(row.isSha).toBe(false);
    expect(row.display).not.toBe('');
    expect(row.barPosition).toBeNull();
  });
});

describe('buildProvenanceRow', () => {
  test('a real sha with a known distance renders the sha + distance text', () => {
    const row = buildProvenanceRow('compose services', 'sha', '91ed870', 2);
    expect(row.isSha).toBe(true);
    expect(row.display).toBe('91ed870');
    expect(row.distanceText).toBe('2 commits behind');
    expect(row.barPosition).not.toBeNull();
  });

  test('a real sha with an unknown distance says so, never renders 0', () => {
    const row = buildProvenanceRow('compose services', 'sha', '91ed870', null);
    expect(row.distanceText).toBe('distance unknown');
    expect(row.barPosition).toBeNull();
  });

  test('a non-sha classification renders words and no distance text at all', () => {
    const row = buildProvenanceRow('compose services', 'not-recorded', null, null);
    expect(row.isSha).toBe(false);
    expect(row.display).toBe('no build provenance recorded yet');
    expect(row.distanceText).toBe('');
  });

  test("classified 'sha' but a falsy value (defensive, should not happen) falls through to the non-sha branch", () => {
    const row = buildProvenanceRow('compose services', 'sha', null, null);
    expect(row.isSha).toBe(false);
  });
});

describe('buildProvenanceRows', () => {
  test('returns exactly 3 rows in HEAD, spawned image, compose services order', () => {
    const rows = buildProvenanceRows(driftFixture());
    expect(rows.map((r) => r.label)).toEqual(['HEAD', 'spawned image', 'compose services']);
  });
});

// ---------------------------------------------------------------------------
// assessDrift — the actual severity logic the 2026-08-01 incident motivated.
// ---------------------------------------------------------------------------

describe('assessDrift', () => {
  test('HEAD unresolved -> attention, regardless of everything else', () => {
    const result = assessDrift(driftFixture({ head: { value: null, reason: 'not-mounted' } }));
    expect(result.severity).toBe('attention');
    expect(result.warning).toContain('HEAD is not observable');
  });

  test('compose service has no build provenance -> attention', () => {
    const result = assessDrift(driftFixture({
      composeService: { value: null, classification: 'not-recorded', source: 'x', commitsBehindHead: null },
    }));
    expect(result.severity).toBe('attention');
    expect(result.warning).toContain('no build provenance');
  });

  test('compose service is a real sha but distance is unknown -> attention, never silently ok', () => {
    const result = assessDrift(driftFixture({
      composeService: { value: 'deadbeef', classification: 'sha', source: 'x', commitsBehindHead: null },
    }));
    expect(result.severity).toBe('attention');
    expect(result.warning).toContain('distance unknown');
  });

  test('compose service is behind HEAD -> attention, names the count and "config may be inert"', () => {
    const result = assessDrift(driftFixture({
      composeService: { value: '11b5a83', classification: 'sha', source: 'x', commitsBehindHead: 9 },
    }));
    expect(result.severity).toBe('attention');
    expect(result.warning).toContain('9 commits behind');
    expect(result.warning).toContain('config may be inert');
  });

  test('compose service confirmed in sync (0 behind, HEAD known) -> ok, no warning', () => {
    const result = assessDrift(driftFixture({
      composeService: { value: '8129ee0', classification: 'sha', source: 'x', commitsBehindHead: 0 },
    }));
    expect(result).toEqual({ severity: 'ok', warning: null });
  });

  test('spawned image lagging does NOT by itself flip severity — only compose services do (per the sketch)', () => {
    const result = assessDrift(driftFixture({
      composeService: { value: '8129ee0', classification: 'sha', source: 'x', commitsBehindHead: 0 },
      spawnedImage: {
        mostRecentSha: { value: 'stale', classification: 'sha', recordedAt: null, commitsBehindHead: 50 },
        distribution: [],
      },
    }));
    expect(result.severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// assessModelIntegrity / assessLevers / assessErrorRate
// ---------------------------------------------------------------------------

describe('assessModelIntegrity', () => {
  test('no flagged keys -> ok, states n', () => {
    const result = assessModelIntegrity(integrityFixture());
    expect(result.severity).toBe('ok');
    expect(result.text).toContain('n=100');
  });

  test('a flagged key -> attention, names the model', () => {
    const result = assessModelIntegrity(integrityFixture({
      modelUsage: { breakdown: [], flaggedKeys: [{ model: 'claude-opus-5[1m]', rows: 1, totalCostUsd: 1, totalOutputTokens: 1, flagged: true }] },
    }));
    expect(result.severity).toBe('attention');
    expect(result.text).toContain('claude-opus-5[1m]');
  });
});

describe('assessLevers', () => {
  test('no active levers -> ok, 0/N', () => {
    const result = assessLevers([leverFixture('absent'), leverFixture('present-but-inert', 'PR_REVIEW_AGENT_SET')]);
    expect(result.severity).toBe('ok');
    expect(result.text).toBe('0/2 eval levers active');
  });

  test('an active lever -> attention, names the key(s)', () => {
    const result = assessLevers([leverFixture('active', 'PR_REVIEW_NO_POST'), leverFixture('absent', 'PR_REVIEW_AGENT_SET')]);
    expect(result.severity).toBe('attention');
    expect(result.text).toContain('PR_REVIEW_NO_POST');
    expect(result.text).toContain('1/2');
  });
});

describe('assessErrorRate', () => {
  test('zero reviews in window -> ok, says so in words', () => {
    const result = assessErrorRate({ count: 0, total: 0, rate: null }, false);
    expect(result.severity).toBe('ok');
    expect(result.text).toContain('no reviews recorded');
  });

  test('a rate at or below the threshold -> ok', () => {
    const result = assessErrorRate({ count: 5, total: 100, rate: ERROR_RATE_ATTENTION_THRESHOLD }, false);
    expect(result.severity).toBe('ok');
  });

  test('a rate above the threshold -> attention', () => {
    const result = assessErrorRate({ count: 20, total: 100, rate: 0.2 }, false);
    expect(result.severity).toBe('attention');
    expect(result.text).toContain('20/100');
    expect(result.text).toContain('20.0%');
  });

  test('a low sample is labelled as such in words, not just a raw percentage', () => {
    const result = assessErrorRate({ count: 1, total: 3, rate: 0.333 }, true);
    expect(result.text).toContain('small sample');
    expect(result.text).toContain('n=3');
  });
});

// ---------------------------------------------------------------------------
// Card view builders — the loading/error/empty/ready branching per source.
// ---------------------------------------------------------------------------

describe('buildDriftCard', () => {
  test('loading -> loading status, no rows', () => {
    const state: FetchState<DriftStats> = { status: 'loading' };
    expect(buildDriftCard(state)).toEqual({ status: 'loading', message: 'Loading…', rows: null, warning: null });
  });

  test('error -> error status, states what failed', () => {
    const state: FetchState<DriftStats> = { status: 'error', message: '500 Internal Server Error' };
    const view = buildDriftCard(state);
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
  });

  test('ready + ok drift -> status ok, rows present, no warning', () => {
    const state: FetchState<DriftStats> = { status: 'ready', data: driftFixture({ composeService: { value: '8129ee0', classification: 'sha', source: 'x', commitsBehindHead: 0 } }) };
    const view = buildDriftCard(state);
    expect(view.status).toBe('ok');
    expect(view.rows).not.toBeNull();
    expect(view.rows!.length).toBe(3);
    expect(view.warning).toBeNull();
  });

  test('ready + drifting compose -> status attention, warning present', () => {
    const state: FetchState<DriftStats> = { status: 'ready', data: driftFixture() }; // fixture has commitsBehindHead: 2
    const view = buildDriftCard(state);
    expect(view.status).toBe('attention');
    expect(view.warning).not.toBeNull();
  });
});

describe('buildModelIntegrityCard / buildErrorRateCard', () => {
  test('model integrity ready -> delegates to assessModelIntegrity', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture() };
    expect(buildModelIntegrityCard(state)).toEqual({ status: 'ok', text: 'n=100 · no flagged model keys' });
  });

  test('error rate ready -> delegates to assessErrorRate', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture({ errorRate: { count: 0, total: 100, rate: 0 } }) };
    const view = buildErrorRateCard(state);
    expect(view.status).toBe('ok');
    expect(view.text).toContain('0/100');
  });

  test('empty -> reads distinctly from error (no data vs request failed)', () => {
    const state: FetchState<IntegrityStats> = { status: 'empty' };
    const view = buildModelIntegrityCard(state);
    expect(view.status).toBe('empty');
    expect(view.text).not.toContain('Failed');
  });
});

describe('buildLeversCard', () => {
  test('ready with an active lever -> attention, names it', () => {
    const state: FetchState<ConfigReport> = { status: 'ready', data: configFixture([leverFixture('active', 'PR_REVIEW_NO_POST')]) };
    const view = buildLeversCard(state);
    expect(view.status).toBe('attention');
    expect(view.text).toContain('PR_REVIEW_NO_POST');
  });

  test('loading -> loading, never crashes on a missing evalLevers array', () => {
    const state: FetchState<ConfigReport> = { status: 'loading' };
    expect(buildLeversCard(state)).toEqual({ status: 'loading', text: 'Loading…' });
  });
});
