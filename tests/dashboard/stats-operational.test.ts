import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDailyReviewBars,
  buildReviewsChartView,
  buildDurationSectionView,
  buildTurnsSectionView,
  buildToolMixSectionView,
  buildErrorBreakdownSectionView,
  buildOperationalPanelView,
} from '../../src/dashboard/client/components/stats-operational.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { OperationalStats, ToolMixEntry, ErrorClassificationSummary } from '../../src/dashboard/stats.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/stats-costquality.test.ts).
// Every function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// Fixtures — match the real OperationalStats shape (src/dashboard/stats.ts)
// so these tests break if the response shape drifts, mirroring
// stats-costquality.test.ts's costFixture()/qualityFixture() precedent.
// ---------------------------------------------------------------------------

function toolMixFixture(overrides: Partial<ToolMixEntry> = {}): ToolMixEntry {
  return { tool: 'Grep', totalCalls: 120, avgPerReview: 0.8, reviewsUsing: 90, ...overrides };
}

function errorClassificationFixture(overrides: Partial<ErrorClassificationSummary> = {}): ErrorClassificationSummary {
  return {
    total: 0,
    categories: { 'rate-limit': 0, 'no-result': 0, 'schema-validation': 0, other: 0 },
    exemplars: {},
    ...overrides,
  };
}

