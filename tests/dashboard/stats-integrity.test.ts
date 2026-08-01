import { describe, test, expect } from 'bun:test';
import {
  buildModelUsageSectionView,
  collectDeclaredPins,
  buildAgentModelRows,
  formatObservedBreakdown,
  buildContaminationSectionView,
  buildDispatchSectionView,
  buildEffortDriftSectionView,
  formatEffortMix,
  assessFindingsIntegrity,
  buildErrorRateSectionView,
  buildIntegrityPanelView,
} from '../../src/dashboard/client/components/stats-integrity.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { IntegrityStats, EffortMix, SubAgentModelAttributionEntry } from '../../src/dashboard/stats.ts';
import type { ConfigReport } from '../../src/dashboard/config-report.ts';

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
    subAgentModelAttribution: { entries: [], note: 'Observed models only — sub_agents undercounts.' },
    ...overrides,
  };
}

/** Minimal ConfigReport fixture — only `subAgents` (declared pins) varies
 *  across tests; every other field is a stub, matching
 *  stats-ribbon.test.ts's configFixture() precedent. */
function configFixture(groups: ConfigReport['subAgents']['groups'], inline: ConfigReport['subAgents']['inline'] = []): ConfigReport {
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
    subAgents: { groups, inline, totalFrontmatterFiles: groups.reduce((s, g) => s + g.count, 0) },
    credential: { prReview: { envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: false, length: null, mode: 'oauth-subscription' } },
    evalLevers: [],
    overlay: { agentOverrideCount: 0, agents: {} },
  };
}

/** A pr-reviewer-shaped group: one SubAgentGroupReport carrying the given
 *  file/declaredModel pairs. */
function subAgentGroup(files: Array<{ file: string; declaredModel: string | null }>): ConfigReport['subAgents']['groups'][number] {
  return { parentAgent: 'pr-reviewer', dirRelativeToRepo: 'src/agents/pr-reviewer/.claude/agents', files, count: files.length };
}

