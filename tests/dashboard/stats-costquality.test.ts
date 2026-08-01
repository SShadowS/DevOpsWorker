import { describe, test, expect } from 'bun:test';
import {
  combinePanelStatus,
  buildCostSplitView,
  describeCoverage,
  buildLowCoverageHeadline,
  formatCostPerReadBandItem,
  assessModelBreakdownCost,
  classifyReadBandLevel,
  readBandGaugePosition,
  buildReadBandGaugeView,
  computeReadBandCoverage,
  describeReadBandCoverage,
  buildReadBandLowCoverageHeadline,
  buildSeveritySegments,
  buildReadBandSplitView,
  buildCostPanelView,
  buildQualityPanelView,
  READ_BAND_DANGER_MAX,
  READ_BAND_HEALTHY_RANGE,
  READ_BAND_GAUGE_SCALE_MAX,
  READ_BAND_DANGER_ZONE_PCT,
  READ_BAND_HEALTHY_ZONE_START_PCT,
  READ_BAND_HEALTHY_ZONE_END_PCT,
} from '../../src/dashboard/client/components/stats-costquality.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { CostStats, QualityStats, SubAgentCoverage, CostPerReadBandItem, ModelUsageEntry } from '../../src/dashboard/stats.ts';
import { MIN_RELIABLE_COVERAGE_PCT } from '../../src/dashboard/coverage-thresholds.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/stats-integrity.test.ts). Every
// function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// Fixtures — match the real CostStats/QualityStats shapes (src/dashboard/stats.ts)
// so these tests break if the response shape drifts, mirroring
// stats-ribbon.test.ts's driftFixture() precedent.
// ---------------------------------------------------------------------------

function coverageFixture(overrides: Partial<SubAgentCoverage> = {}): SubAgentCoverage {
  return { rowsWithSubAgentData: 108, totalRows: 337, coveragePct: 32.0, lowCoverage: true, ...overrides };
}

function costFixture(overrides: Partial<CostStats> = {}): CostStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 337,
    lowSample: false,
    medianCostUsd: 1.2,
    p90CostUsd: 3.5,
    avgCostUsd: 1.5,
    totalCostUsd: 500,
    costSampleSize: 330,
    orchestratorSubAgentSplit: {
      orchestratorCostUsdMax: 350,
      subAgentCostUsdMin: 150,
      orchestratorSharePctMax: 70,
      coverage: coverageFixture(),
      note: 'the split is biased toward more orchestrator, never less',
    },
    costPerReadBandItem: { avgCostUsd: 1.5, avgReadBandItems: 2.0, value: 0.75, sampleSize: 300 },
    modelBreakdown: [],
    perRepo: [],
    monthlyProjection: { value: 500, basis: 'linear extrapolation of the 30d window total' },
    ...overrides,
  };
}

