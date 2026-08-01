import { describe, test, expect } from 'bun:test';
import {
  buildModelUsageSectionView,
  buildDispatchSectionView,
  buildEffortDriftSectionView,
  formatEffortMix,
  assessFindingsIntegrity,
  buildErrorRateSectionView,
  buildIntegrityPanelView,
} from '../../src/dashboard/client/components/stats-integrity.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { IntegrityStats, EffortMix } from '../../src/dashboard/stats.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/tool-breakdown.test.ts). Every
// function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// Fixture — matches the real IntegrityStats shape (src/dashboard/stats.ts) so
// these tests break if the response shape drifts, mirroring
// stats-ribbon.test.ts's integrityFixture().
// ---------------------------------------------------------------------------

const zeroMix: EffortMix = { high: 0, low: 0, other: 0, unknown: 0 };

function integrityFixture(overrides: Partial<IntegrityStats> = {}): IntegrityStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 337,
    lowSample: false,
    modelUsage: { breakdown: [], flaggedKeys: [] },
    dispatch: {
      sampleSize: 337, dispatchSampleSize: 337, medianDispatch: 10, p90Dispatch: 18,
      avgRosterCount: 4.2, mismatchCount: 233, mismatchRate: 0.691, note: '',
    },
    inferredEffort: {
      inferred: true,
      bands: { high: [43_000, 56_000], low: [21_000, 27_000] },
      drift: { overall: zeroMix, earlierHalf: zeroMix, laterHalf: zeroMix },
      note: 'No effort column exists. Bands are inferred from orchestrator output tokens.',
    },
    findingsIntegrity: { comparedRows: 0, mismatchCount: 0, mismatchRate: null },
    errorRate: { count: 3, total: 333, rate: 0.009009009009009009 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildModelUsageSectionView — delegates to stats-ribbon's assessModelIntegrity
// so the ribbon's compact card and this panel's table never disagree.
// ---------------------------------------------------------------------------

describe('buildModelUsageSectionView', () => {
  test('no flagged keys -> ok, breakdown rows passed through untouched', () => {
    const breakdown = [{ model: 'claude-sonnet-5', rows: 10, totalCostUsd: 5, totalOutputTokens: 100, flagged: false }];
    const view = buildModelUsageSectionView(integrityFixture({ modelUsage: { breakdown, flaggedKeys: [] } }));
    expect(view.status).toBe('ok');
    expect(view.summary).toContain('n=337');
    expect(view.rows).toEqual(breakdown);
  });

  test('a flagged [1m] key -> attention, named in the summary', () => {
    const flaggedEntry = { model: 'claude-opus-4-8[1m]', rows: 1, totalCostUsd: 2.09, totalOutputTokens: 500, flagged: true };
    const view = buildModelUsageSectionView(integrityFixture({ modelUsage: { breakdown: [flaggedEntry], flaggedKeys: [flaggedEntry] } }));
    expect(view.status).toBe('attention');
    expect(view.summary).toContain('claude-opus-4-8[1m]');
    expect(view.rows).toEqual([flaggedEntry]);
  });
});

// ---------------------------------------------------------------------------
// buildDispatchSectionView — the 69% caveat. ALWAYS 'neutral', regardless of
// how high the mismatch rate is — this is the whole point of the section.
// ---------------------------------------------------------------------------

describe('buildDispatchSectionView', () => {
  test('a high (measured-live-typical) mismatch rate is still neutral, never attention', () => {
    const view = buildDispatchSectionView({
      sampleSize: 337, dispatchSampleSize: 337, medianDispatch: 10, p90Dispatch: 18,
      avgRosterCount: 4.2, mismatchCount: 233, mismatchRate: 0.691, note: '',
    });
    expect(view.status).toBe('neutral');
    expect(view.mismatchText).toBe('233/337 (69.1%)');
  });

  test('a 100% mismatch rate is STILL neutral — this section never escalates', () => {
    const view = buildDispatchSectionView({
      sampleSize: 10, dispatchSampleSize: 10, medianDispatch: 5, p90Dispatch: 9,
      avgRosterCount: 0, mismatchCount: 10, mismatchRate: 1, note: '',
    });
    expect(view.status).toBe('neutral');
  });

  test('null median/p90/avgRosterCount render as "n/a", never as a fake 0', () => {
    const view = buildDispatchSectionView({
      sampleSize: 0, dispatchSampleSize: 0, medianDispatch: null, p90Dispatch: null,
      avgRosterCount: null, mismatchCount: 0, mismatchRate: null, note: '',
    });
    expect(view.medianText).toBe('n/a');
    expect(view.p90Text).toBe('n/a');
    expect(view.avgRosterText).toBe('n/a');
    expect(view.mismatchText).toBe('0/0 (n/a)');
  });

  test('caveat text names the instrument fault, not a vague "known issue"', () => {
    const view = buildDispatchSectionView({
      sampleSize: 1, dispatchSampleSize: 1, medianDispatch: 1, p90Dispatch: 1,
      avgRosterCount: 1, mismatchCount: 0, mismatchRate: 0, note: '',
    });
    expect(view.caveat).toContain('sub_agents');
    expect(view.caveat.toLowerCase()).toContain('ordinary case');
  });
});

// ---------------------------------------------------------------------------
// buildEffortDriftSectionView / formatEffortMix — inferred, never measured.
// ---------------------------------------------------------------------------

describe('buildEffortDriftSectionView', () => {
  test('always neutral — there is no ground truth to score a proxy against', () => {
    const view = buildEffortDriftSectionView(integrityFixture().inferredEffort);
    expect(view.status).toBe('neutral');
  });

  test('bands text states both ranges with units, not bare numbers', () => {
    const view = buildEffortDriftSectionView(integrityFixture().inferredEffort);
    expect(view.bandsText).toContain('43,000');
    expect(view.bandsText).toContain('56,000');
    expect(view.bandsText).toContain('21,000');
    expect(view.bandsText).toContain('27,000');
    expect(view.bandsText).toContain('tokens');
  });

  test('note is passed through from the endpoint, not rewritten silently', () => {
    const note = 'a very specific caveat sentence';
    const view = buildEffortDriftSectionView({ ...integrityFixture().inferredEffort, note });
    expect(view.note).toBe(note);
  });

  test('overall/earlierHalf/laterHalf mixes pass through untouched', () => {
    const drift = { overall: { high: 5, low: 3, other: 1, unknown: 0 }, earlierHalf: zeroMix, laterHalf: zeroMix };
    const view = buildEffortDriftSectionView({ ...integrityFixture().inferredEffort, drift });
    expect(view.overall).toEqual(drift.overall);
  });
});

describe('formatEffortMix', () => {
  test('names all four bands, including zero ones (a real absence, not omitted)', () => {
    expect(formatEffortMix({ high: 3, low: 0, other: 1, unknown: 0 })).toBe('high 3 · low 0 · other 1 · unknown 0');
  });
});

// ---------------------------------------------------------------------------
// assessFindingsIntegrity — unlike dispatch, ANY mismatch here is attention.
// ---------------------------------------------------------------------------

describe('assessFindingsIntegrity', () => {
  test('zero compared rows -> ok, states there is nothing to compare', () => {
    const view = assessFindingsIntegrity({ comparedRows: 0, mismatchCount: 0, mismatchRate: null });
    expect(view.status).toBe('ok');
    expect(view.text).toContain('No rows');
  });

  test('zero mismatches among compared rows -> ok', () => {
    const view = assessFindingsIntegrity({ comparedRows: 100, mismatchCount: 0, mismatchRate: 0 });
    expect(view.status).toBe('ok');
    expect(view.text).toContain('0/100');
  });

  test('even a single mismatch -> attention (not a known caveat like dispatch)', () => {
    const view = assessFindingsIntegrity({ comparedRows: 100, mismatchCount: 1, mismatchRate: 0.01 });
    expect(view.status).toBe('attention');
    expect(view.text).toContain('1/100');
    expect(view.text).toContain('1.0%');
  });
});

// ---------------------------------------------------------------------------
// buildErrorRateSectionView — delegates to assessErrorRate, adds the
// error_max_turns scope note.
// ---------------------------------------------------------------------------

describe('buildErrorRateSectionView', () => {
  test('delegates severity/text to assessErrorRate', () => {
    const view = buildErrorRateSectionView({ count: 3, total: 333, rate: 0.009009009009009009 }, false);
    expect(view.status).toBe('ok');
    expect(view.text).toContain('3/333');
  });

  test('a rate above the ribbon threshold -> attention, same as the ribbon card', () => {
    const view = buildErrorRateSectionView({ count: 20, total: 100, rate: 0.2 }, false);
    expect(view.status).toBe('attention');
  });

  test('note names error_max_turns explicitly, not just "errors"', () => {
    const view = buildErrorRateSectionView({ count: 0, total: 10, rate: 0 }, false);
    expect(view.note).toContain('error_max_turns');
  });
});

// ---------------------------------------------------------------------------
// buildIntegrityPanelView — the one exhaustive switch the component renders
// from. Mirrors describeFetchState's four-branch exhaustiveness in
// stats-view.tsx.
// ---------------------------------------------------------------------------

describe('buildIntegrityPanelView', () => {
  test('loading -> loading status, every section null', () => {
    const state: FetchState<IntegrityStats> = { status: 'loading' };
    const view = buildIntegrityPanelView(state);
    expect(view.status).toBe('loading');
    expect(view.message).toBe('Loading…');
    expect(view.modelUsage).toBeNull();
    expect(view.dispatch).toBeNull();
    expect(view.effortDrift).toBeNull();
    expect(view.findingsIntegrity).toBeNull();
    expect(view.errorRate).toBeNull();
  });

  test('error -> states what failed, in words', () => {
    const state: FetchState<IntegrityStats> = { status: 'error', message: '500 Internal Server Error' };
    const view = buildIntegrityPanelView(state);
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
  });

  test('empty -> reads distinctly from error (no data vs request failed)', () => {
    const state: FetchState<IntegrityStats> = { status: 'empty' };
    const view = buildIntegrityPanelView(state);
    expect(view.status).toBe('empty');
    expect(view.message).not.toContain('Failed');
  });

  test('ready -> all five sections populated from the one payload', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture() };
    const view = buildIntegrityPanelView(state);
    expect(view.status).toBe('ready');
    expect(view.message).toBeNull();
    expect(view.modelUsage).not.toBeNull();
    expect(view.dispatch).not.toBeNull();
    expect(view.effortDrift).not.toBeNull();
    expect(view.findingsIntegrity).not.toBeNull();
    expect(view.errorRate).not.toBeNull();
    expect(view.sampleSize).toBe(337);
    expect(view.lowSample).toBe(false);
  });

  test('ready + lowSample -> lowSample surfaced on the panel view', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture({ sampleSize: 4, lowSample: true }) };
    const view = buildIntegrityPanelView(state);
    expect(view.lowSample).toBe(true);
    expect(view.sampleSize).toBe(4);
  });
});