function configReady(config: ConfigReport): FetchState<ConfigReport> {
  return { status: 'ready', data: config };
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
// Model contamination — fix round 1. collectDeclaredPins / buildAgentModelRows
// / buildContaminationSectionView cross-reference IntegrityStats (observed)
// against ConfigReport (declared), which stats.ts deliberately does NOT do.
// ---------------------------------------------------------------------------

describe('collectDeclaredPins', () => {
  test('maps frontmatter file name (minus .md) to its declared model', () => {
    const config = configFixture([subAgentGroup([{ file: 'al-performance-analyzer.md', declaredModel: 'claude-sonnet-5' }])]);
    const pins = collectDeclaredPins(config);
    expect(pins.get('al-performance-analyzer')).toBe('claude-sonnet-5');
  });

  test('a frontmatter file with no model: line maps to null, not omitted', () => {
    const config = configFixture([subAgentGroup([{ file: 'no-pin.md', declaredModel: null }])]);
    expect(collectDeclaredPins(config).has('no-pin')).toBe(true);
    expect(collectDeclaredPins(config).get('no-pin')).toBeNull();
  });

  test('an agent absent from every group and every inline entry is simply absent from the map', () => {
    const config = configFixture([subAgentGroup([{ file: 'al-performance-analyzer.md', declaredModel: 'claude-sonnet-5' }])]);
    expect(collectDeclaredPins(config).has('general-purpose')).toBe(false);
  });

  test('inline sub-agents (e.g. ci-waiter) are included alongside frontmatter groups', () => {
    const config = configFixture([], [{ parentAgent: 'coder', subagentType: 'ci-waiter', mechanism: 'inline', declaredModel: 'claude-haiku-4-5-20251001', declaredMaxTurns: 5, envOverride: null, note: '' }]);
    expect(collectDeclaredPins(config).get('ci-waiter')).toBe('claude-haiku-4-5-20251001');
  });

  test('multiple groups are all folded into one map', () => {
    const config = configFixture([
      subAgentGroup([{ file: 'a.md', declaredModel: 'claude-sonnet-5' }]),
      { parentAgent: 'code-reviewer', dirRelativeToRepo: 'x', files: [{ file: 'b.md', declaredModel: 'claude-opus-5' }], count: 1 },
    ]);
    const pins = collectDeclaredPins(config);
    expect(pins.get('a')).toBe('claude-sonnet-5');
    expect(pins.get('b')).toBe('claude-opus-5');
  });
});

describe('buildAgentModelRows', () => {
  const pins = new Map<string, string | null>([
    ['al-performance-analyzer', 'claude-sonnet-5'],
    ['no-pin-file', null],
  ]);

  test('all observed runs match the declared pin -> ok, zero off-pin runs', () => {
    const entries: SubAgentModelAttributionEntry[] = [{ agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 96 }];
    const rows = buildAgentModelRows(entries, pins);
    expect(rows).toEqual([{
      agent: 'al-performance-analyzer', declaredModel: 'claude-sonnet-5',
      observed: [{ model: 'claude-sonnet-5', count: 96 }], totalRuns: 96, offPinRuns: 0, status: 'ok',
    }]);
  });

  test("live-shaped case: pinned to sonnet, 9 of 95 runs on opus -> attention, off-pin count is exactly the deviating runs", () => {
    const entries: SubAgentModelAttributionEntry[] = [
      { agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 86 },
      { agent: 'al-performance-analyzer', model: 'claude-opus-5', count: 9 },
    ];
    const rows = buildAgentModelRows(entries, pins);
    expect(rows[0]!.status).toBe('attention');
    expect(rows[0]!.totalRuns).toBe(95);
    expect(rows[0]!.offPinRuns).toBe(9);
  });

  test('no declared pin found for the agent -> unpinned, never counted as contamination', () => {
    const entries: SubAgentModelAttributionEntry[] = [{ agent: 'general-purpose', model: 'claude-opus-5', count: 7 }];
    const rows = buildAgentModelRows(entries, pins); // 'general-purpose' is not in `pins` at all
    expect(rows).toEqual([{
      agent: 'general-purpose', declaredModel: null,
      observed: [{ model: 'claude-opus-5', count: 7 }], totalRuns: 7, offPinRuns: 0, status: 'unpinned',
    }]);
  });

  test('a declared pin explicitly recorded as null (frontmatter has no model: line) is ALSO unpinned', () => {
    const entries: SubAgentModelAttributionEntry[] = [{ agent: 'no-pin-file', model: 'claude-sonnet-5', count: 3 }];
    const rows = buildAgentModelRows(entries, pins);
    expect(rows[0]!.status).toBe('unpinned');
  });

  test('rows are sorted by agent name', () => {
    const entries: SubAgentModelAttributionEntry[] = [
      { agent: 'zebra-analyzer', model: 'x', count: 1 },
      { agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 1 },
    ];
    const rows = buildAgentModelRows(entries, pins);
    expect(rows.map((r) => r.agent)).toEqual(['al-performance-analyzer', 'zebra-analyzer']);
  });
});

describe('formatObservedBreakdown', () => {
  test('joins model:count pairs, a missing model reads as (unknown) not blank', () => {
    expect(formatObservedBreakdown([{ model: 'claude-sonnet-5', count: 86 }, { model: null, count: 2 }]))
      .toBe('claude-sonnet-5: 86 · (unknown): 2');
  });
});

describe('buildContaminationSectionView', () => {
  const pinnedEntries: SubAgentModelAttributionEntry[] = [
    { agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 86 },
    { agent: 'al-performance-analyzer', model: 'claude-opus-5', count: 9 },
  ];
  const declaredConfig = configFixture([subAgentGroup([{ file: 'al-performance-analyzer.md', declaredModel: 'claude-sonnet-5' }])]);

  test('configState loading -> the section itself is loading, independent of integrityStats being ready', () => {
    const view = buildContaminationSectionView(pinnedEntries, 'note', { status: 'loading' });
    expect(view.status).toBe('loading');
    expect(view.rows).toBeNull();
  });

  test('configState error -> attention-styled "cannot verify", NOT ok — unverifiable is never silently fine', () => {
    const view = buildContaminationSectionView(pinnedEntries, 'note', { status: 'error', message: '500' });
    expect(view.status).toBe('error');
    expect(view.message).toContain('Cannot verify');
    expect(view.message).toContain('500');
  });

  test('a real deviation -> attention, summary names the off-pin run count', () => {
    const view = buildContaminationSectionView(pinnedEntries, 'note', configReady(declaredConfig));
    expect(view.status).toBe('attention');
    expect(view.summary).toContain('9/95');
    expect(view.rows).toHaveLength(1);
  });

  test('all matched -> ok, summary says so explicitly', () => {
    const matchedEntries: SubAgentModelAttributionEntry[] = [{ agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 95 }];
    const view = buildContaminationSectionView(matchedEntries, 'note', configReady(declaredConfig));
    expect(view.status).toBe('ok');
    expect(view.summary).toContain('ran only on their declared model');
  });

  test('an unpinned-only agent does not count as a pinned row and does not flip status to attention', () => {
    const unpinnedEntries: SubAgentModelAttributionEntry[] = [{ agent: 'general-purpose', model: 'claude-opus-5', count: 7 }];
    const view = buildContaminationSectionView(unpinnedEntries, 'note', configReady(declaredConfig));
    expect(view.status).toBe('ok');
    expect(view.summary).toContain('No pinned sub-agent runs recorded');
  });

  test('undercountNote is passed through from the endpoint verbatim, only on the ready branch', () => {
    const note = 'contamination could be worse than shown, never better';
    const view = buildContaminationSectionView(pinnedEntries, note, configReady(declaredConfig));
    expect(view.undercountNote).toBe(note);
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
  const noPinsReady: FetchState<ConfigReport> = configReady(configFixture([]));

  test('loading -> loading status, every section null (configState irrelevant while integrityStats is loading)', () => {
    const state: FetchState<IntegrityStats> = { status: 'loading' };
    const view = buildIntegrityPanelView(state, { status: 'loading' });
    expect(view.status).toBe('loading');
    expect(view.message).toBe('Loading…');
    expect(view.modelUsage).toBeNull();
    expect(view.contamination).toBeNull();
    expect(view.dispatch).toBeNull();
    expect(view.effortDrift).toBeNull();
    expect(view.findingsIntegrity).toBeNull();
    expect(view.errorRate).toBeNull();
  });

  test('error -> states what failed, in words', () => {
    const state: FetchState<IntegrityStats> = { status: 'error', message: '500 Internal Server Error' };
    const view = buildIntegrityPanelView(state, noPinsReady);
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
    expect(view.contamination).toBeNull();
  });

  test('empty -> reads distinctly from error (no data vs request failed)', () => {
    const state: FetchState<IntegrityStats> = { status: 'empty' };
    const view = buildIntegrityPanelView(state, noPinsReady);
    expect(view.status).toBe('empty');
    expect(view.message).not.toContain('Failed');
  });

  test('ready -> all six sections populated from the one payload + the threaded configState', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture() };
    const view = buildIntegrityPanelView(state, noPinsReady);
    expect(view.status).toBe('ready');
    expect(view.message).toBeNull();
    expect(view.modelUsage).not.toBeNull();
    expect(view.contamination).not.toBeNull();
    expect(view.dispatch).not.toBeNull();
    expect(view.effortDrift).not.toBeNull();
    expect(view.findingsIntegrity).not.toBeNull();
    expect(view.errorRate).not.toBeNull();
    expect(view.sampleSize).toBe(337);
    expect(view.lowSample).toBe(false);
  });

  test('ready + configState still loading -> contamination section itself is loading, rest of the panel unaffected', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture() };
    const view = buildIntegrityPanelView(state, { status: 'loading' });
    expect(view.status).toBe('ready');
    expect(view.contamination!.status).toBe('loading');
    expect(view.dispatch).not.toBeNull(); // unaffected by configState
  });

  test('ready + lowSample -> lowSample surfaced on the panel view', () => {
    const state: FetchState<IntegrityStats> = { status: 'ready', data: integrityFixture({ sampleSize: 4, lowSample: true }) };
    const view = buildIntegrityPanelView(state, noPinsReady);
    expect(view.lowSample).toBe(true);
    expect(view.sampleSize).toBe(4);
  });
});