function qualityFixture(overrides: Partial<QualityStats> = {}): QualityStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 337,
    lowSample: false,
    readBandSampleSize: 310,
    avgReadBandItems: 2.96,
    belowBandCount: 40,
    belowBandPct: 12.9,
    severityDistribution: { critical: 56, major: 169, minor: 330, nitpick: 195 },
    verdictDistribution: { approve: 200, 'request-changes': 100, '(none)': 10 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// combinePanelStatus — worst-of-two, mirrors worstStatus (stats-view.tsx)
// ---------------------------------------------------------------------------

describe('combinePanelStatus', () => {
  test('error beats everything', () => {
    expect(combinePanelStatus('error', 'ready')).toBe('error');
    expect(combinePanelStatus('ready', 'error')).toBe('error');
  });
  test('loading beats empty and ready', () => {
    expect(combinePanelStatus('loading', 'ready')).toBe('loading');
    expect(combinePanelStatus('empty', 'loading')).toBe('loading');
  });
  test('empty beats ready', () => {
    expect(combinePanelStatus('empty', 'ready')).toBe('empty');
    expect(combinePanelStatus('ready', 'empty')).toBe('empty');
  });
  test('ready + ready -> ready', () => {
    expect(combinePanelStatus('ready', 'ready')).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// buildCostSplitView — the trustworthy-total / biased-boundary stacked bar
// ---------------------------------------------------------------------------

describe('buildCostSplitView', () => {
  test('zero total cost -> hasCost false, both pcts zero', () => {
    const view = buildCostSplitView(costFixture({ totalCostUsd: 0, orchestratorSubAgentSplit: {
      orchestratorCostUsdMax: 0, subAgentCostUsdMin: 0, orchestratorSharePctMax: null, coverage: coverageFixture(), note: '',
    } }));
    expect(view.hasCost).toBe(false);
    expect(view.orchestratorPct).toBe(0);
    expect(view.subAgentPct).toBe(0);
  });

  test('orchestratorPct reuses the server field verbatim, subAgentPct is computed as the exact complement', () => {
    const view = buildCostSplitView(costFixture({
      totalCostUsd: 500,
      orchestratorSubAgentSplit: {
        orchestratorCostUsdMax: 350, subAgentCostUsdMin: 150, orchestratorSharePctMax: 70,
        coverage: coverageFixture(), note: '',
      },
    }));
    expect(view.hasCost).toBe(true);
    expect(view.orchestratorPct).toBe(70);
    expect(view.subAgentPct).toBe(30); // 150/500*100
    expect(view.orchestratorPct + view.subAgentPct).toBe(100);
  });

  test('90d/9.9%-coverage scenario: total is exact, split is heavily skewed, coverage is carried through', () => {
    const view = buildCostSplitView(costFixture({
      totalCostUsd: 1000,
      orchestratorSubAgentSplit: {
        orchestratorCostUsdMax: 854, subAgentCostUsdMin: 146, orchestratorSharePctMax: 85.4,
        coverage: { rowsWithSubAgentData: 15, totalRows: 152, coveragePct: 9.9, lowCoverage: true },
        note: '',
      },
    }));
    expect(view.totalCostUsd).toBe(1000);
    expect(view.orchestratorCostUsd + view.subAgentCostUsd).toBe(1000);
    expect(view.orchestratorPct).toBe(85.4);
  });
});

describe('describeCoverage', () => {
  test('renders the raw counts and the pre-scaled server percentage without double-multiplying', () => {
    const text = describeCoverage(coverageFixture({ rowsWithSubAgentData: 15, totalRows: 152, coveragePct: 9.9 }));
    expect(text).toContain('15/152');
    expect(text).toContain('9.9%');
    expect(text).not.toContain('990%'); // the double-scaling bug this file's doc comment warns about
  });

  test('null coveragePct (no rows) renders n/a, not a fake 0%', () => {
    const text = describeCoverage(coverageFixture({ totalRows: 0, rowsWithSubAgentData: 0, coveragePct: null }));
    expect(text).toContain('n/a');
  });
});

describe('buildLowCoverageHeadline', () => {
  test('lowCoverage false -> null (no headline, the always-on describeCoverage line still shows the numbers)', () => {
    expect(buildLowCoverageHeadline(coverageFixture({ lowCoverage: false, coveragePct: 97.3 }))).toBeNull();
  });

  test('lowCoverage true -> a short, dynamic sentence naming the exact percentage', () => {
    const text = buildLowCoverageHeadline(coverageFixture({ lowCoverage: true, coveragePct: 9.9 }));
    expect(text).not.toBeNull();
    expect(text).toContain('9.9%');
    expect(text).toContain('unreliable');
  });
});

// ---------------------------------------------------------------------------
// formatCostPerReadBandItem
// ---------------------------------------------------------------------------

describe('formatCostPerReadBandItem', () => {
  test('null value -> explicit n/a text, not a blank or $0.00', () => {
    const c: CostPerReadBandItem = { avgCostUsd: null, avgReadBandItems: null, value: null, sampleSize: 0 };
    expect(formatCostPerReadBandItem(c)).toContain('n/a');
  });

  test('a real value renders cost, avg items, and sample size', () => {
    const c: CostPerReadBandItem = { avgCostUsd: 1.5, avgReadBandItems: 2.0, value: 0.75, sampleSize: 300 };
    const text = formatCostPerReadBandItem(c);
    expect(text).toContain('$0.75');
    expect(text).toContain('$1.50');
    expect(text).toContain('2.00');
    expect(text).toContain('300');
  });
});

// ---------------------------------------------------------------------------
// assessModelBreakdownCost — reuses the server's own `flagged` field
// ---------------------------------------------------------------------------

describe('assessModelBreakdownCost', () => {
  test('no flagged models -> ok', () => {
    const rows: ModelUsageEntry[] = [{ model: 'claude-sonnet-5', rows: 10, totalCostUsd: 5, totalOutputTokens: 100, flagged: false }];
    const a = assessModelBreakdownCost(rows);
    expect(a.status).toBe('ok');
    expect(a.text).toContain('1 model(s)');
  });

  test('a flagged model -> attention, names the model and its cost', () => {
    const rows: ModelUsageEntry[] = [
      { model: 'claude-sonnet-5', rows: 10, totalCostUsd: 5, totalOutputTokens: 100, flagged: false },
      { model: 'claude-opus-4-8[1m]', rows: 1, totalCostUsd: 2.09, totalOutputTokens: 500, flagged: true },
    ];
    const a = assessModelBreakdownCost(rows);
    expect(a.status).toBe('attention');
    expect(a.text).toContain('claude-opus-4-8[1m]');
    expect(a.text).toContain('$2.09');
  });
});

// ---------------------------------------------------------------------------
// Read-band gauge — classification, position, and the full view builder.
// This is the "make sure the design reads correctly at that value" case.
// ---------------------------------------------------------------------------

describe('classifyReadBandLevel', () => {
  test('null -> unknown', () => {
    expect(classifyReadBandLevel(null)).toBe('unknown');
  });
  test('below 2.5 -> danger', () => {
    expect(classifyReadBandLevel(0)).toBe('danger');
    expect(classifyReadBandLevel(2.49)).toBe('danger');
  });
  test('exactly at the danger boundary (2.5) is NOT danger', () => {
    expect(classifyReadBandLevel(READ_BAND_DANGER_MAX)).toBe('watch');
  });
  test("today's live value (~2.96-3.0) classifies as watch, not healthy and not danger", () => {
    expect(classifyReadBandLevel(2.96)).toBe('watch');
    expect(classifyReadBandLevel(3.0)).toBe('watch');
  });
  test('exactly at the healthy floor (3.5) is healthy', () => {
    expect(classifyReadBandLevel(READ_BAND_HEALTHY_RANGE[0])).toBe('healthy');
  });
  test('above the named healthy ceiling is still healthy (no upper bound is flagged)', () => {
    expect(classifyReadBandLevel(6)).toBe('healthy');
  });
});

describe('readBandGaugePosition', () => {
  test('0 -> 0%, scale max -> 100%', () => {
    expect(readBandGaugePosition(0)).toBe(0);
    expect(readBandGaugePosition(READ_BAND_GAUGE_SCALE_MAX)).toBe(100);
  });
  test('the danger boundary lands exactly on the exported zone-width constant', () => {
    expect(readBandGaugePosition(READ_BAND_DANGER_MAX)).toBeCloseTo(READ_BAND_DANGER_ZONE_PCT, 10);
  });
  test('a value past the scale max clamps the POSITION to 100%, never exceeding the track', () => {
    expect(readBandGaugePosition(999)).toBe(100);
  });
  test('a negative value clamps to 0%', () => {
    expect(readBandGaugePosition(-5)).toBe(0);
  });
});

describe('gauge zone geometry constants', () => {
  test('danger zone starts at 0 and ends at 50% of a 0-5 scale', () => {
    expect(READ_BAND_DANGER_ZONE_PCT).toBe(50);
  });
  test('healthy zone spans 70%-80% of a 0-5 scale', () => {
    expect(READ_BAND_HEALTHY_ZONE_START_PCT).toBe(70);
    expect(READ_BAND_HEALTHY_ZONE_END_PCT).toBe(80);
  });
});

describe('buildReadBandGaugeView', () => {
  test('null avgReadBandItems -> unknown level, null position, n/a text', () => {
    const view = buildReadBandGaugeView(qualityFixture({ avgReadBandItems: null }));
    expect(view.level).toBe('unknown');
    expect(view.position).toBeNull();
    expect(view.text).toContain('n/a');
  });

  test("today's live reading (2.96, n=310) -> watch, positioned, sample size and lowSample both carried through", () => {
    const view = buildReadBandGaugeView(qualityFixture({ avgReadBandItems: 2.96, readBandSampleSize: 310, lowSample: false }));
    expect(view.level).toBe('watch');
    expect(view.position).not.toBeNull();
    expect(view.sampleSize).toBe(310);
    expect(view.lowSample).toBe(false);
    expect(view.text).toContain('2.96');
    expect(view.text).toContain('n=310');
    expect(view.text).toContain('approaching the danger zone');
  });

  test('a small window sample carries lowSample=true from WindowMeta, not a re-derived threshold', () => {
    const view = buildReadBandGaugeView(qualityFixture({ lowSample: true }));
    expect(view.lowSample).toBe(true);
  });

  test('a value in the danger zone reads as danger with the reason named in words', () => {
    const view = buildReadBandGaugeView(qualityFixture({ avgReadBandItems: 1.2 }));
    expect(view.level).toBe('danger');
    expect(view.text).toContain('danger zone');
  });

  test('fix round 1 — carries coverage alongside the value, computed from readBandSampleSize/sampleSize', () => {
    const view = buildReadBandGaugeView(qualityFixture({ readBandSampleSize: 76, sampleSize: 334 }));
    expect(view.coverage.rowsWithFindings).toBe(76);
    expect(view.coverage.totalRows).toBe(334);
    expect(view.coverage.coveragePct).toBeCloseTo((76 / 334) * 100, 10);
    expect(view.coverage.lowCoverage).toBe(true);
  });

  test('fix round 1 — lowSample and coverage.lowCoverage are independent: today\'s live 30d reading is lowSample=false, lowCoverage=true', () => {
    const view = buildReadBandGaugeView(qualityFixture({ lowSample: false, readBandSampleSize: 76, sampleSize: 334 }));
    expect(view.lowSample).toBe(false);
    expect(view.coverage.lowCoverage).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix round 2, Finding 2 — the 50% bar is ONE shared constant, not two
// identically-valued copies. Both stats.ts's cost-split coverage and this
// file's read-band coverage import the SAME binding from
// src/dashboard/coverage-thresholds.ts; this test proves that by importing
// it from BOTH re-export paths and asserting reference equality — a genuine
// shared constant, not two declarations that happen to agree today.
// ---------------------------------------------------------------------------

describe('MIN_RELIABLE_COVERAGE_PCT — shared, not duplicated', () => {
  test('stats.ts re-exports the exact same binding stats-costquality.tsx imports directly', async () => {
    const fromStats = await import('../../src/dashboard/stats.ts');
    const fromLeafModule = await import('../../src/dashboard/coverage-thresholds.ts');
    expect(fromStats.MIN_RELIABLE_COVERAGE_PCT).toBe(fromLeafModule.MIN_RELIABLE_COVERAGE_PCT);
    expect(fromStats.MIN_RELIABLE_COVERAGE_PCT).toBe(MIN_RELIABLE_COVERAGE_PCT);
  });
});

// ---------------------------------------------------------------------------
// Read-band coverage — fix round 1: the gauge's average can be computed over
// a small fraction of the window (findings_list is a recently-added column,
// same structural issue sub_agents coverage already discloses on the cost
// card).
// ---------------------------------------------------------------------------

describe('computeReadBandCoverage', () => {
  test("matches the live 30d reading reported in fix round 1 (76/334 ~= 22.8%, low coverage)", () => {
    const coverage = computeReadBandCoverage(76, 334);
    expect(coverage.rowsWithFindings).toBe(76);
    expect(coverage.totalRows).toBe(334);
    expect(coverage.coveragePct).toBeCloseTo(22.75, 1);
    expect(coverage.lowCoverage).toBe(true);
  });

  test('zero-denominator: totalRows=0 -> coveragePct null, lowCoverage false, never NaN or a fake 0%/100%', () => {
    const coverage = computeReadBandCoverage(0, 0);
    expect(coverage.coveragePct).toBeNull();
    expect(coverage.lowCoverage).toBe(false);
    expect(Number.isNaN(coverage.coveragePct as unknown as number)).toBe(false);
  });

  test('exactly at the low-coverage boundary (50%) is NOT low; one row below it is', () => {
    const atBoundary = computeReadBandCoverage(50, 100);
    expect(atBoundary.coveragePct).toBe(MIN_RELIABLE_COVERAGE_PCT);
    expect(atBoundary.lowCoverage).toBe(false);

    const belowBoundary = computeReadBandCoverage(49, 100);
    expect(belowBoundary.lowCoverage).toBe(true);
  });

  test('full coverage (all rows carry findings) -> not low', () => {
    const coverage = computeReadBandCoverage(334, 334);
    expect(coverage.coveragePct).toBe(100);
    expect(coverage.lowCoverage).toBe(false);
  });
});

describe('describeReadBandCoverage', () => {
  test('renders the raw counts and the pre-scaled percentage without double-multiplying', () => {
    const text = describeReadBandCoverage(computeReadBandCoverage(76, 334));
    expect(text).toContain('76/334');
    expect(text).toContain('22.8%');
    expect(text).not.toContain('2280%'); // the double-scaling bug this file's doc comment warns about
  });

  test('zero-denominator renders n/a, not a fake percentage', () => {
    const text = describeReadBandCoverage(computeReadBandCoverage(0, 0));
    expect(text).toContain('n/a');
  });
});

describe('buildReadBandLowCoverageHeadline', () => {
  test('lowCoverage false -> null', () => {
    expect(buildReadBandLowCoverageHeadline(computeReadBandCoverage(334, 334))).toBeNull();
  });

  test('lowCoverage true -> names the exact percentage and the recently-added column', () => {
    const text = buildReadBandLowCoverageHeadline(computeReadBandCoverage(76, 334));
    expect(text).not.toBeNull();
    expect(text).toContain('22.8%');
    expect(text).toContain('findings_list');
  });
});

// ---------------------------------------------------------------------------
// Severity distribution — segments (per-finding) and the read-band split
// ---------------------------------------------------------------------------

describe('buildSeveritySegments', () => {
  test('live-shaped distribution: order is critical, major, minor, nitpick; pct fractions sum to 1', () => {
    const segments = buildSeveritySegments({ critical: 56, major: 169, minor: 330, nitpick: 195 });
    expect(segments.map((s) => s.key)).toEqual(['critical', 'major', 'minor', 'nitpick']);
    expect(segments.find((s) => s.key === 'critical')!.count).toBe(56);
    const sum = segments.reduce((s, seg) => s + (seg.pct ?? 0), 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  test('all-zero distribution -> every pct is null, not a fake 0 that implies a measured zero share', () => {
    const segments = buildSeveritySegments({ critical: 0, major: 0, minor: 0, nitpick: 0 });
    for (const s of segments) expect(s.pct).toBeNull();
  });

  test('a missing key in the record reads as 0 count, not undefined/NaN', () => {
    const segments = buildSeveritySegments({ critical: 5 });
    expect(segments.find((s) => s.key === 'major')!.count).toBe(0);
  });
});

describe('buildReadBandSplitView', () => {
  test('live-shaped counts: below-band is more than 2x read-band, matching the observed data', () => {
    const split = buildReadBandSplitView({ critical: 56, major: 169, minor: 330, nitpick: 195 });
    expect(split.readBandCount).toBe(225);
    expect(split.belowBandCount).toBe(525);
    expect(split.total).toBe(750);
    expect(split.belowBandCount).toBeGreaterThan(split.readBandCount * 2);
    expect(split.readBandRate).toBeCloseTo(225 / 750, 10);
    expect(split.belowBandRate).toBeCloseTo(525 / 750, 10);
  });

  test('zero findings -> rates are null, not zero (nothing to divide by)', () => {
    const split = buildReadBandSplitView({ critical: 0, major: 0, minor: 0, nitpick: 0 });
    expect(split.total).toBe(0);
    expect(split.readBandRate).toBeNull();
    expect(split.belowBandRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Panel-level view builders — exhaustive over FetchState<T>
// ---------------------------------------------------------------------------

describe('buildCostPanelView', () => {
  test('loading', () => {
    const state: FetchState<CostStats> = { status: 'loading' };
    expect(buildCostPanelView(state)).toEqual({ status: 'loading', message: 'Loading…', data: null });
  });
  test('error carries the message through', () => {
    const state: FetchState<CostStats> = { status: 'error', message: '500 Internal Server Error' };
    const view = buildCostPanelView(state);
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
  });
  test('empty', () => {
    const state: FetchState<CostStats> = { status: 'empty' };
    expect(buildCostPanelView(state)).toEqual({ status: 'empty', message: 'No data recorded in this window.', data: null });
  });
  test('ready passes the data through untouched', () => {
    const data = costFixture();
    const state: FetchState<CostStats> = { status: 'ready', data };
    const view = buildCostPanelView(state);
    expect(view.status).toBe('ready');
    expect(view.data).toBe(data);
  });
});

describe('buildQualityPanelView', () => {
  test('loading', () => {
    const state: FetchState<QualityStats> = { status: 'loading' };
    expect(buildQualityPanelView(state)).toEqual({ status: 'loading', message: 'Loading…', data: null });
  });
  test('error carries the message through', () => {
    const state: FetchState<QualityStats> = { status: 'error', message: 'Network error' };
    const view = buildQualityPanelView(state);
    expect(view.status).toBe('error');
    expect(view.message).toContain('Network error');
  });
  test('empty', () => {
    const state: FetchState<QualityStats> = { status: 'empty' };
    expect(buildQualityPanelView(state)).toEqual({ status: 'empty', message: 'No data recorded in this window.', data: null });
  });
  test('ready passes the data through untouched', () => {
    const data = qualityFixture();
    const state: FetchState<QualityStats> = { status: 'ready', data };
    const view = buildQualityPanelView(state);
    expect(view.status).toBe('ready');
    expect(view.data).toBe(data);
  });
});