function operationalFixture(overrides: Partial<OperationalStats> = {}): OperationalStats {
  return {
    window: '30d',
    windowDays: 30,
    since: '2026-07-01T00:00:00.000Z',
    sampleSize: 150,
    lowSample: false,
    population: 'prod',
    otherPopulationCount: 0,
    reviewsPerDay: {
      average: 5.0,
      series: [
        { date: '2026-07-01', count: 5 },
        { date: '2026-07-02', count: 5 },
      ],
    },
    duration: { medianMs: 689_618, p90Ms: 1_141_936, sampleSize: 150 },
    turns: { median: 33, p90: 60, sampleSize: 150 },
    toolMix: [toolMixFixture()],
    perRepo: [{ repoKey: 'repo-a', count: 150, medianDurationMs: 689_618, medianTurns: 33 }],
    errorClassification: errorClassificationFixture(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildDailyReviewBars — the zero-fill that turns a sparse day/count series
// into one entry per calendar day, matching the live production shape
// (30-day window, 21 of 30 days populated) confirmed via a read-only query
// before writing this.
// ---------------------------------------------------------------------------

describe('buildDailyReviewBars', () => {
  test('fills a gap day with a real zero, not an omission', () => {
    const bars = buildDailyReviewBars(
      [{ date: '2026-07-01', count: 5 }, { date: '2026-07-03', count: 7 }],
      '2026-07-01T00:00:00.000Z',
      new Date('2026-07-03T12:00:00.000Z'),
    );
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(bars[1]).toMatchObject({ date: '2026-07-02', count: 0 });
  });

  test('heightPct is scaled against the window\'s own peak day', () => {
    const bars = buildDailyReviewBars(
      [{ date: '2026-07-01', count: 10 }, { date: '2026-07-02', count: 5 }],
      '2026-07-01T00:00:00.000Z',
      new Date('2026-07-02T00:00:00.000Z'),
    );
    expect(bars[0]!.heightPct).toBe(100);
    expect(bars[1]!.heightPct).toBe(50);
  });

  test('all-zero window does not divide by zero', () => {
    const bars = buildDailyReviewBars([], '2026-07-01T00:00:00.000Z', new Date('2026-07-02T00:00:00.000Z'));
    expect(bars.every((b) => Number.isFinite(b.heightPct))).toBe(true);
    expect(bars.every((b) => b.heightPct === 0)).toBe(true);
  });

  test('a since timestamp mid-day still anchors to that calendar day (partial-day disclosure)', () => {
    const bars = buildDailyReviewBars(
      [{ date: '2026-07-01', count: 3 }],
      '2026-07-01T13:45:00.000Z',
      new Date('2026-07-01T18:00:00.000Z'),
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ date: '2026-07-01', count: 3 });
  });

  test('the live production shape: 30-day window, weekday-only gaps zero-filled', () => {
    // Confirmed via a read-only production query before writing this test:
    // 21 of 30 calendar days carried at least one row; every gap fell on a
    // day this test does not assert a cause for, only that it zero-fills.
    const series = [
      { date: '2026-07-02', count: 14 }, { date: '2026-07-05', count: 11 },
      { date: '2026-07-06', count: 15 }, { date: '2026-07-07', count: 2 },
      { date: '2026-07-08', count: 25 }, { date: '2026-07-31', count: 33 },
    ];
    const bars = buildDailyReviewBars(series, '2026-07-02T00:00:00.000Z', new Date('2026-07-31T00:00:00.000Z'));
    expect(bars).toHaveLength(30);
    const zeroDays = bars.filter((b) => b.count === 0);
    expect(zeroDays.length).toBe(30 - series.length);
    // Gap days are present as real entries, not missing from the array.
    expect(bars.find((b) => b.date === '2026-07-03')).toMatchObject({ count: 0 });
    expect(bars.find((b) => b.date === '2026-07-31')).toMatchObject({ count: 33 });
  });
});

// ---------------------------------------------------------------------------
// buildReviewsChartView
// ---------------------------------------------------------------------------

describe('buildReviewsChartView', () => {
  test('averageText states the window, the days, and n', () => {
    const view = buildReviewsChartView(
      { average: 11.1, series: [{ date: '2026-07-31', count: 33 }] },
      30,
      '2026-07-31T00:00:00.000Z',
      333,
      new Date('2026-07-31T00:00:00.000Z'),
    );
    expect(view.averageText).toBe('11.1 reviews/day average over the 30-day window (n=333)');
  });

  test('null average reads as n/a, never a fake number', () => {
    const view = buildReviewsChartView(
      { average: null, series: [] },
      30,
      '2026-07-01T00:00:00.000Z',
      0,
      new Date('2026-07-01T00:00:00.000Z'),
    );
    expect(view.averageText).toBe('n/a');
  });

  test('zeroDays/totalDays count the zero-filled bars, not just the sparse series length', () => {
    const view = buildReviewsChartView(
      { average: 1.0, series: [{ date: '2026-07-01', count: 3 }] },
      2,
      '2026-07-01T00:00:00.000Z',
      3,
      new Date('2026-07-03T00:00:00.000Z'),
    );
    expect(view.totalDays).toBe(3);
    expect(view.zeroDays).toBe(2);
  });

  test('firstDate/lastDate bound the actual bar range', () => {
    const view = buildReviewsChartView(
      { average: 1.0, series: [] },
      2,
      '2026-07-01T00:00:00.000Z',
      0,
      new Date('2026-07-03T00:00:00.000Z'),
    );
    expect(view.firstDate).toBe('2026-07-01');
    expect(view.lastDate).toBe('2026-07-03');
  });
});

// ---------------------------------------------------------------------------
// buildDurationSectionView / buildTurnsSectionView
// ---------------------------------------------------------------------------

describe('buildDurationSectionView', () => {
  test('formats the live production p50/p90 as human-parseable durations, not raw ms', () => {
    const view = buildDurationSectionView({ medianMs: 689_618, p90Ms: 1_141_936, sampleSize: 150 });
    expect(view.medianText).not.toContain('689618');
    expect(view.medianText).toBe('11m 29s');
    expect(view.p90Text).toBe('19m 1s');
    expect(view.sampleSize).toBe(150);
  });

  test('null median/p90 reads as n/a', () => {
    const view = buildDurationSectionView({ medianMs: null, p90Ms: null, sampleSize: 0 });
    expect(view.medianText).toBe('n/a');
    expect(view.p90Text).toBe('n/a');
  });
});

describe('buildTurnsSectionView', () => {
  test('the live production median (33) renders as a plain, unrounded number', () => {
    const view = buildTurnsSectionView({ median: 33, p90: 60, sampleSize: 150 });
    expect(view.medianText).toBe('33');
    expect(view.p90Text).toBe('60');
  });

  test('a fractional percentile (percentile_cont over an integer column) is not rounded away', () => {
    const view = buildTurnsSectionView({ median: 9.5, p90: 22.25, sampleSize: 4 });
    expect(view.medianText).toBe('9.5');
    expect(view.p90Text).toBe('22.25');
  });

  test('null reads as n/a', () => {
    const view = buildTurnsSectionView({ median: null, p90: null, sampleSize: 0 });
    expect(view.medianText).toBe('n/a');
    expect(view.p90Text).toBe('n/a');
  });
});

// ---------------------------------------------------------------------------
// buildToolMixSectionView — the one scored section on this panel. The check
// is generic (any zero-call tool), not hardcoded to the name "lsp", even
// though lsp:0 is the live case the brief calls out by name.
// ---------------------------------------------------------------------------

describe('buildToolMixSectionView', () => {
  test('no tools recorded -> ok, empty rows', () => {
    const view = buildToolMixSectionView([]);
    expect(view.status).toBe('ok');
    expect(view.rows).toEqual([]);
  });

  test('all tools nonzero -> ok, no attention tag', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'Grep' }), toolMixFixture({ tool: 'Read', totalCalls: 40 })]);
    expect(view.status).toBe('ok');
    expect(view.summary).not.toContain('ZERO');
  });

  // I-5: the all-clear wording must state the observed count (not a vague
  // "none at zero calls") AND disclose that an absent tool (never appearing
  // in tool_calls at all, e.g. the live `lsp` case) cannot be represented
  // here — the check has no way to see a tool that has gone silent.
  test('all tools nonzero -> summary states the observed count and discloses the absent-tool blind spot', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'Grep' }), toolMixFixture({ tool: 'Read', totalCalls: 40 })]);
    expect(view.summary).toContain('None of the 2 observed tools had zero calls');
    expect(view.summary).toContain('does not appear in tool_calls at all');
  });

  // Count agreement (Task 7): the all-clear summary used to hard-code
  // "tool(s)" — a literal placeholder that rendered unchanged for every n,
  // including 1, where the correct reading is "tool" (no s). `rows.length`
  // is always >= 1 on this branch (the zero-row case has its own earlier
  // branch, tested above with an empty array), so 1 is a reachable value in
  // production, not a hypothetical.
  test('all-clear at n=1 reads "1 observed tool", not "1 observed tool(s)"', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'Grep' })]);
    expect(view.summary).toBe(
      'None of the 1 observed tool had zero calls in this window. A tool that is never called does not appear in ' +
      'tool_calls at all and therefore cannot be listed here — this table can only speak to tools that fired at ' +
      'least once, not to ones that have gone silent.',
    );
    expect(view.summary).not.toContain('(s)');
  });

  test('all-clear at n=2 reads "2 observed tools"', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'Grep' }), toolMixFixture({ tool: 'Read', totalCalls: 40 })]);
    expect(view.summary).toContain('None of the 2 observed tools had zero calls');
  });

  // The attention summary's denominator (`rows.length`, the total tool
  // count) has the same defect: "1 of 1 tool(s)" is reachable whenever a
  // window recorded exactly one tool, and that one tool happened to be the
  // zero-call one.
  test('attention summary at a denominator of 1 reads "1 of 1 tool", not "1 of 1 tool(s)"', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'lsp', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 })]);
    expect(view.summary).toContain('1 of 1 tool had ZERO calls');
    expect(view.summary).not.toContain('(s)');
  });

  test('attention summary at a denominator of 2 reads "1 of 2 tools"', () => {
    const view = buildToolMixSectionView([
      toolMixFixture({ tool: 'Grep', totalCalls: 300 }),
      toolMixFixture({ tool: 'lsp', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 }),
    ]);
    expect(view.summary).toContain('1 of 2 tools had ZERO calls');
  });

  test('the live lsp:0 case -> attention, named explicitly, not silently sorted to the tail', () => {
    const view = buildToolMixSectionView([
      toolMixFixture({ tool: 'Grep', totalCalls: 300 }),
      toolMixFixture({ tool: 'Read', totalCalls: 200 }),
      toolMixFixture({ tool: 'lsp', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 }),
    ]);
    expect(view.status).toBe('attention');
    expect(view.summary).toContain('lsp');
    expect(view.summary).toContain('1 of 3');
    const lspRow = view.rows.find((r) => r.tool === 'lsp');
    expect(lspRow?.isZero).toBe(true);
    expect(view.rows.find((r) => r.tool === 'Grep')?.isZero).toBe(false);
  });

  test('the rule is generic: a different zero-count tool is flagged the same way', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'SomeOtherTool', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 })]);
    expect(view.status).toBe('attention');
    expect(view.summary).toContain('SomeOtherTool');
  });

  test('multiple zero-count tools are all named, not truncated to one', () => {
    const view = buildToolMixSectionView([
      toolMixFixture({ tool: 'lsp', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 }),
      toolMixFixture({ tool: 'WebFetch', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 }),
    ]);
    expect(view.summary).toContain('lsp');
    expect(view.summary).toContain('WebFetch');
    expect(view.summary).toContain('2 of 2');
  });
});

