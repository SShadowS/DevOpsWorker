import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCostSplitView,
  describeCoverage,
  buildLowCoverageHeadline,
  formatCostPerReadBandItem,
  assessModelBreakdownCost,
  classifyReadBandLevel,
  describeReadBandLevel,
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
import { NO_MODEL_ACTIVITY_TEXT, FLAGGED_MODEL_KEY_TOOLTIP } from '../../src/dashboard/client/assessors.ts';

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
    population: 'prod',
    otherPopulationCount: 0,
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
    population: 'prod',
    otherPopulationCount: 0,
    readBandSampleSize: 310,
    avgReadBandItems: 2.96,
    belowBandCount: 40,
    belowBandPct: 12.9,
    severityDistribution: { critical: 56, major: 169, minor: 330, nitpick: 195 },
    verdictDistribution: { approve: 200, 'request-changes': 100, '(none)': 10 },
    ...overrides,
  };
}

// combinePanelStatus (worst-of-two) was removed in the follow-up assessors
// extraction — `CostQualityPanel` now calls the shared `worstStatus`
// (../../src/dashboard/client/assessors.ts) instead; that function's own
// worst-of-N ranking is covered by tests/dashboard/assessors.test.ts and
// stats-view.test.ts. The four tests that used to live here (error/loading/
// empty/ready-beats-ready) are removed, not migrated — their subject no
// longer exists in this file.

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
    expect(formatCostPerReadBandItem(c))
      .toBe('n/a — no rows with both cost and findings recorded, or every eligible row had zero critical/major items');
  });

  test('a real value renders cost, avg items, and sample size', () => {
    const c: CostPerReadBandItem = { avgCostUsd: 1.5, avgReadBandItems: 2.0, value: 0.75, sampleSize: 300 };
    expect(formatCostPerReadBandItem(c)).toBe('$0.75 per critical/major item (avg cost $1.50 ÷ avg 2.00 items/review, n=300)');
  });

  // Task 8: "read-band item(s)" -> "critical/major item(s)" — the map's
  // "read-band finding" row names a FINDING, not this per-item count; the
  // replacement matches the card's own established phrase instead
  // (buildReadBandGaugeView's `text` already says "critical+major").
  test('neither branch leaks the "read-band" term any more', () => {
    expect(formatCostPerReadBandItem({ avgCostUsd: null, avgReadBandItems: null, value: null, sampleSize: 0 }))
      .not.toContain('read-band');
    expect(formatCostPerReadBandItem({ avgCostUsd: 1, avgReadBandItems: 1, value: 1, sampleSize: 1 }))
      .not.toContain('read-band');
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
      { model: 'claude-opus-4-8[1m]', rows: 1, totalCostUsd: 3.75, totalOutputTokens: 500, flagged: true },
    ];
    const a = assessModelBreakdownCost(rows);
    expect(a.status).toBe('attention');
    expect(a.text).toBe('1 flagged model(s) costing $3.75: claude-opus-4-8[1m] — see the Integrity panel\'s Model usage section');
  });

  // Task 8: dropped "key" — a flagged row is a MODEL, and "key" risked
  // reading as a database key rather than the [1m]-suffixed model name.
  // Printed at 1 and 2 flagged models (the "(s)" convention doesn't
  // pluralize the word itself, so there is no grammar to break at either
  // count, but the substring must hold at both).
  test('two flagged models -> both named, "key" does not appear', () => {
    const rows: ModelUsageEntry[] = [
      { model: 'claude-opus-4-8[1m]', rows: 1, totalCostUsd: 3.75, totalOutputTokens: 500, flagged: true },
      { model: 'claude-sonnet-5[1m]', rows: 2, totalCostUsd: 1.25, totalOutputTokens: 200, flagged: true },
    ];
    const a = assessModelBreakdownCost(rows);
    expect(a.text).toContain('2 flagged model(s)');
    expect(a.text).toContain('claude-opus-4-8[1m], claude-sonnet-5[1m]');
    expect(a.text).not.toContain('key');
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

// Task 8 (C25): extracted so the gauge's aria-label and its visible summary
// text render the SAME clause from one source, instead of the aria-label
// splicing the bare enum key into a sentence ("classified as watch" reads as
// nothing a screen reader should say). Printed at all four levels — this is
// an enum, not a count, so "0/1/2" is the four reachable branches.
describe('describeReadBandLevel', () => {
  test('danger', () => {
    expect(describeReadBandLevel('danger'))
      .toBe('in the danger zone (below 2.5) — reviews are surfacing too few critical/major findings on average');
  });
  test('watch', () => {
    expect(describeReadBandLevel('watch'))
      .toBe('below the healthy band (3.5-4) and approaching the danger zone (below 2.5)');
  });
  test('healthy', () => {
    expect(describeReadBandLevel('healthy')).toBe('within or above the healthy band (3.5-4)');
  });
  test('unknown', () => {
    expect(describeReadBandLevel('unknown')).toBe('no findings data to classify');
  });
  test('all four branches are textually distinct (guards against two levels collapsing to one clause)', () => {
    const texts = (['danger', 'watch', 'healthy', 'unknown'] as const).map(describeReadBandLevel);
    expect(new Set(texts).size).toBe(4);
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

  // Task 8 (C25): the aria-label the component renders is built as
  // `` `...${view.value}, ${describeReadBandLevel(view.level)}` `` — this
  // proves the visible text's own level clause is the SAME string
  // `describeReadBandLevel` produces, at all four levels, without rendering
  // the component tree (which this file's own convention disallows).
  test('the visible text\'s level clause is exactly what describeReadBandLevel(view.level) produces, at every level', () => {
    for (const avg of [1.2, 2.96, 4.0, null]) {
      const view = buildReadBandGaugeView(qualityFixture({ avgReadBandItems: avg }));
      expect(view.text).toContain(describeReadBandLevel(view.level));
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 2, Finding 2 — the 50% bar is meant to be ONE shared constant,
// not two identically-valued copies.
//
// Fix round 3: the first version of this guard asserted `.toBe()` between
// three `number` values pulled from three import paths. That is VALUE
// equality — JS primitives have no reference identity distinct from their
// value — so it could not distinguish one shared binding from three
// unrelated `= 50` declarations that happen to agree today. Demonstrated
// live: a throwaway module with its own independent `export const
// MIN_RELIABLE_COVERAGE_PCT = 50` (zero import relationship to the leaf
// module) passed the old assertion. A future revert of this exact fix —
// re-declaring a local constant in stats-costquality.tsx — would have
// passed it forever.
//
// What CAN fail: source-text regex, the same technique already used for SQL
// shape (`tests/dashboard/stats.test.ts`'s `describe('SQL shape', ...)`
// blocks) for exactly the same reason — behavioural tests cannot see how a
// value was produced, only what it equals. Checked on BOTH consumers named
// in coverage-thresholds.ts's doc comment, not just the one this round's
// finding was filed against — stats.ts could regress the same way (drop the
// import, hand-roll `export const MIN_RELIABLE_COVERAGE_PCT = 50` again)
// with nothing else here to catch it.
// ---------------------------------------------------------------------------

describe('MIN_RELIABLE_COVERAGE_PCT — structural: imported, never re-declared locally', () => {
  const costQualitySrc = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-costquality.tsx', import.meta.url)),
    'utf-8',
  );
  const statsSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/stats.ts', import.meta.url)), 'utf-8');

  test('stats-costquality.tsx imports the constant from the shared leaf module', () => {
    expect(costQualitySrc).toMatch(/import\s*\{\s*MIN_RELIABLE_COVERAGE_PCT\s*\}\s*from\s*['"]\.\.\/\.\.\/coverage-thresholds\.ts['"]/);
  });

  test('stats-costquality.tsx does NOT locally re-declare the constant', () => {
    // This is the exact regression the reviewer demonstrated: a local
    // `export const MIN_RELIABLE...COVERAGE...= ` would satisfy the import
    // check above on its own (both can coexist) while quietly shadowing or
    // duplicating the shared value. Checking for the import's PRESENCE
    // alone is not enough — this second assertion is load-bearing.
    expect(costQualitySrc).not.toMatch(/export const MIN_RELIABLE.*COVERAGE.*=/);
  });

  test('stats.ts (the other consumer) imports the constant from the shared leaf module', () => {
    expect(statsSrc).toMatch(/import\s*\{\s*MIN_RELIABLE_COVERAGE_PCT\s*\}\s*from\s*['"]\.\/coverage-thresholds\.ts['"]/);
  });

  test('stats.ts does NOT locally declare the constant\'s value — only imports and re-exports it', () => {
    expect(statsSrc).not.toMatch(/export const MIN_RELIABLE.*COVERAGE.*=/);
  });
});

// ---------------------------------------------------------------------------
// Task 8 — schema/internal names removed from rendered prose, and the two
// strings shared with stats-integrity.tsx pulled from ONE constant so they
// cannot drift apart. Flat literals with no count and no branch (per the
// review ruling's S1 ruling) — a source-text pin is adequate; there is no
// rendering logic to exercise.
// ---------------------------------------------------------------------------

describe('Task 8 — cost/quality prose: schema names gone, shared constants imported', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-costquality.tsx', import.meta.url)),
    'utf-8',
  );

  test('imports the two constants shared with stats-integrity.tsx from assessors.ts, rather than hand-copying them', () => {
    expect(src).toMatch(/import\s*\{[^}]*NO_MODEL_ACTIVITY_TEXT[^}]*\}\s*from\s*['"]\.\.\/assessors\.ts['"]/);
    expect(src).toMatch(/import\s*\{[^}]*FLAGGED_MODEL_KEY_TOOLTIP[^}]*\}\s*from\s*['"]\.\.\/assessors\.ts['"]/);
  });

  test('the two shared constants are actually used, not just imported', () => {
    expect(src).toMatch(/\{NO_MODEL_ACTIVITY_TEXT\}/);
    expect(src).toMatch(/title=\{FLAGGED_MODEL_KEY_TOOLTIP\}/);
  });

  test('the shared constants hold the expected plain-English values', () => {
    expect(NO_MODEL_ACTIVITY_TEXT).toBe('No model activity recorded in this window.');
    expect(FLAGGED_MODEL_KEY_TOOLTIP).toBe('Matches the [1m] premium long-context contamination pattern');
  });

  test('the literal DB field name model_usage no longer appears anywhere in rendered prose', () => {
    expect(src).not.toMatch(/model_usage/);
  });

  test('the internal function name aggregateModelUsage no longer appears in the rendered cost-lens note', () => {
    expect(src).not.toMatch(/\(one query, aggregateModelUsage\)/);
    expect(src).toMatch(/Same model-cost breakdown as the Integrity panel's "Model usage" table/);
  });

  test('the severity legend divider names critical\\/major, not the bare "read-band" term', () => {
    expect(src).toContain('│ critical/major ends here');
    expect(src).not.toContain('│ read-band ends here');
  });

  test('the below-band note is plain, not ALL-CAPS code-comment style, and still distinguishes the two counts', () => {
    expect(src).toContain('Counted by review, not by individual problem');
    expect(src).not.toContain('Per-REVIEW count');
    expect(src).not.toContain('per-FINDING');
  });

  // Fix round (Important 1): the CostPerItemSection title was the only
  // surviving "read-band" occurrence in a section C3/C4 otherwise scrubbed
  // of the term — title and body named the same thing two different ways.
  test('the "Cost per ..." section title matches the term its own body now uses (C3/C4), not "read-band"', () => {
    expect(src).toContain('title="Cost per critical/major item"');
    expect(src).not.toContain('title="Cost per read-band item"');
  });
});

// ---------------------------------------------------------------------------
// Task 9 sweep — the read-band gauge and severity-split summary were outside
// Task 8's ~35-string list (it named the severity legend divider and the
// "Cost per ..." title only) and still said "read-band"/"below-band" in the
// gauge title, its aria-label, its own summary text, the severity split
// line, and the below-band section title. Same "critical/major" replacement
// Task 8 already applied elsewhere on this card, so the term has one name.
// ---------------------------------------------------------------------------

describe('Task 9 sweep — read-band gauge and severity split, missed by Task 8', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-costquality.tsx', import.meta.url)),
    'utf-8',
  );

  test('the read-band gauge title names critical/major, not "read-band"', () => {
    expect(src).toContain('title="Critical/major findings per review"');
    expect(src).not.toMatch(/title="Read-band health/);
    expect(src).not.toMatch(/title="Findings health/);
  });

  test("the gauge's own summary text and aria-label both say critical/major, not \"read-band items\"", () => {
    // Scoped to the actual template literals, not the file at large — the
    // section-header comment above (line ~150) still says "read-band gauge"
    // and that is fine (comments, not rendered prose, are out of scope).
    expect(src).toContain('text: `avg critical/major findings per review:');
    expect(src).not.toContain('text: `avg read-band items');
    expect(src).toContain('aria-label={`Average critical/major findings per review:');
    expect(src).not.toContain('aria-label={`Average read-band items');
  });

  test('the severity-split summary line says critical/major and minor/nitpick, not "read-band"/"below-band"', () => {
    // Scoped to the JSX summary line, not the chart-choices comment near the
    // top of the file, which legitimately still explains the read-band/
    // below-band split by name for a developer reading the source.
    expect(src).toContain('Critical/major: <strong>{split.readBandCount}</strong>');
    expect(src).toContain('minor/nitpick:');
    expect(src).not.toContain('Read-band (critical+major): <strong>{split.readBandCount}</strong>');
    expect(src).not.toContain('· below-band');
  });

  test('the below-band section title and its note say critical/major, not "read-band"/"below-band"', () => {
    expect(src).toContain('title="Reviews with zero critical/major findings"');
    expect(src).not.toMatch(/title="Reviews with zero read-band findings"/);
    expect(src).not.toContain('below-band reviews counted here');
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

  test('lowCoverage true -> names the exact percentage and says the data is recent, so older reviews predate it', () => {
    // Re-pointed (Task 8, per review ruling): the property this guards is that
    // this KIND OF DATA started being collected recently, so older reviews
    // legitimately have none — not the column's name. A reader with no code
    // access needs the fact, not the identifier that carries it.
    const text = buildReadBandLowCoverageHeadline(computeReadBandCoverage(76, 334));
    expect(text).not.toBeNull();
    expect(text).toContain('22.8%');
    expect(text).toContain('recently added');
    expect(text).toContain('older reviews have none recorded');
    // The schema name itself must NOT leak into rendered prose (Task 6's
    // established defect class — an internal identifier is not a plain word).
    expect(text).not.toContain('findings_list');
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
