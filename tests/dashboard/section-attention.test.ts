import { describe, test, expect } from 'bun:test';
import { sectionAttentionCount } from '../../src/dashboard/client/assessors.ts';
import type { PanelSectionStatuses } from '../../src/dashboard/client/assessors.ts';
import {
  integritySectionStatuses,
  contaminationDisplayStatus,
} from '../../src/dashboard/client/components/stats-integrity.tsx';
import { operationalSectionStatuses } from '../../src/dashboard/client/components/stats-operational.tsx';
import {
  costSectionStatuses,
  qualitySectionStatuses,
  readBandSectionStatus,
} from '../../src/dashboard/client/components/stats-costquality.tsx';
import { reviewValueSectionStatuses } from '../../src/dashboard/client/components/stats-review-value.tsx';
import {
  configSectionStatuses,
  builderComparisonSectionStatus,
  evalLeversSectionStatus,
} from '../../src/dashboard/client/components/stats-config.tsx';
import { attentionBySection } from '../../src/dashboard/client/components/stats-view.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type {
  IntegrityStats, OperationalStats, CostStats, QualityStats, ReviewValueStats, EffortMix,
} from '../../src/dashboard/stats.ts';
import type { ConfigReport, LeverStatus } from '../../src/dashboard/config-report.ts';

// ---------------------------------------------------------------------------
// Attention routing for the section switcher — the structural fold that
// replaced the hand-picked two-assessor badge. These tests pin the property
// the critique demanded: every attention status a panel renders reaches its
// section's badge, the badge never claims a status no panel draws, and an
// unsettled fetch yields no badge rather than a count that could grow.
//
// No test here opens a database connection or renders a component tree
// (repo convention) — every function under test is pure.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixtures — matching the real response shapes so these tests break if the
// shapes drift. The integrity/config pair mirrors stats-integrity.test.ts's
// fixtures; the narrower panels use minimal casts carrying exactly the
// fields their statuses functions read, following assessors.test.ts.
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

function configFixture(overrides: { agree?: boolean; evalLevers?: LeverStatus[] } = {}): ConfigReport {
  return {
    generatedAt: '2026-08-01T00:00:00.000Z',
    orchestratorModel: {
      loadConfig: { raw: undefined, fromSettings: undefined, model: 'claude-opus-5', effort: { raw: undefined, parsed: undefined, effective: '(SDK default: high)' }, usedBy: [] },
      buildConfigFromRepo: { raw: undefined, fromSettings: undefined, model: overrides.agree === false ? 'claude-sonnet-5' : 'claude-opus-5', effort: { raw: undefined, parsed: undefined, effective: '(SDK default: high)' }, usedBy: [] },
      agree: overrides.agree ?? true,
      note: '',
    },
    perAgent: [],
    ruleLearnerAgent: { name: 'rule-learner', model: 'x', maxTurns: 1, disallowedTools: [], note: '' },
    subAgents: { groups: [], inline: [], totalFrontmatterFiles: 0 },
    credential: { prReview: { envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: false, length: null, mode: 'oauth-subscription' } },
    evalLevers: overrides.evalLevers ?? [],
    overlay: { agentOverrideCount: 0, agents: {} },
    settingsApplied: {},
  } as unknown as ConfigReport;
}

const activeLever: LeverStatus = {
  key: 'PR_REVIEW_NO_POST', raw: '1', state: 'active', description: 'Suppresses posting',
} as unknown as LeverStatus;

function operationalFixture(overrides: Partial<OperationalStats> = {}): OperationalStats {
  return {
    toolMix: [{ tool: 'Read', totalCalls: 40, avgPerReview: 2, reviewsUsing: 18 }],
    errorClassification: {
      total: 0,
      categories: { 'rate-limit': 0, 'no-result': 0, 'schema-validation': 0, other: 0 },
      exemplars: {},
    },
    ...overrides,
  } as unknown as OperationalStats;
}

const rateLimitedClassification = {
  total: 2,
  categories: { 'rate-limit': 2, 'no-result': 0, 'schema-validation': 0, other: 0 },
  exemplars: { 'rate-limit': 'Rate limit reached' },
} as OperationalStats['errorClassification'];

function costFixture(flagged: boolean): CostStats {
  return {
    modelBreakdown: flagged
      ? [{ model: 'claude-opus-5[1m]', rows: 1, totalCostUsd: 3.75, totalOutputTokens: 500, flagged: true }]
      : [{ model: 'claude-opus-5', rows: 10, totalCostUsd: 5, totalOutputTokens: 900, flagged: false }],
  } as unknown as CostStats;
}

function qualityFixture(avgReadBandItems: number | null): QualityStats {
  return {
    avgReadBandItems,
    readBandSampleSize: 76,
    sampleSize: 334,
    lowSample: false,
  } as unknown as QualityStats;
}

/** `reviewValueSectionStatuses` reads no data fields by design (see its doc
 *  comment) — the fixture still carries the unsettled-spend shape so the
 *  translation test names the exact case it pins. */