// ---------------------------------------------------------------------------
// buildErrorBreakdownSectionView (fix round 1) — 'attention' iff a
// rate-limit event occurred this window; an unclassified ('other') count is
// a caveat, not a second path to 'attention' (see the module doc comment).
// ---------------------------------------------------------------------------

describe('buildErrorBreakdownSectionView', () => {
  test('the 30d live case (per the fix round finding) — zero rate-limit events is ok, stated as a real reading', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture());
    expect(view.status).toBe('ok');
    expect(view.summary).toContain('0 errors');
    // States plainly that this IS a verified zero, distinct from "we cannot
    // tell" — the exact distinction the fix round's finding calls for.
    expect(view.summary).toContain('verified reading');
    expect(view.rows.find((r) => r.key === 'rate-limit')).toMatchObject({ count: 0, exemplar: null });
  });

  test('the 90d live case (per the fix round finding) — a nonzero rate-limit count is attention, named explicitly', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture({
      total: 31,
      categories: { 'rate-limit': 21, 'no-result': 7, 'schema-validation': 2, other: 1 },
      exemplars: {
        'rate-limit': 'Rate limit hit during "pr-reviewer": 11:50pm (UTC)',
        'no-result': 'Agent "pr-reviewer" failed to produce a result',
        'schema-validation': 'Agent "pr-reviewer" output failed schema validation',
        other: 'Something went wrong',
      },
    }));
    expect(view.status).toBe('attention');
    expect(view.summary).toContain('21 rate-limit');
    expect(view.otherCount).toBe(1);
    const rateLimitRow = view.rows.find((r) => r.key === 'rate-limit');
    expect(rateLimitRow?.count).toBe(21);
    expect(rateLimitRow?.exemplar).toBe('Rate limit hit during "pr-reviewer": 11:50pm (UTC)');
  });

  test('a nonzero OTHER count alone (no rate-limit) does not push status to attention', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture({
      total: 3,
      categories: { 'rate-limit': 0, 'no-result': 2, 'schema-validation': 0, other: 1 },
    }));
    expect(view.status).toBe('ok');
    expect(view.otherCount).toBe(1);
  });

  test('rows are always all four categories, in a fixed order, even when some are zero', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture());
    expect(view.rows.map((r) => r.key)).toEqual(['rate-limit', 'no-result', 'schema-validation', 'other']);
  });

  test('a category with zero count has a null exemplar, never a fabricated placeholder string', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture({ total: 1, categories: { 'rate-limit': 1, 'no-result': 0, 'schema-validation': 0, other: 0 }, exemplars: { 'rate-limit': 'Rate limit hit during "pr-reviewer": 11am (UTC)' } }));
    expect(view.rows.find((r) => r.key === 'no-result')?.exemplar).toBeNull();
  });

  // Count agreement (Task 7): `total` fed a hard-coded "error(s)" literal.
  // The total===0 branch is a separate hand-written sentence (tested above)
  // and never reaches this clause; total===1 is the reachable singular case
  // for the clause under test.
  test('total===1 reads "1 error recorded", not "1 error(s) recorded"', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture({
      total: 1,
      categories: { 'rate-limit': 0, 'no-result': 1, 'schema-validation': 0, other: 0 },
    }));
    expect(view.summary).toContain('1 error recorded in this window');
    expect(view.summary).not.toContain('(s)');
  });

  test('total===2 reads "2 errors recorded"', () => {
    const view = buildErrorBreakdownSectionView(errorClassificationFixture({
      total: 2,
      categories: { 'rate-limit': 0, 'no-result': 1, 'schema-validation': 1, other: 0 },
    }));
    expect(view.summary).toContain('2 errors recorded in this window');
  });
});

