import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyModelConfigState,
  describeModelResolution,
  classifyEffortConfigState,
  describeEffortResolution,
  buildConfigHeadlineSummary,
  compareDeclaredVsEffective,
  buildOverlayOverrideSummary,
  buildPerAgentRow,
  describeCredential,
  describeLeverRow,
  buildConfigPanelView,
  AUTO_APPROVE_OVERRIDE_NOTE,
} from '../../src/dashboard/client/components/stats-config.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type {
  ConfigReport, BuilderResolution, EffortResolution, PerAgentReport, LeverStatus,
} from '../../src/dashboard/config-report.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/stats-integrity.test.ts). Every
// function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function builderFixture(overrides: Partial<BuilderResolution> = {}): BuilderResolution {
  return {
    raw: undefined,
    fromSettings: undefined,
    model: 'claude-opus-5',
    effort: { raw: undefined, parsed: undefined, effective: '(SDK default: high)' },
    usedBy: [],
    ...overrides,
  };
}

function effortFixture(overrides: Partial<EffortResolution> = {}): EffortResolution {
  return { raw: undefined, parsed: undefined, effective: '(SDK default: high)', ...overrides };
}

/** Matches the real ConfigReport shape (src/dashboard/config-report.ts) so
 *  these tests break if the response shape drifts, mirroring
 *  stats-integrity.test.ts's configFixture() precedent. */
function configFixture(overrides: Partial<ConfigReport> = {}): ConfigReport {
  return {
    generatedAt: '2026-08-01T00:00:00.000Z',
    orchestratorModel: {
      loadConfig: builderFixture(),
      buildConfigFromRepo: builderFixture(),
      agree: true,
      note: 'Two independent builders resolve DEFAULT_MODEL/DEFAULT_EFFORT.',
    },
    perAgent: [],
    ruleLearnerAgent: { name: 'rule-learner', model: 'claude-sonnet-5', maxTurns: 20, disallowedTools: [], note: '' },
    subAgents: { groups: [], inline: [], totalFrontmatterFiles: 0 },
    credential: { prReview: { envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: false, length: null, mode: 'oauth-subscription' } },
    evalLevers: [],
    overlay: { agentOverrideCount: 0, agents: {} },
    settingsApplied: {},
    ...overrides,
  };
}

function perAgentFixture(overrides: Partial<PerAgentReport> = {}): PerAgentReport {
  return {
    name: 'analyzer',
    configBuilder: 'buildConfigFromRepo',
    declaredModel: null,
    perAgentPin: null,
    pipelineDefaultModel: 'claude-opus-5',
    overlayOverrideModel: null,
    dbOverrideModel: null,
    effectiveModel: 'claude-opus-5',
    maxTurnsDeclared: null,
    overlayOverrideMaxTurns: null,
    dbOverrideMaxTurns: null,
    effectiveMaxTurns: 30,
    disallowedTools: [],
    overlayAllowedToolsOverridden: false,
    ...overrides,
  };
}

function leverFixture(overrides: Partial<LeverStatus> = {}): LeverStatus {
  return {
    key: 'PR_REVIEW_NO_POST', raw: undefined, state: 'absent',
    sourceRef: 'src/cli/review-pr.ts:890,951', description: 'Skips publishing the review to the PR.',
    ...overrides,
  };
}

function readyState<T>(data: T): FetchState<T> {
  return { status: 'ready', data };
}

// ---------------------------------------------------------------------------
// classifyModelConfigState / describeModelResolution
// ---------------------------------------------------------------------------

describe('classifyModelConfigState', () => {
  test('undefined -> unset', () => expect(classifyModelConfigState(undefined)).toBe('unset'));
  test('empty string -> empty (distinct from unset)', () => expect(classifyModelConfigState('')).toBe('empty'));
  test('a real value -> configured', () => expect(classifyModelConfigState('claude-sonnet-5')).toBe('configured'));
});

describe('describeModelResolution', () => {
  test('unset raw -> fallback qualifier names DEFAULT_MODEL unset, not a silent blank', () => {
    const d = describeModelResolution(builderFixture({ raw: undefined, model: 'claude-opus-5' }));
    expect(d.state).toBe('unset');
    expect(d.model).toBe('claude-opus-5');
    expect(d.qualifier).toContain('DEFAULT_MODEL unset');
  });

  test('raw = "" -> fallback qualifier distinct from the unset case', () => {
    const d = describeModelResolution(builderFixture({ raw: '', model: 'claude-opus-5' }));
    expect(d.state).toBe('empty');
    expect(d.qualifier).toContain('empty string');
    expect(d.qualifier).not.toBe(describeModelResolution(builderFixture({ raw: undefined })).qualifier);
  });

  test('a configured value -> no qualifier (the normal case needs no annotation)', () => {
    const d = describeModelResolution(builderFixture({ raw: 'claude-sonnet-5', model: 'claude-sonnet-5' }));
    expect(d.state).toBe('configured');
    expect(d.qualifier).toBe('');
  });
});