function reviewValueFixture(): ReviewValueStats {
  return {
    outcome: { spend: { numeratorState: 'floor', denominatorState: 'will-grow' } },
  } as unknown as ReviewValueStats;
}

const loading = { status: 'loading' } as const;
const errored = { status: 'error', message: 'boom' } as const;
const empty = { status: 'empty' } as const;
function ready<T>(data: T): FetchState<T> {
  return { status: 'ready', data };
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

describe('sectionAttentionCount', () => {
  test('sums attention statuses across every settled panel', () => {
    const panels: PanelSectionStatuses[] = [
      ['ok', 'attention', 'neutral'],
      ['neutral', 'attention'],
      [],
    ];
    expect(sectionAttentionCount(panels)).toBe(2);
  });

  test('any unsettled panel nulls the whole count — never a number that could grow', () => {
    expect(sectionAttentionCount([['attention'], null])).toBeNull();
  });

  test('settled panels with nothing to flag count to a real zero', () => {
    expect(sectionAttentionCount([['ok', 'neutral'], []])).toBe(0);
  });

  test('no panels at all is zero, not null', () => {
    expect(sectionAttentionCount([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integrity panel — six sections, two fetches
// ---------------------------------------------------------------------------

describe('integritySectionStatuses', () => {
  const cleanConfig = ready(configFixture());

  test('a fetch still in flight -> null (statuses not knowable)', () => {
    expect(integritySectionStatuses(loading, cleanConfig)).toBeNull();
  });

  test('a settled failed fetch -> empty list, so other panels still reach the badge', () => {
    expect(integritySectionStatuses(errored, cleanConfig)).toEqual([]);
    expect(integritySectionStatuses(empty, cleanConfig)).toEqual([]);
  });

  test('clean window -> the six rendered statuses in render order, none attention', () => {
    expect(integritySectionStatuses(ready(integrityFixture()), cleanConfig))
      .toEqual(['ok', 'ok', 'neutral', 'neutral', 'ok', 'ok']);
  });

  test('a findings-integrity mismatch is routed — the state the old two-assessor badge missed', () => {
    const statuses = integritySectionStatuses(
      ready(integrityFixture({ findingsIntegrity: { comparedRows: 5, mismatchCount: 1, mismatchRate: 0.2 } })),
      cleanConfig,
    );
    expect(statuses![4]).toBe('attention');
  });

  test('an error rate over the threshold is routed', () => {
    const statuses = integritySectionStatuses(
      ready(integrityFixture({ errorRate: { count: 40, total: 100, rate: 0.4 } })),
      cleanConfig,
    );
    expect(statuses![5]).toBe('attention');
  });

  test('declared pins failing to load renders "Cannot verify" as attention, and the badge counts it', () => {
    const statuses = integritySectionStatuses(ready(integrityFixture()), errored);
    expect(statuses![1]).toBe('attention');
  });

  test('declared pins still loading -> null for the whole panel, matching the ribbon card hold', () => {
    expect(integritySectionStatuses(ready(integrityFixture()), loading)).toBeNull();
  });
});

describe('contaminationDisplayStatus', () => {
  test('maps each section state to exactly what the section draws', () => {
    expect(contaminationDisplayStatus('loading')).toBe('neutral');
    expect(contaminationDisplayStatus('error')).toBe('attention');
    expect(contaminationDisplayStatus('ok')).toBe('ok');
    expect(contaminationDisplayStatus('attention')).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
// Operational panel — the tool-mix and rate-limit findings
// ---------------------------------------------------------------------------

describe('operationalSectionStatuses', () => {
  test('loading -> null; a settled failed fetch -> empty list', () => {
    expect(operationalSectionStatuses(loading)).toBeNull();
    expect(operationalSectionStatuses(errored)).toEqual([]);
  });

  test('clean window -> five rendered statuses, none attention', () => {
    expect(operationalSectionStatuses(ready(operationalFixture())))
      .toEqual(['neutral', 'neutral', 'ok', 'neutral', 'ok']);
  });

  test('a rate-limit event this window is routed to the badge', () => {
    const statuses = operationalSectionStatuses(ready(operationalFixture({ errorClassification: rateLimitedClassification })));
    expect(statuses![4]).toBe('attention');
  });

  test('a zero-call tool is routed to the badge', () => {
    const statuses = operationalSectionStatuses(ready(operationalFixture({
      toolMix: [
        { tool: 'Read', totalCalls: 40, avgPerReview: 2, reviewsUsing: 18 },
        { tool: 'lsp', totalCalls: 0, avgPerReview: 0, reviewsUsing: 0 },
      ] as OperationalStats['toolMix'],
    })));
    expect(statuses![2]).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
// Cost & Quality cards
// ---------------------------------------------------------------------------

describe('costSectionStatuses', () => {
  test('a flagged [1m] model is routed to the Cost & value badge', () => {
    const statuses = costSectionStatuses(ready(costFixture(true)));
    expect(statuses![3]).toBe('attention');
  });

  test('no flagged model -> five statuses, none attention', () => {
    expect(costSectionStatuses(ready(costFixture(false))))
      .toEqual(['neutral', 'neutral', 'neutral', 'ok', 'neutral']);
  });

  test('loading -> null', () => {
    expect(costSectionStatuses(loading)).toBeNull();
  });
});

describe('qualitySectionStatuses', () => {
  test('a danger-zone average is routed to the Cost & value badge', () => {
    const statuses = qualitySectionStatuses(ready(qualityFixture(2.0)));
    expect(statuses![0]).toBe('attention');
  });

  test('a watch-band average renders neutral, so the badge must not claim attention', () => {
    expect(qualitySectionStatuses(ready(qualityFixture(3.0)))!
      .filter((s) => s === 'attention')).toEqual([]);
  });

  test('no findings data -> unknown level, neutral, no badge claim', () => {
    expect(qualitySectionStatuses(ready(qualityFixture(null)))![0]).toBe('neutral');
  });

  test('loading -> null', () => {
    expect(qualitySectionStatuses(loading)).toBeNull();
  });
});

describe('readBandSectionStatus', () => {
  test('only danger is a scored finding', () => {
    expect(readBandSectionStatus('danger')).toBe('attention');
    expect(readBandSectionStatus('watch')).toBe('neutral');
    expect(readBandSectionStatus('healthy')).toBe('neutral');
    expect(readBandSectionStatus('unknown')).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Review value — translation, not omission
// ---------------------------------------------------------------------------

describe('reviewValueSectionStatuses', () => {
  test("an unsettled spend does NOT light the badge — this card's local attention means \"unsettled measurement\", which folds as the instrument-caveat state, not \"a person must act\"", () => {
    const statuses = reviewValueSectionStatuses(ready(reviewValueFixture()));
    expect(statuses).toEqual(['neutral', 'neutral', 'neutral', 'neutral']);
  });

  test('loading -> null; a settled failed fetch -> empty list', () => {
    expect(reviewValueSectionStatuses(loading)).toBeNull();
    expect(reviewValueSectionStatuses(errored)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config panel — the builders-disagree and eval-lever findings
// ---------------------------------------------------------------------------

describe('configSectionStatuses', () => {
  test('builders agreeing, no active levers -> seven statuses, none attention', () => {
    expect(configSectionStatuses(ready(configFixture())))
      .toEqual(['ok', 'neutral', 'neutral', 'neutral', 'neutral', 'ok', 'neutral']);
  });

  test('a builder disagreement — the "config may be inert" class — is routed to the Config badge', () => {
    const statuses = configSectionStatuses(ready(configFixture({ agree: false })));
    expect(statuses![0]).toBe('attention');
  });

  test('an active eval lever is routed to the Config badge', () => {
    const statuses = configSectionStatuses(ready(configFixture({ evalLevers: [activeLever] })));
    expect(statuses![5]).toBe('attention');
  });

  test('loading -> null; a settled failed fetch -> empty list', () => {
    expect(configSectionStatuses(loading)).toBeNull();
    expect(configSectionStatuses(errored)).toEqual([]);
  });
});

describe('shared status functions match what the sections draw', () => {
  test('builderComparisonSectionStatus', () => {
    expect(builderComparisonSectionStatus(true)).toBe('ok');
    expect(builderComparisonSectionStatus(false)).toBe('attention');
  });

  test('evalLeversSectionStatus', () => {
    expect(evalLeversSectionStatus([])).toBe('ok');
    expect(evalLeversSectionStatus([activeLever])).toBe('attention');
  });
});

// ---------------------------------------------------------------------------
// The per-section grouping — one mapping, matching the section JSX
// ---------------------------------------------------------------------------

describe('attentionBySection', () => {
  const allClean = {
    integrity: ready(integrityFixture()),
    operational: ready(operationalFixture()),
    cost: ready(costFixture(false)),
    quality: ready(qualityFixture(3.8)),
    reviewValue: ready(reviewValueFixture()),
    config: ready(configFixture()),
  };

  test('everything settled and clean -> a real zero on all three badged sections', () => {
    expect(attentionBySection(allClean)).toEqual({ health: 0, value: 0, config: 0 });
  });

  test('each attention source lands on the section whose panels render it', () => {
    const counts = attentionBySection({
      ...allClean,
      operational: ready(operationalFixture({ errorClassification: rateLimitedClassification })),
      cost: ready(costFixture(true)),
      quality: ready(qualityFixture(2.0)),
      config: ready(configFixture({ agree: false })),
    });
    // Health: rate-limit. Value: flagged model + danger zone. Config: builders disagree.
    expect(counts).toEqual({ health: 1, value: 2, config: 1 });
  });

  test('the declared-config fetch still in flight nulls Health (contamination) and Config, but not Cost & value', () => {
    const counts = attentionBySection({ ...allClean, config: loading });
    expect(counts.health).toBeNull();
    expect(counts.config).toBeNull();
    expect(counts.value).toBe(0);
  });

  test("one panel's failed fetch does not hide another panel's live attention on the same section", () => {
    const counts = attentionBySection({
      ...allClean,
      integrity: errored,
      operational: ready(operationalFixture({ errorClassification: rateLimitedClassification })),
    });
    expect(counts.health).toBe(1);
  });
});