// ---------------------------------------------------------------------------
// buildOperationalPanelView — mirrors buildQualityPanelView's/
// buildConfigPanelView's exhaustive four-branch shape.
// ---------------------------------------------------------------------------

describe('buildOperationalPanelView', () => {
  test('loading', () => {
    const state: FetchState<OperationalStats> = { status: 'loading' };
    expect(buildOperationalPanelView(state)).toEqual({ status: 'loading', message: 'Loading…', data: null });
  });

  test('error carries the message', () => {
    const state: FetchState<OperationalStats> = { status: 'error', message: '500 Internal Server Error' };
    const view = buildOperationalPanelView(state);
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
  });

  test('empty reads distinctly from error', () => {
    const state: FetchState<OperationalStats> = { status: 'empty' };
    const view = buildOperationalPanelView(state);
    expect(view.status).toBe('empty');
    expect(view.message).not.toContain('Failed');
  });

  test('ready carries the real data through untouched', () => {
    const data = operationalFixture();
    const state: FetchState<OperationalStats> = { status: 'ready', data };
    const view = buildOperationalPanelView(state);
    expect(view.status).toBe('ready');
    expect(view.data).toBe(data);
  });
});

// ---------------------------------------------------------------------------
// Count agreement — structural guard (Task 7).
//
// Seven of the ten sites this task fixes are hand-written template literals
// directly inside JSX render functions (ReviewsPerDayChart,
// DurationTurnsSection, ToolMixSection, RepoBreakdownSection,
// ErrorBreakdownSection), never routed through a pure builder — unlike
// buildToolMixSectionView/buildErrorBreakdownSectionView above, there is no
// value a `describe(...)`-style test can call and assert on. The task's
// "Do NOT restructure / extract view models" constraint rules out adding new
// pure string functions purely to create that seam.
//
// So this mirrors the "review-value structure" block in
// stats-review-value.test.ts (source-text assertions, for properties a value
// assertion cannot reach) rather than rendering a component tree, which
// stats-costquality.test.ts's convention (repeated at the top of this file)
// rules out. A `(s)` literal reappearing ANYWHERE in this file — at any of
// these seven sites, or a new one introduced later — makes the sweep fail;
// that is what stops the next edit reintroducing the class here, the same
// job the value-level tests above do for the two sites that are pure
// functions.
// ---------------------------------------------------------------------------