// ---------------------------------------------------------------------------
// classifyEffortConfigState / describeEffortResolution
// ---------------------------------------------------------------------------

describe('classifyEffortConfigState', () => {
  test('undefined -> unset', () => expect(classifyEffortConfigState(effortFixture({ raw: undefined, parsed: undefined }))).toBe('unset'));
  test('empty string -> empty', () => expect(classifyEffortConfigState(effortFixture({ raw: '', parsed: undefined }))).toBe('empty'));
  test('unrecognised value -> invalid', () => expect(classifyEffortConfigState(effortFixture({ raw: 'bogus', parsed: undefined }))).toBe('invalid'));
  test('a parsed value -> configured', () => expect(classifyEffortConfigState(effortFixture({ raw: 'low', parsed: 'low' }))).toBe('configured'));
});

describe('describeEffortResolution', () => {
  test('unset -> qualifier names DEFAULT_EFFORT unset', () => {
    const d = describeEffortResolution(effortFixture({ raw: undefined, parsed: undefined, effective: '(SDK default: high)' }));
    expect(d.qualifier).toContain('DEFAULT_EFFORT unset');
  });

  test('invalid raw value -> qualifier quotes the rejected raw value', () => {
    const d = describeEffortResolution(effortFixture({ raw: 'bogus', parsed: undefined, effective: '(SDK default: high)' }));
    expect(d.qualifier).toContain('"bogus"');
    expect(d.qualifier).toContain('not recognised');
  });

  test('configured -> no qualifier', () => {
    const d = describeEffortResolution(effortFixture({ raw: 'low', parsed: 'low', effective: 'low' }));
    expect(d.state).toBe('configured');
    expect(d.qualifier).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildConfigHeadlineSummary — the most-read text in the feature
// ---------------------------------------------------------------------------

describe('buildConfigHeadlineSummary', () => {
  test('today\'s real deployment shape: DEFAULT_MODEL unset + DEFAULT_EFFORT=low', () => {
    const report = configFixture({
      orchestratorModel: {
        loadConfig: builderFixture({ raw: undefined, model: 'claude-opus-5', effort: effortFixture({ raw: 'low', parsed: 'low', effective: 'low' }) }),
        buildConfigFromRepo: builderFixture({ raw: undefined, model: 'claude-opus-5', effort: effortFixture({ raw: 'low', parsed: 'low', effective: 'low' }) }),
        agree: true,
        note: '',
      },
    });
    const h = buildConfigHeadlineSummary(report);
    expect(h.attention).toBe(false);
    expect(h.disagreement).toBeNull();
    // The model must NOT look configured — a fallback needs its qualifier.
    expect(h.model.mono).toBe('claude-opus-5');
    expect(h.model.qualifier).toContain('DEFAULT_MODEL unset');
    // The effort genuinely IS configured — no qualifier needed.
    expect(h.effort.mono).toBe('low');
    expect(h.effort.qualifier).toBe('');
  });

  test('DEFAULT_MODEL set to empty string is a third, distinct case from unset', () => {
    const report = configFixture({
      orchestratorModel: {
        loadConfig: builderFixture({ raw: '', model: 'claude-opus-5' }),
        buildConfigFromRepo: builderFixture({ raw: '', model: 'claude-opus-5' }),
        agree: true,
        note: '',
      },
    });
    const h = buildConfigHeadlineSummary(report);
    expect(h.model.qualifier).toContain('empty string');
  });

  test('builders disagree -> loud in the headline, not just the body', () => {
    const report = configFixture({
      orchestratorModel: {
        loadConfig: builderFixture({ model: 'claude-opus-5' }),
        buildConfigFromRepo: builderFixture({ model: 'claude-sonnet-5' }),
        agree: false,
        note: '',
      },
    });
    const h = buildConfigHeadlineSummary(report);
    expect(h.attention).toBe(true);
    expect(h.disagreement).toEqual({ loadModel: 'claude-opus-5', repoModel: 'claude-sonnet-5' });
  });

  test('fully configured values need no qualifiers on either segment', () => {
    const report = configFixture({
      orchestratorModel: {
        loadConfig: builderFixture({ raw: 'claude-sonnet-5', model: 'claude-sonnet-5', effort: effortFixture({ raw: 'medium', parsed: 'medium', effective: 'medium' }) }),
        buildConfigFromRepo: builderFixture({ raw: 'claude-sonnet-5', model: 'claude-sonnet-5', effort: effortFixture({ raw: 'medium', parsed: 'medium', effective: 'medium' }) }),
        agree: true,
        note: '',
      },
    });
    const h = buildConfigHeadlineSummary(report);
    expect(h.model.qualifier).toBe('');
    expect(h.effort.qualifier).toBe('');
  });
});

// ---------------------------------------------------------------------------
// compareDeclaredVsEffective / buildOverlayOverrideSummary / buildPerAgentRow
// ---------------------------------------------------------------------------

describe('compareDeclaredVsEffective', () => {
  test('declared null -> differs (nothing declared at all)', () => {
    const cmp = compareDeclaredVsEffective(null, 'claude-opus-5');
    expect(cmp.differs).toBe(true);
    expect(cmp.declared).toBeNull();
  });

  test('declared equals effective -> does not differ', () => {
    const cmp = compareDeclaredVsEffective('claude-sonnet-5', 'claude-sonnet-5');
    expect(cmp.differs).toBe(false);
  });

  test('declared differs from effective (an override took effect) -> differs', () => {
    const cmp = compareDeclaredVsEffective('claude-sonnet-5', 'claude-opus-5');
    expect(cmp.differs).toBe(true);
  });

  test('numeric declared/effective compare by value, not reference', () => {
    expect(compareDeclaredVsEffective(30, 30).differs).toBe(false);
    expect(compareDeclaredVsEffective(30, 45).differs).toBe(true);
  });
});

describe('buildOverlayOverrideSummary / buildPerAgentRow', () => {
  test('no overlay override, no declared model -> both DvE differ (fallback to pipeline default) and overlay is empty', () => {
    const row = buildPerAgentRow(perAgentFixture());
    expect(row.model.differs).toBe(true);
    expect(row.model.declared).toBeNull();
    expect(row.overlay).toEqual({ model: null, maxTurns: null, toolsOverridden: false });
  });

  test('declared model equals effective -> model does not differ', () => {
    const row = buildPerAgentRow(perAgentFixture({ declaredModel: 'claude-sonnet-5', effectiveModel: 'claude-sonnet-5' }));
    expect(row.model.differs).toBe(false);
  });

  test('an overlay override is surfaced verbatim, independent of declared/effective', () => {
    const row = buildPerAgentRow(perAgentFixture({
      overlayOverrideModel: 'claude-opus-5', overlayOverrideMaxTurns: 50, overlayAllowedToolsOverridden: true,
    }));
    expect(row.overlay).toEqual({ model: 'claude-opus-5', maxTurns: 50, toolsOverridden: true });
  });

  test('disallowed tools pass through unchanged', () => {
    const row = buildPerAgentRow(perAgentFixture({ disallowedTools: ['Write', 'Edit'] }));
    expect(row.disallowedTools).toEqual(['Write', 'Edit']);
  });
});

// ---------------------------------------------------------------------------
// describeCredential — never renders the value itself
// ---------------------------------------------------------------------------

describe('describeCredential', () => {
  // Readability fix round 2 (rank #3): the `mode:` enum values
  // ('oauth-subscription' / 'pay-per-token') were internal identifiers doing a
  // sentence's job — the rewrites below say the billing consequence in words.
  test('unset -> names the subscription-login consequence in words, no length, no enum value', () => {
    const text = describeCredential({ envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: false, length: null, mode: 'oauth-subscription' });
    expect(text).toBe('Not set — reviews run on the Claude subscription login instead of a per-token API key.');
    expect(text).not.toContain('mode:');
    expect(text).not.toContain('oauth-subscription');
  });

  test('set -> names the per-token billing consequence, length shown, value never present', () => {
    const text = describeCredential({ envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: true, length: 108, mode: 'pay-per-token' });
    expect(text).toBe('Set (108 characters) — reviews bill per token through this key.');
    expect(text).not.toContain('mode:');
    expect(text).not.toContain('pay-per-token');
    expect(text).not.toContain('sk-ant');
  });

  test('singular "character" for length 1', () => {
    const text = describeCredential({ envVar: 'PR_REVIEW_ANTHROPIC_API_KEY', set: true, length: 1, mode: 'pay-per-token' });
    expect(text).toContain('1 character)');
    expect(text).not.toContain('1 characters)');
  });
});

// ---------------------------------------------------------------------------
// describeLeverRow — three LeverState values, each with a distinct word
// ---------------------------------------------------------------------------

describe('describeLeverRow', () => {
  test('active -> word "active", tinted row', () => {
    const row = describeLeverRow(leverFixture({ state: 'active' }));
    expect(row.stateText).toBe('active');
    expect(row.rowClass).toContain('active');
  });

  test('present-but-inert -> the ground-truth trap case (e.g. PR_REVIEW_NO_POST="")', () => {
    const row = describeLeverRow(leverFixture({ state: 'present-but-inert', raw: '' }));
    expect(row.stateText).toBe('present, but inert');
    expect(row.rowClass).toContain('inert');
  });

  test('absent -> "not set", no row tint', () => {
    const row = describeLeverRow(leverFixture({ state: 'absent', raw: undefined }));
    expect(row.stateText).toBe('not set');
    expect(row.rowClass).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildConfigPanelView — the loading/error/empty/ready wrapper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Readability fix round 2 (rank #3) — Config speaks in role words, not code.
// No value assertion can reach JSX text, so this is a source-scan secondary
// net, mirroring stats-costquality.test.ts's "cost card structure" block.
// ---------------------------------------------------------------------------

describe('config panel prose — secondary net', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/dashboard/client/components/stats-config.tsx', import.meta.url)),
    'utf-8',
  );

  // THE load-bearing sentence of the rewrite: `allowedTools` is an
  // auto-approve list, not an availability restriction — agents run with the
  // permission layer bypassed, so a tool left off the list stays callable
  // (proven by telemetry 2026-07-31: an agent called a tool it never listed).
  // "Tools overridden" would be a FALSE claim. Pinned verbatim so a future
  // "simplification" cannot quietly restore the lie.
  test('the auto-approve note states auto-approval, not availability — verbatim', () => {
    expect(AUTO_APPROVE_OVERRIDE_NOTE).toBe(
      'An auto-approve override changes which tool calls are approved to run without asking first — it '
      + 'does not change which tools the agent can use. A tool left off the list stays callable; only a '
      + 'tool in the disallowed list is removed.',
    );
  });

  test('the auto-approve note renders in BOTH tables that show the override, from the one constant', () => {
    const occurrences = src.split('{AUTO_APPROVE_OVERRIDE_NOTE}').length - 1;
    expect(occurrences).toBe(2);
  });

  test('no cell or header claims "tools overridden" bare — the phrase always names the auto-approve list', () => {
    expect(src).toContain('auto-approve list (<code class="config-mono">allowedTools</code>) overridden');
    expect(src).toContain('<th>Auto-approve list overridden</th>');
    expect(src).not.toContain("'allowedTools overridden'");
    expect(src).not.toContain('>allowedTools overridden<');
  });

  // The most-read line on the panel: the healthy headline now labels its two
  // mono values ("model X · effort Y") instead of rendering two bare tokens.
  test('the collapsed headline labels its two values with nouns', () => {
    expect(src).toContain("{'model '}");
    expect(src).toContain("{' · effort '}");
  });

  // The 2am string: the builders-disagree alarm names the two resolution
  // paths by role. The internal function names stay out of rendered text.
  test('the disagreement alarm speaks in roles, and the function names never render', () => {
    expect(src).toContain('two independent readings of the orchestrator model disagree');
    expect(src).toContain("Reviews' own path — model");
    expect(src).toContain('Repo-registry path — model');
    expect(src).not.toContain('>loadConfig</code>');
    expect(src).not.toContain('>buildConfigFromRepo</code>');
    // The old rendered clause, exactly — comments may still SAY the builders
    // disagree (developer documentation), but no reader-facing string may.
    expect(src).not.toContain('builders disagree — ');
  });

  test('the per-agent section title and note carry no internal function name', () => {
    expect(src).toContain('Per-agent settings, as actually resolved');
    expect(src).not.toContain('via resolveAgentKnobs');
    expect(src).not.toContain('resolveAgentKnobs made no change');
  });

  // The wording decision card-prose-sweep.test.ts's NOT_SWEPT entry was
  // waiting for — "PR" never reaches a reader (see that file's deny list).
  test('the credential section title spells out "pull request"', () => {
    expect(src).toContain('Pull-request review credential');
    expect(src).not.toContain('PR-review credential');
  });
});

describe('buildConfigPanelView', () => {
  test('loading', () => {
    const view = buildConfigPanelView({ status: 'loading' });
    expect(view.status).toBe('loading');
    expect(view.report).toBeNull();
  });

  test('error carries the message, distinct text from "no data"', () => {
    const view = buildConfigPanelView({ status: 'error', message: '500 Internal Server Error' });
    expect(view.status).toBe('error');
    expect(view.message).toContain('500 Internal Server Error');
  });

  test('ready -> the full report passes through untouched', () => {
    const report = configFixture();
    const view = buildConfigPanelView(readyState(report));
    expect(view.status).toBe('ready');
    expect(view.report).toBe(report);
  });
});
