import { describe, test, expect } from 'bun:test';
import {
  collectDeclaredPins,
  buildAgentModelRows,
  formatObservedBreakdown,
  buildContaminationAvailability,
} from '../../src/dashboard/client/model-contamination.ts';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { SubAgentModelAttributionEntry } from '../../src/dashboard/stats.ts';
import type { ConfigReport } from '../../src/dashboard/config-report.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/tool-breakdown.test.ts). Every
// function under test is pure: given data, it returns a value.
//
// Moved out of stats-integrity.test.ts in fix round 2, when this logic moved
// out of stats-integrity.tsx into its own shared module (model-contamination.ts)
// — both stats-ribbon.tsx's combined "Model integrity" card and
// stats-integrity.tsx's "Model contamination" panel section import from here,
// so the cross-reference logic itself is tested once, at its real source.

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

// ---------------------------------------------------------------------------
// collectDeclaredPins
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

// ---------------------------------------------------------------------------
// buildAgentModelRows
// ---------------------------------------------------------------------------

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
    expect(rows.map((r: { agent: string }) => r.agent)).toEqual(['al-performance-analyzer', 'zebra-analyzer']);
  });
});

// ---------------------------------------------------------------------------
// formatObservedBreakdown
// ---------------------------------------------------------------------------

describe('formatObservedBreakdown', () => {
  test('joins model:count pairs, a missing model reads as (unknown) not blank', () => {
    expect(formatObservedBreakdown([{ model: 'claude-sonnet-5', count: 86 }, { model: null, count: 2 }]))
      .toBe('claude-sonnet-5: 86 · (unknown): 2');
  });
});

// ---------------------------------------------------------------------------
// buildContaminationAvailability — fix round 2. The one function both
// consumers (ribbon card, panel section) now share for turning
// FetchState<ConfigReport> into a ready-to-use ContaminationAvailability.
// ---------------------------------------------------------------------------

describe('buildContaminationAvailability', () => {
  const entries: SubAgentModelAttributionEntry[] = [{ agent: 'al-performance-analyzer', model: 'claude-opus-5', count: 9 }];

  test('configState loading -> loading, no rows computed', () => {
    const state: FetchState<ConfigReport> = { status: 'loading' };
    expect(buildContaminationAvailability(entries, state)).toEqual({ status: 'loading' });
  });

  test('configState error -> error, message passed through', () => {
    const state: FetchState<ConfigReport> = { status: 'error', message: '500 Internal Server Error' };
    expect(buildContaminationAvailability(entries, state)).toEqual({ status: 'error', message: '500 Internal Server Error' });
  });

  test("configState empty (unreachable in production, /api/config never reports it) -> error, not silently 'ready' with zero rows", () => {
    const state: FetchState<ConfigReport> = { status: 'empty' };
    const result = buildContaminationAvailability(entries, state);
    expect(result.status).toBe('error');
  });

  test('configState ready -> ready, rows built via collectDeclaredPins + buildAgentModelRows', () => {
    const config = configFixture([subAgentGroup([{ file: 'al-performance-analyzer.md', declaredModel: 'claude-sonnet-5' }])]);
    const state: FetchState<ConfigReport> = { status: 'ready', data: config };
    const result = buildContaminationAvailability(entries, state);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.rows).toEqual([{
        agent: 'al-performance-analyzer', declaredModel: 'claude-sonnet-5',
        observed: [{ model: 'claude-opus-5', count: 9 }], totalRuns: 9, offPinRuns: 9, status: 'attention',
      }]);
    }
  });
});