describe('operational card — count agreement in JSX-only prose (structural guard)', () => {
  const cardSrc = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-operational.tsx', import.meta.url)),
    'utf-8',
  );

  // Excludes the one legitimate `(s)` substring in the file: the arrow-fn
  // parameter `.map((s) => ...)` in buildDailyReviewBars, where `(s)` is
  // preceded by the call's own opening paren, never by a letter — a
  // hand-written prose placeholder is always `word(s)`, preceded by a letter.
  const HANDWRITTEN_S_PLACEHOLDER = /(?<!\()\(s\)/;

  test('the guard regex actually catches a placeholder and ignores the one legitimate (s) in the file', () => {
    expect(HANDWRITTEN_S_PLACEHOLDER.test('tool(s)')).toBe(true);
    expect(HANDWRITTEN_S_PLACEHOLDER.test('.map((s) => [s.date, s.count])')).toBe(false);
  });

  test('no hand-written "(s)" placeholder survives anywhere in the file', () => {
    expect(cardSrc).not.toMatch(HANDWRITTEN_S_PLACEHOLDER);
  });

  // 385/404 mirror defect: 385 hard-coded the PLURAL ("calendar days") with
  // no agreement at all, rather than a "(s)" placeholder, so the sweep above
  // does not catch it on its own — checked directly here.
  test('the aria-label no longer hard-codes the plural "calendar days"', () => {
    expect(cardSrc).not.toContain('calendar days had zero reviews recorded');
  });

  // 385 (aria-label, screen reader) and 404 (visible note) state the same
  // fact in two channels and must render the same grammar for the same
  // values (brief's explicit requirement). Both now call the byte-identical
  // expression, which makes that a construction guarantee rather than
  // something that has to be kept in sync by hand.
  test('385 (aria-label) and 404 (visible note) call the identical countOf expression', () => {
    const occurrences = cardSrc.split("countOf(view.totalDays, 'calendar day')").length - 1;
    expect(occurrences).toBe(2);
  });

  test('251/267 (tool mix) and 323 (error breakdown) route through countOf, not a literal', () => {
    expect(cardSrc).toContain("countOf(rows.length, 'observed tool')");
    expect(cardSrc).toContain("countOf(rows.length, 'tool')");
    expect(cardSrc).toContain("countOf(errorClassification.total, 'error')");
  });

  test('437/438 (duration & turns note) route all three counts through countOf', () => {
    expect(cardSrc).toContain("countOf(duration.sampleSize, 'row')");
    expect(cardSrc).toContain("countOf(turns.sampleSize, 'row')");
    expect(cardSrc).toContain("countOf(data.sampleSize, 'total row')");
  });

  test('485 (tool mix average note) routes through countOf', () => {
    expect(cardSrc).toContain("countOf(data.sampleSize, 'review')");
  });

  test('521 (repo breakdown note) routes both counts through countOf', () => {
    expect(cardSrc).toContain("countOf(data.perRepo.length, 'repo')");
  });

  test('571 (unclassified-error caveat) routes through countOf', () => {
    expect(cardSrc).toContain("countOf(view.otherCount, 'error')");
  });

  // 393 (bar title) already had correct behaviour via a hand-written ternary
  // — not one of the ten defect sites, but the brief invited using the
  // helper here too for consistency. Not a behaviour change: countOf(n,
  // 'review') renders identically to the ternary it replaces (both verified
  // in the evidence script — see task-7-report.md).
  test('393 (bar title) uses the helper for consistency, not a hand-written ternary', () => {
    expect(cardSrc).toContain("countOf(b.count, 'review')");
    expect(cardSrc).not.toContain("review${b.count === 1 ? '' : 's'}");
  });

  test('the file actually imports countOf — a guard against the calls above being dead literals in a comment', () => {
    expect(cardSrc).toMatch(/import\s*\{\s*countOf\s*\}\s*from\s*'\.\.\/\.\.\/count-phrase\.ts'/);
  });
});
