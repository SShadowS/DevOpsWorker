import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWindow,
  getWindowDays,
  buildWindowMeta,
  parsePopulation,
  isTestFlag,
  MIN_RELIABLE_SAMPLE,
  readBandCount,
  severityDistribution,
  verdictDistribution,
  computeCostPerReadBandItem,
  findingsCountMismatch,
  sumApportionedSubAgentCost,
  computeSubAgentCoverage,
  MIN_RELIABLE_COVERAGE_PCT,
  aggregateModelUsage,
  dispatchCount,
  rosterCount,
  dispatchCountsForPercentile,
  aggregateSubAgentModelAttribution,
  aggregateToolMix,
  classifyErrorMessage,
  classifyErrors,
  classifyEffort,
  orchestratorOutputTokens,
  summarizeEffortMix,
  computeEffortDrift,
  classifyImageSha,
  statGitDir,
  classifyHeadResolution,
  isPlausibleSha,
  resolveHeadSha,
  computeCommitsBehindHead,
} from '../../src/dashboard/stats.ts';
import type { PRFinding } from '../../src/agents/pr-reviewer/schema.ts';
import type { GitInvocation } from '../../src/dashboard/stats.ts';

// No test in this file may open a database connection — DATABASE_URL points at
// the live production database. Only pure shaping functions and source-text
// SQL-shape assertions are tested here.

// ---------------------------------------------------------------------------
// Window handling
// ---------------------------------------------------------------------------

describe('parseWindow', () => {
  test('accepts 7d', () => expect(parseWindow('7d')).toBe('7d'));
  test('accepts 90d', () => expect(parseWindow('90d')).toBe('90d'));
  test('accepts 30d explicitly', () => expect(parseWindow('30d')).toBe('30d'));
  test('null clamps to 30d (default)', () => expect(parseWindow(null)).toBe('30d'));
  test('undefined clamps to 30d (default)', () => expect(parseWindow(undefined)).toBe('30d'));
  test('empty string clamps to 30d', () => expect(parseWindow('')).toBe('30d'));
  test('garbage clamps to 30d, never passed through', () => expect(parseWindow('1;DROP TABLE pr_reviews')).toBe('30d'));
  test('a near-miss like "7days" clamps to 30d', () => expect(parseWindow('7days')).toBe('30d'));
});

describe('getWindowDays', () => {
  test('maps each window to its day count', () => {
    expect(getWindowDays('7d')).toBe(7);
    expect(getWindowDays('30d')).toBe(30);
    expect(getWindowDays('90d')).toBe(90);
  });
});

describe('buildWindowMeta', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');

  test('computes since as now - windowDays', () => {
    const meta = buildWindowMeta('7d', 50, now);
    expect(meta.since).toBe('2026-07-25T00:00:00.000Z');
    expect(meta.windowDays).toBe(7);
    expect(meta.window).toBe('7d');
  });

  test('flags lowSample below MIN_RELIABLE_SAMPLE', () => {
    expect(buildWindowMeta('7d', MIN_RELIABLE_SAMPLE - 1, now).lowSample).toBe(true);
  });

  test('does not flag lowSample at or above MIN_RELIABLE_SAMPLE', () => {
    expect(buildWindowMeta('7d', MIN_RELIABLE_SAMPLE, now).lowSample).toBe(false);
  });

  test('carries the exact sampleSize through', () => {
    expect(buildWindowMeta('30d', 337, now).sampleSize).toBe(337);
  });
});

// ---------------------------------------------------------------------------
// Population handling (Task 3) — keeps A/B and probe runs out of production
// statistics. Mirrors parseWindow's whitelist-clamp shape exactly: this is
// the only place user input touches population selection, and the resulting
// value is converted to a boolean (isTestFlag) before it reaches SQL, never
// interpolated as text.
// ---------------------------------------------------------------------------

describe('parsePopulation', () => {
  test('defaults to prod', () => {
    expect(parsePopulation(undefined)).toBe('prod');
    expect(parsePopulation(null)).toBe('prod');
    expect(parsePopulation('')).toBe('prod');
  });

  test('accepts test', () => {
    expect(parsePopulation('test')).toBe('test');
  });

  test('clamps anything else to prod, including injection attempts', () => {
    expect(parsePopulation("'; DROP TABLE pr_reviews; --")).toBe('prod');
    expect(parsePopulation('PROD')).toBe('prod'); // not case-insensitive — only the exact literal 'test' passes
  });
});

