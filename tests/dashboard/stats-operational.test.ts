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
  describeZeroDaysClause,
  describeBarTitle,
  describeDurationTurnsSampleNote,
  describeToolMixAverageNote,
  describeRepoBreakdownNote,
  describeOtherErrorsCaveat,
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

  // Fix round 2: "No tool_calls recorded" named the underlying data
  // structure, not a thing this card's reader can see. Exact toBe, not
  // toContain — this is the whole string, not a fragment of a larger one.
  test('no tools recorded -> summary reads "No tool activity", never the column name', () => {
    const view = buildToolMixSectionView([]);
    expect(view.summary).toBe('No tool activity recorded in this window.');
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
  //
  // Fix round 2 (RULE 1 — record-scoping): "does not appear in tool_calls at
  // all" named the underlying data structure. "has no recorded activity at
  // all" says the same thing — absent from the record, not present at
  // zero — without requiring the reader to know what tool_calls is. A window
  // covering reviews from before tool telemetry existed would make the
  // stronger claim ("this tool made zero calls") false; the weaker claim
  // ("we have no record of it") stays true.
  test('all tools nonzero -> summary states the observed count and discloses the absent-tool blind spot', () => {
    const view = buildToolMixSectionView([toolMixFixture({ tool: 'Grep' }), toolMixFixture({ tool: 'Read', totalCalls: 40 })]);
    expect(view.summary).toContain('None of the 2 observed tools had zero calls');
    expect(view.summary).toContain('has no recorded activity at all, so it cannot appear here');
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
      'None of the 1 observed tool had zero calls in this window. A tool that is never called has no recorded ' +
      'activity at all, so it cannot appear here — this table can only speak to tools that fired at least once, ' +
      'not to ones that have gone silent.',
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
// Count agreement — the seven sites that were hand-written template literals
// directly inside JSX render functions (Task 7). Pulled into minimal pure
// functions — just the counts in, the sentence out, nothing restructured —
// so each one is real, value-level, rendered-output evidence: called with
// forced 0/1/2 (and for the 385/404 pair, the two extra required cases),
// printed and asserted on, exactly like buildToolMixSectionView /
// buildErrorBreakdownSectionView above. A source-text regex would prove only
// that `countOf(` appears somewhere near the right variable name — it cannot
// catch a `countOf` call sitting next to a hard-coded verb, or two channels
// that drifted apart while each still individually "contains countOf". This
// codebase already answered which one counts as evidence: stats-review-value.tsx
// got its prose right by putting the sentences in pure builders tests call
// with forced values (module doc comment there: three review rounds before
// that was true), so this follows that precedent rather than a new one.
// ---------------------------------------------------------------------------

describe('describeZeroDaysClause (385 aria-label / 404 visible note — shared source)', () => {
  test('n=0', () => expect(describeZeroDaysClause(0, 5)).toBe('0 of 5 calendar days'));
  test('n=1', () => expect(describeZeroDaysClause(1, 5)).toBe('1 of 5 calendar days'));
  test('n=2', () => expect(describeZeroDaysClause(2, 5)).toBe('2 of 5 calendar days'));

  // Required extra case: zeroDays === totalDays.
  test('zeroDays === totalDays', () => expect(describeZeroDaysClause(3, 3)).toBe('3 of 3 calendar days'));

  // Required extra case: totalDays === 1 (the noun's own agreement point),
  // at both reachable zeroDays values (0 or 1 — zeroDays can never exceed
  // totalDays).
  test('totalDays === 1, zeroDays === 0', () => expect(describeZeroDaysClause(0, 1)).toBe('0 of 1 calendar day'));
  test('totalDays === 1, zeroDays === 1', () => expect(describeZeroDaysClause(1, 1)).toBe('1 of 1 calendar day'));

  test('no "(s)" placeholder survives at any tested value', () => {
    for (const [z, t] of [[0, 5], [1, 5], [2, 5], [3, 3], [0, 1], [1, 1]] as const) {
      expect(describeZeroDaysClause(z, t)).not.toContain('(s)');
    }
  });

  // The construction guarantee: both the aria-label and the visible note
  // call THIS function with the SAME arguments (view.zeroDays, view.totalDays)
  // — verified directly against the source below (secondary net), but the
  // real guarantee is architectural: there is exactly one function that
  // knows how to render this clause, so a screen-reader user and a sighted
  // user cannot get different grammar for the same data.
});

describe('describeBarTitle (393 — helper-consistency swap, not a defect site)', () => {
  test('n=0', () => expect(describeBarTitle('2026-07-01', 0)).toBe('2026-07-01: 0 reviews'));
  test('n=1', () => expect(describeBarTitle('2026-07-01', 1)).toBe('2026-07-01: 1 review'));
  test('n=2', () => expect(describeBarTitle('2026-07-01', 2)).toBe('2026-07-01: 2 reviews'));
});

describe('describeDurationTurnsSampleNote (437/438 — three independent sample sizes)', () => {
  test('n=0 for all three', () => {
    expect(describeDurationTurnsSampleNote(0, 0, 0)).toBe(
      "Duration computed over 0 rows with duration recorded; turns over 0 rows with turns recorded — each may differ from this window's 0 total rows.",
    );
  });

  test('n=1 for all three — the value the old literal always got wrong', () => {
    expect(describeDurationTurnsSampleNote(1, 1, 1)).toBe(
      "Duration computed over 1 row with duration recorded; turns over 1 row with turns recorded — each may differ from this window's 1 total row.",
    );
  });

  test('n=2 for all three', () => {
    expect(describeDurationTurnsSampleNote(2, 2, 2)).toBe(
      "Duration computed over 2 rows with duration recorded; turns over 2 rows with turns recorded — each may differ from this window's 2 total rows.",
    );
  });

  // The three counts are independent (duration/turns/total sample sizes can
  // differ — the whole reason this note exists, per the module doc comment),
  // so a mixed case where they are NOT all equal is the realistic shape.
  test('mixed — each count agrees independently, not all forced to the same form', () => {
    expect(describeDurationTurnsSampleNote(1, 2, 150)).toBe(
      "Duration computed over 1 row with duration recorded; turns over 2 rows with turns recorded — each may differ from this window's 150 total rows.",
    );
  });
});

describe('describeToolMixAverageNote (485)', () => {
  // Fix round 2: the trailing parenthetical used to cite `aggregateToolMix`
  // and `stats.ts` by name — an implementation detail leaking into the one
  // sentence on this card whose reader cannot see the code. toBe pins the
  // whole sentence, not just the count clause, so that citation cannot creep
  // back in unnoticed.
  test('n=0', () => expect(describeToolMixAverageNote(0)).toBe(
    "Average per review is divided by all 0 reviews in this window, not just the reviews that called a given " +
    "tool — a rarely-used tool reads as a correspondingly low average, never one inflated by dividing only by " +
    "the reviews that used it.",
  ));
  test('n=1', () => expect(describeToolMixAverageNote(1)).toBe(
    "Average per review is divided by all 1 review in this window, not just the reviews that called a given " +
    "tool — a rarely-used tool reads as a correspondingly low average, never one inflated by dividing only by " +
    "the reviews that used it.",
  ));
  test('n=2', () => expect(describeToolMixAverageNote(2)).toBe(
    "Average per review is divided by all 2 reviews in this window, not just the reviews that called a given " +
    "tool — a rarely-used tool reads as a correspondingly low average, never one inflated by dividing only by " +
    "the reviews that used it.",
  ));
  test('no "(s)" placeholder survives', () => expect(describeToolMixAverageNote(1)).not.toContain('(s)'));
  test('no internal function or file name survives in the rendered sentence', () => {
    expect(describeToolMixAverageNote(1)).not.toContain('aggregateToolMix');
    expect(describeToolMixAverageNote(1)).not.toContain('stats.ts');
  });
});

describe('describeRepoBreakdownNote (521 — two independent counts)', () => {
  test('n=0 for both', () => expect(describeRepoBreakdownNote(0, 0)).toBe(
    "0 repos across 0 reviews in this window — every row counts here (unlike the Cost card's per-repo table, " +
    "scoped to rows with cost recorded).",
  ));
  test('n=1 for both', () => expect(describeRepoBreakdownNote(1, 1)).toBe(
    "1 repo across 1 review in this window — every row counts here (unlike the Cost card's per-repo table, " +
    "scoped to rows with cost recorded).",
  ));
  test('n=2 for both', () => expect(describeRepoBreakdownNote(2, 2)).toBe(
    "2 repos across 2 reviews in this window — every row counts here (unlike the Cost card's per-repo table, " +
    "scoped to rows with cost recorded).",
  ));
  // The realistic shape: exactly one repo, many reviews against it.
  test('mixed — repo count and review count agree independently', () => {
    expect(describeRepoBreakdownNote(1, 150)).toBe(
      "1 repo across 150 reviews in this window — every row counts here (unlike the Cost card's per-repo table, " +
      "scoped to rows with cost recorded).",
    );
  });
});

describe('describeOtherErrorsCaveat (571)', () => {
  test('n=0', () => expect(describeOtherErrorsCaveat(0)).toBe(
    "0 errors matched none of the three known failure shapes this classifier recognises — a fact about this " +
    "classifier's own coverage (it may need a new pattern), not necessarily a claim that the pipeline itself " +
    "got less reliable. A growing count here is the signal to watch.",
  ));
  test('n=1', () => expect(describeOtherErrorsCaveat(1)).toBe(
    "1 error matched none of the three known failure shapes this classifier recognises — a fact about this " +
    "classifier's own coverage (it may need a new pattern), not necessarily a claim that the pipeline itself " +
    "got less reliable. A growing count here is the signal to watch.",
  ));
  test('n=2', () => expect(describeOtherErrorsCaveat(2)).toBe(
    "2 errors matched none of the three known failure shapes this classifier recognises — a fact about this " +
    "classifier's own coverage (it may need a new pattern), not necessarily a claim that the pipeline itself " +
    "got less reliable. A growing count here is the signal to watch.",
  ));
});

// ---------------------------------------------------------------------------
// Secondary net (not the evidence — the value-level tests above are). A
// `(s)` literal reappearing ANYWHERE in this file, including a new site
// nobody wrote a describe-function test for yet, fails this immediately.
// Mirrors stats-review-value.test.ts's "review-value structure" block
// (source-text assertions for a property a value assertion cannot reach —
// here, "did every call site route through the helper, not just some").
// ---------------------------------------------------------------------------

describe('operational card structure — secondary net', () => {
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

  // 385's specific historical defect was a hard-coded PLURAL ("calendar
  // days"), not a "(s)" placeholder, so the sweep above does not catch it.
  test('no hard-coded "calendar days" plural survives', () => {
    expect(cardSrc).not.toContain('calendar days had zero reviews recorded');
  });

  // The 385/404 construction guarantee, checked directly: both call sites
  // must invoke describeZeroDaysClause — if either were ever rewritten back
  // to its own literal, the two channels could drift apart again silently.
  test('385 (aria-label) and 404 (visible note) both call describeZeroDaysClause', () => {
    const occurrences = cardSrc.split('describeZeroDaysClause(view.zeroDays, view.totalDays)').length - 1;
    expect(occurrences).toBe(2);
  });

  // Fix round 2, Step 1: BOTH `tool_calls` sites named the underlying data
  // structure — the builder's zero-rows branch and the JSX empty state
  // render the identical string, so both must have been rewritten, not just
  // the one an earlier draft of this plan named.
  test('the old "No tool_calls recorded" wording is gone; the replacement appears at both former sites', () => {
    expect(cardSrc).not.toContain('No tool_calls recorded');
    const occurrences = cardSrc.split('No tool activity recorded in this window.').length - 1;
    expect(occurrences).toBe(2);
  });

  // Fix round 2, Step 2 (RULE 1 — record-scoping): the stronger, now-false-
  // shaped claim must be gone, not just supplemented.
  test('the record-scoping clause no longer claims a tool "does not appear in tool_calls"', () => {
    expect(cardSrc).not.toContain('does not appear in tool_calls at all');
  });

  // The `aggregateToolMix`/`stats.ts` citation was found during the sweep for
  // this task, not named in the original brief — it was the trailing
  // parenthetical of describeToolMixAverageNote's RETURNED string (not a
  // comment), so it rendered on the page. Pinned here as its own guard
  // because the value-level toBe tests above only catch it if nobody ever
  // relaxes them back to toContain.
  test('no internal function or file name renders inside a user-facing sentence', () => {
    // Restricted to the return-value line, not the whole file — comments
    // legitimately name `aggregateToolMix`/`stats.ts` as developer
    // documentation; only the RETURNED string may never contain them.
    const returnLine = cardSrc.split('\n').find((l) => l.includes('the reviews that used it'));
    expect(returnLine).toBeDefined();
    expect(returnLine).not.toContain('aggregateToolMix');
    expect(returnLine).not.toContain('stats.ts');
  });

  // Task 9 sweep: the same returned sentence also said "a shrunk denominator"
  // — a math/schema-reasoning term, not the plain "divided by fewer reviews"
  // it now says. Restricted to the return line for the same reason as above:
  // the JSDoc comment two lines up legitimately still says "denominator"
  // describing what the function does, which is not user-facing.
  test('the returned sentence never says "denominator"', () => {
    const returnLine = cardSrc.split('\n').find((l) => l.includes('the reviews that used it'));
    expect(returnLine).toBeDefined();
    expect(returnLine).not.toContain('denominator');
  });

  // Step 3: "turn" is defined in the card's own glossary rather than
  // replaced, since the underlying column is named `turns` and an operator
  // comparing this card to the query behind it wants that link kept.
  // Pinned the same way Task 5 pinned its glossary on stats-review-value.tsx
  // (module doc comment there) — deleting `TERMS` would otherwise leave this
  // suite green while the glossary silently stops defining a word the card
  // still uses.
  test('the glossary term list still defines "a turn" — the word the Duration & turns section uses', () => {
    expect(cardSrc).toContain("term: 'a turn'");
  });

  test('the glossary is not just declared but actually rendered on the panel', () => {
    expect(cardSrc).toContain('<CardGlossary terms={TERMS} />');
  });
});
