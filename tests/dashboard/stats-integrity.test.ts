import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildModelUsageSectionView,
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
import { NO_MODEL_ACTIVITY_TEXT, FLAGGED_MODEL_KEY_TOOLTIP } from '../../src/dashboard/client/assessors.ts';

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
    population: 'prod',
    otherPopulationCount: 0,
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
// buildModelUsageSectionView — delegates to stats-ribbon's assessFlaggedModelKeys
// so the ribbon's "Model integrity" card and this panel's table never disagree
// about the [1m]-flagged-key signal. (assessModelIntegrity is a different,
// two-argument function since fix round 2 — see stats-ribbon.tsx.)
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
// buildContaminationSectionView — the panel-specific presentation on top of
// the shared cross-reference logic. `collectDeclaredPins` / `buildAgentModelRows`
// / `formatObservedBreakdown` / `buildContaminationAvailability` themselves
// moved to `model-contamination.ts` in fix round 2 (shared with
// stats-ribbon.tsx's combined "Model integrity" card) — see
// tests/dashboard/model-contamination.test.ts for their own tests.
// ---------------------------------------------------------------------------

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

  // I-4: a declared pin that produced zero observed runs must be disclosed,
  // never silently dropped from the "all-clear" summary — this is the exact
  // false all-clear the finding named (7 of 20 declared pins observed).
  describe('declared pins with zero observed runs (I-4)', () => {
    const twoFilesConfig = configFixture([subAgentGroup([
      { file: 'al-performance-analyzer.md', declaredModel: 'claude-sonnet-5' },
      { file: 'al-integration-analyzer.md', declaredModel: 'claude-sonnet-5' },
    ])]);

    test('all-clear summary states how many declared pins were never observed, not just how many ran clean', () => {
      const matchedOnly: SubAgentModelAttributionEntry[] = [{ agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 95 }];
      const view = buildContaminationSectionView(matchedOnly, 'note', configReady(twoFilesConfig));
      expect(view.status).toBe('ok');
      expect(view.summary).toContain('ran only on their declared model');
      expect(view.summary).toContain('1 of 2 declared pins produced zero observed runs');
      // The unobserved pin still gets its own row, not silence.
      expect(view.rows).toHaveLength(2);
      expect(view.rows!.find((r) => r.agent === 'al-integration-analyzer')?.status).toBe('not-observed');
    });

    test('a contamination finding still discloses the never-observed pins alongside it', () => {
      const view = buildContaminationSectionView(pinnedEntries, 'note', configReady(twoFilesConfig));
      expect(view.status).toBe('attention');
      expect(view.summary).toContain('9/95');
      expect(view.summary).toContain('1 of 2 declared pins produced zero observed runs');
    });

    test('zero pinned runs at all still discloses the unobserved pin count, not a bare "no runs" message', () => {
      const view = buildContaminationSectionView([], 'note', configReady(twoFilesConfig));
      expect(view.status).toBe('ok');
      expect(view.summary).toContain('No pinned sub-agent runs recorded');
      expect(view.summary).toContain('2 declared pins produced zero observed runs');
    });

    test('when every declared pin was observed, no disclosure clause is added (nothing to disclose)', () => {
      const bothObserved: SubAgentModelAttributionEntry[] = [
        { agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 95 },
        { agent: 'al-integration-analyzer', model: 'claude-sonnet-5', count: 95 },
      ];
      const view = buildContaminationSectionView(bothObserved, 'note', configReady(twoFilesConfig));
      expect(view.summary).not.toContain('produced zero observed runs');
    });
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

  test('caveat is passed through from dispatch.note verbatim (fix round 2), not re-described client-side', () => {
    // Fix round 1 shipped a hand-written client-side caveat string that
    // duplicated the server's own `dispatch.note` field, which went unread —
    // two hand-written descriptions of one fact, able to drift apart. Fix
    // round 2 deleted the client copy; this pins that `caveat` is now a pure
    // pass-through, mirroring buildEffortDriftSectionView's `note` test.
    const note = 'a very specific server-authored dispatch caveat sentence naming sub_agents';
    const view = buildDispatchSectionView({
      sampleSize: 1, dispatchSampleSize: 1, medianDispatch: 1, p90Dispatch: 1,
      avgRosterCount: 1, mismatchCount: 0, mismatchRate: 0, note,
    });
    expect(view.caveat).toBe(note);
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
    // Task 8 (I12): both DB column names removed from rendered prose — the
    // record-scoping is unchanged ("have both ... recorded"), only the
    // identifiers naming them are gone.
    const view = assessFindingsIntegrity({ comparedRows: 0, mismatchCount: 0, mismatchRate: null });
    expect(view.status).toBe('ok');
    expect(view.text).toBe('No rows in this window have both a findings count and a findings list recorded, so there is nothing to compare here.');
    expect(view.text).not.toContain('findings_count');
    expect(view.text).not.toContain('findings_list');
  });

  test('zero mismatches among compared rows -> ok (printed at 0 mismatches)', () => {
    const view = assessFindingsIntegrity({ comparedRows: 100, mismatchCount: 0, mismatchRate: 0 });
    expect(view.status).toBe('ok');
    expect(view.text).toBe('0/100 rows disagree — 0.0% (comparing the stored findings count against the stored findings list)');
  });

  test('even a single mismatch -> attention (not a known caveat like dispatch) (printed at 1 mismatch)', () => {
    const view = assessFindingsIntegrity({ comparedRows: 100, mismatchCount: 1, mismatchRate: 0.01 });
    expect(view.status).toBe('attention');
    expect(view.text).toBe('1/100 rows disagree — 1.0% (comparing the stored findings count against the stored findings list)');
  });

  test('two mismatches (printed at 2) -> the parenthetical never leaks the raw column names', () => {
    const view = assessFindingsIntegrity({ comparedRows: 50, mismatchCount: 2, mismatchRate: 0.04 });
    expect(view.text).toContain('2/50 rows disagree');
    expect(view.text).not.toContain('findings_count');
    expect(view.text).not.toContain('findings_list');
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

  test('note states the error category is broad, without naming a stored value', () => {
    const view = buildErrorRateSectionView({ count: 0, total: 10, rate: 0 }, false);
    expect(view.note).toBe('"Error" here includes every kind of pipeline failure recorded on the row — not narrowed to one cause.');
  });

  test('the error caveat does not name a database value', () => {
    const view = buildErrorRateSectionView({ count: 0, total: 10, rate: 0 }, false);
    expect(view.note).not.toContain('error_max_turns');
    expect(view.note).toContain('every kind of pipeline failure recorded on the row');
  });

  // Task 8 (I6): dropped the three internal TS class names in rendered prose
  // (PipelineError, RevisionExhaustedError, ExternalServiceError) — same
  // defect class Task 6's review found in a returned string elsewhere. The
  // pinned error_max_turns substring above still carries the "not narrowed
  // to one cause" claim; these three carried no distinct information for a
  // reader with no code access.
  test('the note no longer names internal PipelineError subtypes', () => {
    const view = buildErrorRateSectionView({ count: 0, total: 10, rate: 0 }, false);
    expect(view.note).not.toContain('PipelineError');
    expect(view.note).not.toContain('RevisionExhaustedError');
    expect(view.note).not.toContain('ExternalServiceError');
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

// ---------------------------------------------------------------------------
// Task 8 — schema/internal names removed from rendered prose, and the two
// strings shared with stats-costquality.tsx pulled from ONE constant. Flat
// literals with no count and no branch (S1 ruling) — a source-text pin is
// adequate; there is no rendering logic to exercise.
// ---------------------------------------------------------------------------

describe('Task 8 — integrity prose: schema names gone, shared constants imported', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-integrity.tsx', import.meta.url)),
    'utf-8',
  );

  test('imports the two constants shared with stats-costquality.tsx from assessors.ts, rather than hand-copying them', () => {
    expect(src).toMatch(/import\s*\{[^}]*NO_MODEL_ACTIVITY_TEXT[^}]*\}\s*from\s*['"]\.\.\/assessors\.ts['"]/);
    expect(src).toMatch(/import\s*\{[^}]*FLAGGED_MODEL_KEY_TOOLTIP[^}]*\}\s*from\s*['"]\.\.\/assessors\.ts['"]/);
  });

  test('the two shared constants are actually used, not just imported', () => {
    expect(src).toMatch(/\{NO_MODEL_ACTIVITY_TEXT\}/);
    expect(src).toMatch(/title=\{FLAGGED_MODEL_KEY_TOOLTIP\}/);
  });

  test('this file\'s copy is identical in VALUE to stats-costquality.tsx\'s — proven by both importing the same binding', () => {
    expect(NO_MODEL_ACTIVITY_TEXT).toBe('No model activity recorded in this window.');
    expect(FLAGGED_MODEL_KEY_TOOLTIP).toBe('Matches the [1m] premium long-context contamination pattern');
  });

  test('the literal DB field name model_usage no longer appears in rendered prose (comments describing behaviour are fine)', () => {
    expect(src).not.toMatch(/<p[^>]*>[^<]*model_usage/);
    expect(src).not.toMatch(/title="[^"]*model_usage/);
  });

  test('the ContaminationTable empty state names data, not "attribution"', () => {
    expect(src).toContain('No sub-agent model data recorded in this window.');
    expect(src).not.toContain('No sub-agent model attribution recorded');
  });

  test('the Dispatch section title no longer embeds the tool_calls schema name or the cryptic authoritative-column shorthand', () => {
    expect(src).toContain('Dispatch (recorded tool activity vs. the agent roster)');
    expect(src).not.toMatch(/title="Dispatch \(tool_calls/);
  });
});