describe('isTestFlag', () => {
  test('true only for the test population', () => {
    expect(isTestFlag('test')).toBe(true);
    expect(isTestFlag('prod')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Findings / severity
// ---------------------------------------------------------------------------

function finding(severity: PRFinding['severity']): PRFinding {
  return { severity, title: 't', body: 'b' };
}

describe('readBandCount', () => {
  test('counts critical and major, excludes minor and nitpick', () => {
    const list = [finding('critical'), finding('major'), finding('minor'), finding('nitpick'), finding('major')];
    expect(readBandCount(list)).toBe(3);
  });

  test('null findings_list reads as 0 — not attempted, distinct from an empty array at the caller level', () => {
    expect(readBandCount(null)).toBe(0);
  });

  test('empty array is 0', () => {
    expect(readBandCount([])).toBe(0);
  });
});

describe('severityDistribution', () => {
  test('tallies every severity across all rows, including rows with none', () => {
    const rows: Array<PRFinding[] | null> = [
      [finding('critical'), finding('minor')],
      null,
      [finding('major'), finding('major'), finding('nitpick')],
    ];
    expect(severityDistribution(rows)).toEqual({ critical: 1, major: 2, minor: 1, nitpick: 1 });
  });

  test('all rows null yields all-zero distribution, not an empty object', () => {
    expect(severityDistribution([null, null])).toEqual({ critical: 0, major: 0, minor: 0, nitpick: 0 });
  });
});

describe('verdictDistribution', () => {
  test('groups by recommendation', () => {
    expect(verdictDistribution(['approve', 'approve', 'request changes'])).toEqual({
      approve: 2,
      'request changes': 1,
    });
  });

  test('null recommendation groups under the literal (none) key', () => {
    expect(verdictDistribution(['approve', null, null])).toEqual({ approve: 1, '(none)': 2 });
  });
});

describe('computeCostPerReadBandItem — mirrors the review-cost-review skill query', () => {
  test('divides AVERAGE cost by AVERAGE read-band count, not a per-row ratio', () => {
    // Row A: cost 1, 0 read-band items. Row B: cost 3, 2 read-band items.
    // avg cost = 2, avg read-band = 1 -> value = 2, NOT avg(1/0, 3/2) which would blow up on row A.
    const result = computeCostPerReadBandItem([
      { costUsd: 1, findingsList: [] },
      { costUsd: 3, findingsList: [finding('critical'), finding('major')] },
    ]);
    expect(result.avgCostUsd).toBe(2);
    expect(result.avgReadBandItems).toBe(1);
    expect(result.value).toBe(2);
    expect(result.sampleSize).toBe(2);
  });

  test('excludes rows missing cost_usd or findings_list from the eligible set', () => {
    const result = computeCostPerReadBandItem([
      { costUsd: null, findingsList: [finding('critical')] },
      { costUsd: 5, findingsList: null },
      { costUsd: 2, findingsList: [finding('critical')] },
    ]);
    expect(result.sampleSize).toBe(1);
    expect(result.avgCostUsd).toBe(2);
  });

  test('no eligible rows returns nulls, not NaN or a divide-by-zero', () => {
    const result = computeCostPerReadBandItem([{ costUsd: null, findingsList: null }]);
    expect(result).toEqual({ avgCostUsd: null, avgReadBandItems: null, value: null, sampleSize: 0 });
  });

  test('zero read-band items across every eligible row returns a null value, not Infinity', () => {
    const result = computeCostPerReadBandItem([
      { costUsd: 1, findingsList: [] },
      { costUsd: 2, findingsList: [finding('minor')] },
    ]);
    expect(result.value).toBeNull();
    expect(result.avgReadBandItems).toBe(0);
  });
});

describe('findingsCountMismatch', () => {
  test('true when findings_count disagrees with the array length', () => {
    expect(findingsCountMismatch(3, [finding('critical')])).toBe(true);
  });

  test('false when they agree', () => {
    expect(findingsCountMismatch(1, [finding('critical')])).toBe(false);
  });

  test('false (not comparable) when findings_count is null', () => {
    expect(findingsCountMismatch(null, [finding('critical')])).toBe(false);
  });

  test('false (not comparable) when findings_list is null', () => {
    expect(findingsCountMismatch(2, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cost / sub-agent apportionment
// ---------------------------------------------------------------------------

describe('sumApportionedSubAgentCost', () => {
  test('sums apportionedCostUsd across every named sub-agent', () => {
    const subAgents = {
      'al-performance-analyzer': { apportionedCostUsd: 0.3 },
      'security-reviewer': { apportionedCostUsd: 0.5 },
    };
    expect(sumApportionedSubAgentCost(subAgents)).toBeCloseTo(0.8);
  });

  test('null sub_agents sums to 0 (no dispatches recorded)', () => {
    expect(sumApportionedSubAgentCost(null)).toBe(0);
  });

  test('an entry missing apportionedCostUsd contributes 0, not NaN', () => {
    expect(sumApportionedSubAgentCost({ x: {} })).toBe(0);
  });
});

describe('computeSubAgentCoverage', () => {
  // Post-completion fix: team-lead smoke-tested getCostStats against live
  // production data and found sub_agents was only populated from 2026-07-26
  // onward (verified independently: 107 rows, all >= that date). Over a 30d
  // window, 227 of 334 rows had NO sub_agents object at all — not undercounted,
  // simply not captured yet — and every one of those dollars was silently
  // folded into orchestratorCostUsdMax. This describes that population.

  test('counts a row with at least one named sub-agent entry as covered', () => {
    const rows: Array<Record<string, unknown> | null> = [{ a: {} }, { b: {}, c: {} }];
    const result = computeSubAgentCoverage(rows);
    expect(result.rowsWithSubAgentData).toBe(2);
    expect(result.totalRows).toBe(2);
    expect(result.coveragePct).toBe(100);
  });

  test('null sub_agents counts as uncovered', () => {
    const rows: Array<Record<string, unknown> | null> = [{ a: {} }, null, null];
    const result = computeSubAgentCoverage(rows);
    expect(result.rowsWithSubAgentData).toBe(1);
    expect(result.totalRows).toBe(3);
    expect(result.coveragePct).toBeCloseTo(33.333, 2);
  });

  test('an empty object ({}) counts as uncovered, same as null — neither has an actual entry to apportion', () => {
    const rows: Array<Record<string, unknown> | null> = [{ a: {} }, {}];
    const result = computeSubAgentCoverage(rows);
    expect(result.rowsWithSubAgentData).toBe(1);
    expect(result.coveragePct).toBe(50);
  });

  test('reproduces the live-data reading that triggered this fix: 107/334 ≈ 32%, below the reliability bar', () => {
    const covered: Array<Record<string, unknown> | null> = Array.from({ length: 107 }, () => ({ x: {} }));
    const uncovered: Array<Record<string, unknown> | null> = Array.from({ length: 334 - 107 }, () => null);
    const result = computeSubAgentCoverage([...covered, ...uncovered]);
    expect(result.rowsWithSubAgentData).toBe(107);
    expect(result.totalRows).toBe(334);
    expect(result.coveragePct).toBeCloseTo(32.04, 1);
    expect(result.lowCoverage).toBe(true);
  });

  test('lowCoverage flips at the MIN_RELIABLE_COVERAGE_PCT threshold', () => {
    const atThreshold: Array<Record<string, unknown> | null> = [
      ...Array.from({ length: MIN_RELIABLE_COVERAGE_PCT }, () => ({ x: {} })),
      ...Array.from({ length: 100 - MIN_RELIABLE_COVERAGE_PCT }, () => null),
    ];
    expect(computeSubAgentCoverage(atThreshold).lowCoverage).toBe(false); // exactly at the bar, not below it
    const belowThreshold: Array<Record<string, unknown> | null> = [
      ...Array.from({ length: MIN_RELIABLE_COVERAGE_PCT - 1 }, () => ({ x: {} })),
      ...Array.from({ length: 101 - MIN_RELIABLE_COVERAGE_PCT }, () => null),
    ];
    expect(computeSubAgentCoverage(belowThreshold).lowCoverage).toBe(true);
  });

  test('empty input reports null coverage and lowCoverage: false — nothing to be unreliable about', () => {
    const result = computeSubAgentCoverage([]);
    expect(result).toEqual({ rowsWithSubAgentData: 0, totalRows: 0, coveragePct: null, lowCoverage: false });
  });
});

describe('aggregateModelUsage', () => {
  test('aggregates cost and output tokens per model across rows', () => {
    const rows: Array<Record<string, { costUsd: number; output: number }>> = [
      { 'claude-opus-5': { costUsd: 1, output: 100 }, 'claude-sonnet-5': { costUsd: 0.5, output: 50 } },
      { 'claude-opus-5': { costUsd: 2, output: 200 } },
    ];
    const result = aggregateModelUsage(rows);
    const opus = result.find((m) => m.model === 'claude-opus-5')!;
    expect(opus.totalCostUsd).toBe(3);
    expect(opus.totalOutputTokens).toBe(300);
    expect(opus.rows).toBe(2);
    const sonnet = result.find((m) => m.model === 'claude-sonnet-5')!;
    expect(sonnet.rows).toBe(1);
  });

  test('sorts by total cost descending', () => {
    const rows = [{ cheap: { costUsd: 0.1 }, expensive: { costUsd: 9 } }];
    const result = aggregateModelUsage(rows);
    expect(result.map((m) => m.model)).toEqual(['expensive', 'cheap']);
  });

  test('flags [1m] premium long-context variants', () => {
    const rows = [{ 'claude-opus-5[1m]': { costUsd: 1 }, 'claude-opus-5': { costUsd: 1 } }];
    const result = aggregateModelUsage(rows);
    expect(result.find((m) => m.model === 'claude-opus-5[1m]')!.flagged).toBe(true);
    expect(result.find((m) => m.model === 'claude-opus-5')!.flagged).toBe(false);
  });

  test('null rows are skipped, not thrown on', () => {
    expect(aggregateModelUsage([null, null])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch / roster mismatch
// ---------------------------------------------------------------------------

describe('dispatchCount', () => {
  test("reads tool_calls->'Agent'", () => {
    expect(dispatchCount({ Agent: 7, Bash: 3 })).toBe(7);
  });

  test('missing Agent key reads as 0', () => {
    expect(dispatchCount({ Bash: 3 })).toBe(0);
  });

  test('null tool_calls reads as 0', () => {
    expect(dispatchCount(null)).toBe(0);
  });
});

describe('rosterCount', () => {
  test('counts named sub-agent keys', () => {
    expect(rosterCount({ a: {}, b: {} })).toBe(2);
  });

  test('null sub_agents reads as 0', () => {
    expect(rosterCount(null)).toBe(0);
  });
});

describe('dispatchCountsForPercentile — defines the dispatch median/p90 population', () => {
  // Regression pin for the fix-round-1 finding: the SQL previously excluded
  // rows with no 'Agent' key from the percentile while `dispatch.sampleSize`
  // reported the full window, so the two numbers described different
  // populations. This function is now the single source of truth for that
  // population on the JS side, and the SQL is written to zero-fill with the
  // identical convention (pinned separately below in the SQL-shape block).
  test('zero-fills a row with no Agent key rather than excluding it', () => {
    const rows: Array<{ tool_calls: Record<string, number> | null }> = [
      { tool_calls: { Agent: 7 } },
      { tool_calls: { Bash: 2 } },
      { tool_calls: null },
    ];
    expect(dispatchCountsForPercentile(rows)).toEqual([7, 0, 0]);
  });

  test('its length always equals the input row count — the percentile population is the full window, never a filtered subset', () => {
    const rows = [{ tool_calls: null }, { tool_calls: null }, { tool_calls: { Agent: 3 } }, { tool_calls: null }, { tool_calls: null }];
    const result = dispatchCountsForPercentile(rows);
    expect(result.length).toBe(rows.length);
    // 4 of 5 rows have no Agent key — under the old "exclude" behaviour the
    // population would have been 1, not 5.
    expect(result.filter((n) => n === 0).length).toBe(4);
  });

  test('empty input is an empty population, not an error', () => {
    expect(dispatchCountsForPercentile([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-sub-agent model attribution — the observed side of contamination
// detection (fix round 1: the declared-vs-observed comparison itself lives
// client-side in stats-integrity.tsx, which has both this endpoint's
// windowed data and /api/config's declared pins in hand).
// ---------------------------------------------------------------------------

describe('aggregateSubAgentModelAttribution', () => {
  test('counts runs per agent per observed model, across rows', () => {
    const rows: Array<Record<string, { model?: string }> | null> = [
      { 'al-performance-analyzer': { model: 'claude-sonnet-5' } },
      { 'al-performance-analyzer': { model: 'claude-sonnet-5' } },
      { 'al-performance-analyzer': { model: 'claude-opus-5' } },
    ];
    const result = aggregateSubAgentModelAttribution(rows);
    expect(result).toEqual([
      { agent: 'al-performance-analyzer', model: 'claude-sonnet-5', count: 2 },
      { agent: 'al-performance-analyzer', model: 'claude-opus-5', count: 1 },
    ]);
  });

  test('a missing model field reads as null, never a fake model string', () => {
    const rows: Array<Record<string, { model?: string }> | null> = [{ 'general-purpose': {} }];
    expect(aggregateSubAgentModelAttribution(rows)).toEqual([{ agent: 'general-purpose', model: null, count: 1 }]);
  });

  test('null rows are skipped, not thrown on', () => {
    expect(aggregateSubAgentModelAttribution([null, null])).toEqual([]);
  });

  test('multiple agents are kept separate, sorted by agent name then count descending', () => {
    const rows: Array<Record<string, { model?: string }> | null> = [
      { 'code-quality-assessor': { model: 'claude-sonnet-5' } },
      { 'al-architecture-analyzer': { model: 'claude-opus-5' } },
      { 'al-architecture-analyzer': { model: 'claude-sonnet-5' } },
      { 'al-architecture-analyzer': { model: 'claude-sonnet-5' } },
    ];
    const result = aggregateSubAgentModelAttribution(rows);
    expect(result.map((e) => e.agent)).toEqual(['al-architecture-analyzer', 'al-architecture-analyzer', 'code-quality-assessor']);
    // Within al-architecture-analyzer, the more common model (sonnet, 2) sorts before the rarer one (opus, 1).
    expect(result[0]).toEqual({ agent: 'al-architecture-analyzer', model: 'claude-sonnet-5', count: 2 });
    expect(result[1]).toEqual({ agent: 'al-architecture-analyzer', model: 'claude-opus-5', count: 1 });
  });

  test('an empty sub_agents object contributes nothing (matches rosterCount treating {} as uncovered)', () => {
    expect(aggregateSubAgentModelAttribution([{}])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool mix
// ---------------------------------------------------------------------------

describe('aggregateToolMix', () => {
  test('averages per review over the TOTAL row count, not just rows carrying the key', () => {
    // LSP appears in only 1 of 4 reviews with a nonzero count.
    const rows: Array<Record<string, number>> = [{ LSP: 4 }, { Bash: 2 }, { Bash: 1 }, { Bash: 1 }];
    const result = aggregateToolMix(rows);
    const lsp = result.find((t) => t.tool === 'LSP')!;
    expect(lsp.totalCalls).toBe(4);
    expect(lsp.reviewsUsing).toBe(1);
    expect(lsp.avgPerReview).toBe(1); // 4 / 4 rows, not 4 / 1
  });

  test('sorts by total calls descending', () => {
    const rows = [{ Bash: 10, Read: 1 }];
    expect(aggregateToolMix(rows).map((t) => t.tool)).toEqual(['Bash', 'Read']);
  });

  test('null tool_calls rows count toward the denominator but contribute nothing', () => {
    const rows = [{ Bash: 4 }, null, null];
    const result = aggregateToolMix(rows);
    expect(result.find((t) => t.tool === 'Bash')!.avgPerReview).toBeCloseTo(4 / 3);
  });

  test('empty input returns an empty mix', () => {
    expect(aggregateToolMix([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error classification (Task 9, fix round 1) — pinned against the EXACT
// live production strings (queried read-only, not paraphrased), confirmed
// via `mcp__postgres__query` against a 90-day window before writing this.
// ---------------------------------------------------------------------------

describe('classifyErrorMessage', () => {
  test('rate-limit — matches the stable prefix, ignoring the varying reset-time suffix', () => {
    expect(classifyErrorMessage('Rate limit hit during "pr-reviewer": 11am (UTC)')).toBe('rate-limit');
    expect(classifyErrorMessage('Rate limit hit during "pr-reviewer": 11:50pm (UTC)')).toBe('rate-limit');
    // A different stage and a differently-shaped resetInfo still match — the
    // prefix, not the whole string, is what identifies this category.
    expect(classifyErrorMessage('Rate limit hit during "coder": reset unknown')).toBe('rate-limit');
  });

  test('no-result — the exact AgentExecutionError default-message shape', () => {
    expect(classifyErrorMessage('Agent "pr-reviewer" failed to produce a result')).toBe('no-result');
    expect(classifyErrorMessage('Agent "cherry-pick-reviewer" failed to produce a result')).toBe('no-result');
  });

  test('schema-validation — the exact AgentValidationError message shape', () => {
    expect(classifyErrorMessage('Agent "pr-reviewer" output failed schema validation')).toBe('schema-validation');
  });

  test('a TransientAgentError wrapping a recognisable inner message classifies by the INNER shape', () => {
    // The live production row, verbatim: TransientAgentError wrapping an
    // AgentExecutionError's own default message.
    expect(classifyErrorMessage('Agent "pr-reviewer" failed after 1 attempt(s): Agent "pr-reviewer" failed to produce a result'))
      .toBe('no-result');
  });

  test('a TransientAgentError wrapping an UNRECOGNISABLE inner message falls to other — never guessed as no-result', () => {
    // The wrapped lastError.message is unconstrained (could be a network
    // error, an auth timeout, anything) — this is the case the "never guess"
    // constraint exists for.
    expect(classifyErrorMessage('Agent "pr-reviewer" failed after 3 attempt(s): ECONNRESET')).toBe('other');
  });

  test('unrecognised text — including the live "Something went wrong" row — is other, not guessed', () => {
    expect(classifyErrorMessage('Something went wrong')).toBe('other');
  });

  test('an AgentExecutionError constructed with custom string details does not collide with the default-message shape', () => {
    // AgentExecutionError's constructor only produces the fixed
    // "failed to produce a result" text when `details` is NOT a string —
    // a string `details` becomes the message verbatim (errors.ts). That
    // custom text has no guaranteed shape, so it must fall to `other`.
    expect(classifyErrorMessage('Agent "pr-reviewer" hit an unexpected exception: boom')).toBe('other');
  });
});

describe('classifyErrors', () => {
  test('the exact live 90-day production distribution classifies to the reported 21/31 rate-limit share', () => {
    const messages = [
      ...Array(17).fill('Rate limit hit during "pr-reviewer": 11am (UTC)'),
      ...Array(4).fill('Rate limit hit during "pr-reviewer": 11:50pm (UTC)'),
      ...Array(4).fill('Agent "pr-reviewer" failed after 1 attempt(s): Agent "pr-reviewer" failed to produce a result'),
      ...Array(2).fill('Agent "pr-reviewer" output failed schema validation'),
      ...Array(2).fill('Agent "pr-reviewer" failed to produce a result'),
      'Something went wrong',
      'Agent "cherry-pick-reviewer" failed to produce a result',
    ];
    const summary = classifyErrors(messages);
    expect(summary.total).toBe(31);
    expect(summary.categories['rate-limit']).toBe(21);
    expect(summary.categories['no-result']).toBe(7); // 4 wrapped + 2 + 1 (cherry-pick-reviewer)
    expect(summary.categories['schema-validation']).toBe(2);
    expect(summary.categories['other']).toBe(1); // "Something went wrong"
    expect(summary.categories['rate-limit'] / summary.total).toBeCloseTo(21 / 31, 5);
  });

  test('the empty-window case — zero errors is a real, measured reading, not an omission', () => {
    const summary = classifyErrors([]);
    expect(summary.total).toBe(0);
    expect(summary.categories).toEqual({ 'rate-limit': 0, 'no-result': 0, 'schema-validation': 0, other: 0 });
    expect(summary.exemplars).toEqual({});
  });

  test('exemplars are truncated, never the full raw string, and only set for categories actually observed', () => {
    const longMessage = `Agent "pr-reviewer" hit an unexpected exception: ${'x'.repeat(200)}`;
    const summary = classifyErrors([longMessage]);
    expect(summary.exemplars.other).toBeDefined();
    expect(summary.exemplars.other!.length).toBeLessThan(longMessage.length);
    expect(summary.exemplars.other).not.toBe(longMessage);
    expect(summary.exemplars['rate-limit']).toBeUndefined();
  });

  test('the exemplar is the FIRST message per category in the given (caller-ordered, newest-first) array', () => {
    const summary = classifyErrors([
      'Rate limit hit during "pr-reviewer": 11:50pm (UTC)',
      'Rate limit hit during "pr-reviewer": 11am (UTC)',
    ]);
    expect(summary.exemplars['rate-limit']).toBe('Rate limit hit during "pr-reviewer": 11:50pm (UTC)');
  });
});

// ---------------------------------------------------------------------------
// Inferred effort
// ---------------------------------------------------------------------------

describe('classifyEffort', () => {
  test('classifies within the high band', () => {
    expect(classifyEffort(50_000)).toBe('high');
    expect(classifyEffort(43_000)).toBe('high');
    expect(classifyEffort(56_000)).toBe('high');
  });

  test('classifies within the low band', () => {
    expect(classifyEffort(24_000)).toBe('low');
    expect(classifyEffort(21_000)).toBe('low');
    expect(classifyEffort(27_000)).toBe('low');
  });

  test('classifies outside both bands as other, never forced to the nearer one', () => {
    expect(classifyEffort(35_000)).toBe('other');
    expect(classifyEffort(1_000)).toBe('other');
    expect(classifyEffort(100_000)).toBe('other');
  });

  test('null is unknown, distinct from other', () => {
    expect(classifyEffort(null)).toBe('unknown');
  });
});

describe('orchestratorOutputTokens', () => {
  test('subtracts measured sub-agent output from the model_usage total', () => {
    const modelUsage = { 'claude-opus-5': { output: 44_489 }, 'claude-sonnet-5': { output: 56_742 } };
    const subAgents = { a: { tokens: { output: 11 } } };
    // total output 44489 + 56742 = 101231; minus sub-agent 11 = 101220
    expect(orchestratorOutputTokens(modelUsage, subAgents)).toBe(101_220);
  });

  test('null model_usage returns null (nothing recorded)', () => {
    expect(orchestratorOutputTokens(null, null)).toBeNull();
  });

  test('null sub_agents subtracts nothing', () => {
    expect(orchestratorOutputTokens({ a: { output: 100 } }, null)).toBe(100);
  });

  test('clamps at 0 rather than going negative', () => {
    // Pathological: sub-agent tokens exceed the model_usage total (undercount cutting the other way).
    expect(orchestratorOutputTokens({ a: { output: 10 } }, { b: { tokens: { output: 50 } } })).toBe(0);
  });
});

describe('summarizeEffortMix', () => {
  test('tallies each band', () => {
    expect(summarizeEffortMix(['high', 'high', 'low', 'other', 'unknown'])).toEqual({
      high: 2,
      low: 1,
      other: 1,
      unknown: 1,
    });
  });

  test('empty input is an all-zero mix', () => {
    expect(summarizeEffortMix([])).toEqual({ high: 0, low: 0, other: 0, unknown: 0 });
  });
});

describe('computeEffortDrift', () => {
  test('splits at the time-sorted midpoint and mixes each half independently', () => {
    const entries = [
      { createdAt: '2026-07-01T00:00:00Z', outputTokens: 50_000 }, // high
      { createdAt: '2026-07-02T00:00:00Z', outputTokens: 50_000 }, // high
      { createdAt: '2026-07-03T00:00:00Z', outputTokens: 24_000 }, // low
      { createdAt: '2026-07-04T00:00:00Z', outputTokens: 24_000 }, // low
    ];
    const drift = computeEffortDrift(entries);
    expect(drift.overall).toEqual({ high: 2, low: 2, other: 0, unknown: 0 });
    expect(drift.earlierHalf).toEqual({ high: 2, low: 0, other: 0, unknown: 0 });
    expect(drift.laterHalf).toEqual({ high: 0, low: 2, other: 0, unknown: 0 });
  });

  test('sorts out-of-order input by createdAt before splitting', () => {
    const entries = [
      { createdAt: '2026-07-04T00:00:00Z', outputTokens: 24_000 },
      { createdAt: '2026-07-01T00:00:00Z', outputTokens: 50_000 },
    ];
    const drift = computeEffortDrift(entries);
    expect(drift.earlierHalf).toEqual({ high: 1, low: 0, other: 0, unknown: 0 });
    expect(drift.laterHalf).toEqual({ high: 0, low: 1, other: 0, unknown: 0 });
  });

  test('empty input returns all-zero mixes throughout', () => {
    const drift = computeEffortDrift([]);
    expect(drift.overall).toEqual({ high: 0, low: 0, other: 0, unknown: 0 });
    expect(drift.earlierHalf).toEqual({ high: 0, low: 0, other: 0, unknown: 0 });
    expect(drift.laterHalf).toEqual({ high: 0, low: 0, other: 0, unknown: 0 });
  });
});

// ---------------------------------------------------------------------------
// Build provenance (image_sha)
// ---------------------------------------------------------------------------

describe('classifyImageSha', () => {
  test('a real sha classifies as sha', () => expect(classifyImageSha('8129ee0')).toBe('sha'));
  test('the literal string "unknown" classifies distinctly', () => expect(classifyImageSha('unknown')).toBe('unknown'));
  test('an empty string classifies distinctly', () => expect(classifyImageSha('')).toBe('empty'));
  test('null classifies as not-recorded — every row today', () => expect(classifyImageSha(null)).toBe('not-recorded'));
});

// ---------------------------------------------------------------------------
// HEAD resolution — the ribbon's centrepiece. `classifyHeadResolution` and
// `isPlausibleSha` are pure and covered with fixture inputs; `statGitDir`,
// `resolveHeadSha`, and `computeCommitsBehindHead` actually touch the
// filesystem/spawn git, so they are exercised against REAL temporary git
// repos (mirroring tests/sdk/git-checkout.test.ts's approach) — no DB
// connection anywhere in this block, no mock.module().
// ---------------------------------------------------------------------------

describe('statGitDir', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'stats-gitdir-test-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a real directory classifies as directory', () => {
    expect(statGitDir(dir)).toBe('directory');
  });

  test('a path that is a file (the worktree .git shape) classifies as file', () => {
    const filePath = join(dir, 'dot-git-as-file');
    writeFileSync(filePath, 'gitdir: /elsewhere/.git\n');
    expect(statGitDir(filePath)).toBe('file');
  });

  test('a path that does not exist classifies as missing', () => {
    expect(statGitDir(join(dir, 'does-not-exist'))).toBe('missing');
  });
});

describe('classifyHeadResolution', () => {
  test('missing git-dir -> not-mounted, regardless of any result', () => {
    expect(classifyHeadResolution('missing', null)).toEqual({ value: null, reason: 'not-mounted' });
  });

  test('git-dir is a file (worktree shape) -> not-a-directory', () => {
    expect(classifyHeadResolution('file', null)).toEqual({ value: null, reason: 'not-a-directory' });
  });

  test('directory but no result (should not happen, defensive) -> timeout', () => {
    expect(classifyHeadResolution('directory', null)).toEqual({ value: null, reason: 'timeout' });
  });

  test('directory + timed-out invocation -> timeout, regardless of code', () => {
    const result: GitInvocation = { code: 0, stdout: 'deadbeef', timedOut: true };
    expect(classifyHeadResolution('directory', result)).toEqual({ value: null, reason: 'timeout' });
  });

  test('directory + non-zero exit -> command-failed', () => {
    const result: GitInvocation = { code: 128, stdout: '', timedOut: false };
    expect(classifyHeadResolution('directory', result)).toEqual({ value: null, reason: 'command-failed' });
  });

  test('directory + success but blank stdout -> empty-output', () => {
    const result: GitInvocation = { code: 0, stdout: '   \n', timedOut: false };
    expect(classifyHeadResolution('directory', result)).toEqual({ value: null, reason: 'empty-output' });
  });

  test('directory + success with a real sha -> the trimmed sha, no reason', () => {
    const result: GitInvocation = { code: 0, stdout: '8129ee0\n', timedOut: false };
    expect(classifyHeadResolution('directory', result)).toEqual({ value: '8129ee0', reason: null });
  });
});

describe('isPlausibleSha', () => {
  test('a short hex sha passes', () => expect(isPlausibleSha('8129ee0')).toBe(true));
  test('a full 40-char hex sha passes', () => expect(isPlausibleSha('a'.repeat(40))).toBe(true));
  test('the literal "unknown" fails', () => expect(isPlausibleSha('unknown')).toBe(false));
  test('an empty string fails', () => expect(isPlausibleSha('')).toBe(false));
  test('a value starting with "-" fails (argument-injection guard)', () => expect(isPlausibleSha('--upload-pack=x')).toBe(false));
  test('non-hex characters fail', () => expect(isPlausibleSha('not-a-sha!')).toBe(false));
  test('a 3-char string fails the minimum length', () => expect(isPlausibleSha('abc')).toBe(false));
  test('a 41-char string fails the maximum length', () => expect(isPlausibleSha('a'.repeat(41))).toBe(false));
});

describe('resolveHeadSha (behavioral, real temp git repos)', () => {
  let repoDir: string;
  let gitDir: string;
  let plainDir: string; // exists, is a directory, but is NOT a git repository

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'stats-head-repo-'));
    gitDir = join(repoDir, '.git');
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
      await p.exited;
    };
    await run('init', '-b', 'main');
    await run('config', 'user.email', 't@t');
    await run('config', 'user.name', 't');
    writeFileSync(join(repoDir, 'a.txt'), 'one\n');
    await run('add', '.');
    await run('commit', '-m', 'one');

    plainDir = mkdtempSync(join(tmpdir(), 'stats-head-plain-'));
  });
  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  test('a real mounted repo resolves a real short sha', async () => {
    const result = await resolveHeadSha(gitDir, 2_000);
    expect(result.reason).toBeNull();
    expect(result.value).not.toBeNull();
    expect(isPlausibleSha(result.value!)).toBe(true);
  });

  test('a missing mount resolves not-mounted', async () => {
    const result = await resolveHeadSha(join(repoDir, 'does-not-exist', '.git'), 2_000);
    expect(result).toEqual({ value: null, reason: 'not-mounted' });
  });

  test('a .git that is a file (worktree shape) resolves not-a-directory', async () => {
    const fileGitDir = join(repoDir, 'file-as-gitdir');
    writeFileSync(fileGitDir, 'gitdir: /elsewhere\n');
    const result = await resolveHeadSha(fileGitDir, 2_000);
    expect(result).toEqual({ value: null, reason: 'not-a-directory' });
  });

  test('a real directory that is not a git repository resolves command-failed', async () => {
    const result = await resolveHeadSha(plainDir, 2_000);
    expect(result).toEqual({ value: null, reason: 'command-failed' });
  });
});

describe('computeCommitsBehindHead (behavioral, real temp git repos)', () => {
  let repoDir: string;
  let gitDir: string;
  let firstCommitSha = '';

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'stats-distance-repo-'));
    gitDir = join(repoDir, '.git');
    const run = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
      await p.exited;
    };
    const runCapture = async (...args: string[]) => {
      const p = Bun.spawn(['git', ...args], { cwd: repoDir, stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out.trim();
    };
    await run('init', '-b', 'main');
    await run('config', 'user.email', 't@t');
    await run('config', 'user.name', 't');
    writeFileSync(join(repoDir, 'a.txt'), 'one\n');
    await run('add', '.');
    await run('commit', '-m', 'one');
    firstCommitSha = await runCapture('rev-parse', 'HEAD');
    writeFileSync(join(repoDir, 'a.txt'), 'two\n');
    await run('commit', '-am', 'two');
    writeFileSync(join(repoDir, 'a.txt'), 'three\n');
    await run('commit', '-am', 'three');
  });
  afterAll(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('a sha 2 commits behind HEAD reports 2', async () => {
    expect(await computeCommitsBehindHead(firstCommitSha, gitDir, 2_000)).toBe(2);
  });

  test('HEAD itself is 0 commits behind HEAD (in sync)', async () => {
    const head = await resolveHeadSha(gitDir, 2_000);
    expect(await computeCommitsBehindHead(head.value!, gitDir, 2_000)).toBe(0);
  });

  test('a plausible-looking sha absent from history returns null, never 0', async () => {
    expect(await computeCommitsBehindHead('deadbeef', gitDir, 2_000)).toBeNull();
  });

  test('a value failing isPlausibleSha never reaches git — returns null immediately', async () => {
    expect(await computeCommitsBehindHead('unknown', gitDir, 2_000)).toBeNull();
    expect(await computeCommitsBehindHead('', gitDir, 2_000)).toBeNull();
    expect(await computeCommitsBehindHead('--upload-pack=x', gitDir, 2_000)).toBeNull();
  });

  test('an unmounted git-dir returns null, not 0', async () => {
    expect(await computeCommitsBehindHead(firstCommitSha, join(repoDir, 'nope', '.git'), 2_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQL shape — source-text assertions (no DB connection; mirrors
// tests/db/pg-pr-review-store-mapper.test.ts's approach for the same reason:
// DATABASE_URL is the live production database, so nothing here may execute
// a query, but a hand-maintained SQL string can still drift silently).
// ---------------------------------------------------------------------------

describe('stats.ts SQL shape', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/dashboard/stats.ts', import.meta.url)), 'utf-8');

  test('never calls sql.unsafe — every query is a parameterised tagged template', () => {
    expect(src).not.toContain('.unsafe(');
  });

  test('every window cutoff is parameterised through ${days}::int, never through the raw window string', () => {
    const cutoffs = src.match(/now\(\) - \([^)]*\)/g) ?? [];
    expect(cutoffs.length).toBeGreaterThan(0);
    for (const cutoff of cutoffs) {
      expect(cutoff).toContain('${days}::int');
    }
  });

  test('the raw ?window= string is never interpolated into a SQL template — only the numeric ${days} is', () => {
    // Every `sql`...`` tagged template in the file (SQL text itself never contains a
    // backtick, so a non-greedy match between backticks — including an optional leading
    // generic clause — reliably isolates each template body). `window` (the StatsWindow
    // string) is only ever passed to getWindowDays() to become the numeric `days` used
    // above; this pins that no call site skips that conversion.
    const sqlTemplates = src.match(/\bsql(?:<[^`]*>)?`[^`]*`/g) ?? [];
    expect(sqlTemplates.length).toBeGreaterThan(0);
    for (const template of sqlTemplates) {
      expect(template).not.toContain('${window}');
    }
  });

  test('uses percentile_cont for every median/p90 statistic (cost, duration, turns, dispatch)', () => {
    const occurrences = (src.match(/percentile_cont/g) ?? []).length;
    // cost (median+p90) + cost-per-repo (median) + duration (median+p90) +
    // turns (median+p90) + duration/turns per-repo (2) + dispatch (median+p90) = 10
    expect(occurrences).toBeGreaterThanOrEqual(10);
  });

  test('getCostStats groups per-repo cost by repo_key', () => {
    const fn = src.match(/export async function getCostStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('GROUP BY repo_key');
  });

  test('getIntegrityStats reads dispatch count from tool_calls, never from sub_agents alone', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain(`tool_calls->>'Agent'`);
  });

  // Fix-round-1 regression pin: the dispatch-percentile query previously
  // filtered `WHERE tool_calls ? 'Agent'`, excluding zero-dispatch rows from
  // the percentile while `dispatch.sampleSize` reported the full window —
  // two fields silently describing different populations. A source-text test
  // cannot verify two DECLARED NUMBERS agree at runtime, but it CAN verify the
  // two queries share byte-identical WHERE clauses, which structurally
  // guarantees they run over the same rows (the behavioral half of this pin —
  // that the zero-fill convention itself is correct — lives in the
  // `dispatchCountsForPercentile` describe block above, DB-free).
  test('the dispatch-percentile query shares the exact WHERE clause with the main rows fetch — same population by construction', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const whereClauses = [...fn![0].matchAll(/WHERE\s+created_at[^\n]*/g)].map((m) => m[0].trim());
    // The rows fetch and the dispatch-percentile query are the only two SQL
    // blocks in this function; both must filter on the window and nothing else.
    expect(whereClauses.length).toBe(2);
    expect(new Set(whereClauses).size).toBe(1);
  });

  test('the dispatch-percentile query zero-fills a missing Agent key instead of excluding the row', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("COALESCE((tool_calls->>'Agent')::numeric, 0)");
    expect(fn![0]).not.toMatch(/tool_calls\s*\?\s*'Agent'/);
  });

  test('dispatch.dispatchSampleSize is reported alongside sampleSize, mirroring costSampleSize on /api/stats/cost', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/dispatchSampleSize:\s*dispatchCounts\.length/);
  });

  // Fix round 1 (task-6): the endpoint previously discarded sub_agents[*].model
  // entirely — modelUsage only ever saw model_usage (keyed by model id, not by
  // sub-agent). This wires the OBSERVED half of contamination detection into
  // the payload; the declared-pin half is cross-referenced client-side.
  test('getIntegrityStats wires subAgentModelAttribution from the same sub_agents column, and states the undercount direction', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/aggregateSubAgentModelAttribution\(rows\.map\(\(r\) => r\.sub_agents\)\)/);
    expect(body).toMatch(/subAgentModelAttribution:\s*\{/);
    // The undercount must be stated as a WORSE-not-better direction, not a
    // vague "may be incomplete" — matching the fix round's explicit ask.
    expect(body).toContain('WORSE than these counts show, never better');
  });

  // Fix-round-1 regression pin: the cost split previously exposed a plain
  // `orchestratorCostUsd`/`subAgentCostUsd` pair with the bound direction
  // stated only in prose. A renderer reading the payload had two numbers that
  // look equally exact. The Max/Min suffixes are themselves the fix — a chart
  // can key off the field name without parsing `note`.
  test('the cost split exposes explicit bound field names, not an unlabeled pair', () => {
    const fn = src.match(/export async function getCostStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain('orchestratorCostUsdMax');
    expect(body).toContain('subAgentCostUsdMin');
    expect(body).toContain('orchestratorSharePctMax');
    // The old unlabeled field names must not resurface as if they were exact.
    expect(body).not.toMatch(/orchestratorCostUsd:/);
    expect(body).not.toMatch(/subAgentCostUsd:/);
    expect(body).not.toMatch(/orchestratorSharePct:/);
  });

  // Post-completion fix: the split's bias has two distinct causes (roster
  // undercount, already covered above, and instrumentation coverage — the
  // sub_agents column not existing yet for most of a window's history). The
  // note must name both so a reader doesn't conflate them, and the coverage
  // field must actually be wired into the returned object, not just declared
  // on the type.
  test('the cost split reports sub-agent coverage and names it as a second, distinct bias cause', () => {
    const fn = src.match(/export async function getCostStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/coverage:\s*computeSubAgentCoverage\(/);
    expect(body.toLowerCase()).toContain('instrumentation coverage');
    expect(body.toLowerCase()).toContain('second, distinct cause');
  });

  test('getDriftStats excludes non-sha sentinel values when finding the most recent real sha', () => {
    const fn = src.match(/export async function getDriftStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("image_sha <> ''");
    expect(fn![0]).toContain("image_sha <> 'unknown'");
  });

  // Historical invariant (this test used to assert the OPPOSITE): HEAD used
  // to be a hardcoded `{value: null, reason: 'not-observable-in-container'}`
  // literal. Decision (Task 5, ruling from the human partner): the
  // watcher/dashboard ARE compose services, so a ribbon that cannot observe
  // HEAD cannot detect compose drifting from source at all — the exact
  // 2026-08-01 failure. HEAD is now resolved LIVE from a read-only
  // `.git` bind mount (see docker-compose.yml). `getDriftStats` itself must
  // not shell out directly, though — it delegates to `resolveHeadSha`/
  // `computeCommitsBehindHead`, which are independently tested above against
  // real temporary git repos.
  test('getDriftStats resolves HEAD live via resolveHeadSha(), not a hardcoded literal', () => {
    const fn = src.match(/export async function getDriftStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('resolveHeadSha()');
    expect(fn![0]).not.toContain("not-observable-in-container");
  });

  test('getDriftStats delegates the actual git invocation rather than shelling out inline', () => {
    const fn = src.match(/export async function getDriftStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    // The function orchestrates SQL + the two git-touching helpers; it must
    // not itself call Bun.spawn/statSync — that would duplicate (and could
    // silently diverge from) the timeout/error handling already pinned on
    // resolveHeadSha/computeCommitsBehindHead above.
    expect(fn![0]).not.toMatch(/Bun\.spawn|statSync\(/);
    expect(fn![0]).toContain('computeCommitsBehindHead(');
  });

  test('getDriftStats only computes commitsBehindHead once HEAD itself resolved', () => {
    const fn = src.match(/export async function getDriftStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    // Guards against ever reporting a distance anchored to nothing — see
    // computeCommitsBehindHead's own doc comment on why null (never 0) is
    // the only safe default.
    expect(fn![0]).toMatch(/if\s*\(head\.value\)\s*\{/);
  });

  // Task 9, fix round 1: error classification was added after the endpoint's
  // initial ship, once production data showed the `error` column classifies
  // cleanly (see the classifyErrorMessage/classifyErrors describe blocks
  // above for the behavioural half). This pins the SQL side: the same
  // `error IS NOT NULL` population `errorRate` counts elsewhere, and that
  // the endpoint actually wires the real classifier rather than a stub.
  test('getOperationalStats classifies every non-null error in the window, wired to the real classifier', () => {
    const fn = src.match(/export async function getOperationalStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain('AND error IS NOT NULL');
    expect(body).toMatch(/errorClassification:\s*classifyErrors\(errorRows\.map\(\(r\) => r\.error\)\)/);
  });

  // Fix-round: duration.sampleSize and turns.sampleSize both reported
  // `durationTurns.n` — count(*) over the WHOLE window — beside a median
  // that `percentile_cont` silently computes with nulls skipped. A live
  // window holds a handful of rows with a null duration_ms/turns (errored
  // before either field was written), so the two sample sizes described a
  // larger population than their own statistic was computed over. Mirrors
  // costSampleSize on /api/stats/cost, which already carries its own
  // `IS NOT NULL` count rather than the whole window's count(*).
  test('duration and turns sample sizes come from non-null counts, not count(*) over the whole window', () => {
    const fn = src.match(/export async function getOperationalStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain('count(*) FILTER (WHERE duration_ms IS NOT NULL)');
    expect(body).toContain('count(*) FILTER (WHERE turns IS NOT NULL)');
    expect(body).not.toMatch(/sampleSize:\s*Number\(durationTurns\?\.n\s*\?\?\s*0\)/);
    // Pin each sampleSize to ITS OWN count, not just that both FILTER texts
    // exist somewhere in the function. Without this, swapping the two
    // fields onto the wrong sampleSize (duration reading turns_n or vice
    // versa) still satisfies every assertion above — today's data happens
    // to have equal null counts on both columns, so that bug would be
    // invisible in the payload too. This is the exact defect class the task
    // exists to remove.
    expect(body).toContain('sampleSize: Number(durationTurns?.duration_n ?? 0)');
    expect(body).toContain('sampleSize: Number(durationTurns?.turns_n ?? 0)');
  });

  // -------------------------------------------------------------------------
  // Task 3 — population predicate. getDriftStats (and the plain, unfiltered
  // countInWindow() helper it alone still calls — see that helper's own doc
  // comment) are explicitly exempt: drift is a fact about images, not about
  // who ran the review, so it has no test population. Both are cut out of the
  // scanned text BY NAME below, so this guard cannot be satisfied by is_test
  // text that happens to sit somewhere else in the file — it only counts
  // queries that are actually reachable from the four population-aware
  // endpoints.
  //
  // Task 2 shipped a file-wide `occurrences` COUNT for its own is_test guard;
  // the team-lead's post-mortem on that task flagged it as a blind spot: two
  // guards landing on the wrong statements would still count correctly and
  // pass. With ~12 queries here (vs. Task 2's 2), that blind spot is no
  // longer tolerable — this asserts PER QUERY, and names the offender.
  // -------------------------------------------------------------------------
  test('every pr_reviews query in the population-aware endpoints filters on is_test', () => {
    const withoutDrift = src.replace(/export async function getDriftStats[\s\S]*?\r?\n\}\r?\n/, '');
    const withoutCountInWindow = withoutDrift.replace(/async function countInWindow\(sql[\s\S]*?\r?\n\}\r?\n/, '');
    // Sanity: both exemptions must actually have been found and cut, or this
    // test would silently pass over the whole file (including the exempt
    // functions) and prove nothing.
    expect(withoutDrift.length).toBeLessThan(src.length);
    expect(withoutCountInWindow.length).toBeLessThan(withoutDrift.length);

    const queries = withoutCountInWindow.match(/FROM pr_reviews[\s\S]*?(?=`)/g) ?? [];
    // 3 (cost: percentiles/rows/repoRows) + 1 (quality: rows) + 2 (integrity:
    // rows/dispatchPercentiles) + 5 (operational: durationTurns/dailyRows/
    // toolRows/repoRows/errorRows) + 1 (countInWindowForPopulation, the
    // shared totalN/otherPopulationCount helper) = 12.
    expect(queries.length).toBe(12);
    const missing = queries.filter((q) => !q.includes('is_test'));
    expect(missing).toEqual([]); // a non-empty array here names the unguarded query verbatim
  });

  // Names the exact failure this task exists to prevent: the dispatch
  // percentile sub-query silently filtering a different population than the
  // main rows fetch it is supposed to describe (see the previous plan's
  // Task 2 postmortem). A file-wide "is_test appears somewhere" check cannot
  // catch this — it demands BOTH queries carry the SAME, non-negated
  // `testFlag`, and fails if either one drifts to `!testFlag` (reserved for
  // the opposite-population count) or drops the predicate entirely.
  test('getIntegrityStats: the dispatch-percentile query and the main rows fetch filter on the identical, non-negated testFlag', () => {
    const fn = src.match(/export async function getIntegrityStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    const queries = fn![0].match(/FROM pr_reviews[\s\S]*?(?=`)/g) ?? [];
    expect(queries.length).toBe(2);
    for (const q of queries) {
      expect(q).toContain('is_test = ${testFlag}');
      expect(q).not.toContain('is_test = ${!testFlag}');
    }
  });

  test.each(['getCostStats', 'getQualityStats', 'getIntegrityStats', 'getOperationalStats'])(
    '%s returns population and otherPopulationCount, computed via isTestFlag(population)',
    (fnName) => {
      const fn = src.match(new RegExp(`export async function ${fnName}[\\s\\S]*?\\n\\}`));
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toContain('isTestFlag(population)');
      expect(body).toMatch(/\bpopulation,/);
      expect(body).toMatch(/\botherPopulationCount,/);
    },
  );

  test('getDriftStats and buildConfigReport stay untouched by the population parameter', () => {
    const fn = src.match(/export async function getDriftStats[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).not.toContain('population');
    expect(fn![0]).not.toContain('is_test');
  });
});
