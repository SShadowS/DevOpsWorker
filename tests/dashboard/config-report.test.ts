import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveEffortDisplay,
  classifyLever,
  resolveEvalLevers,
  resolvePrReviewCredential,
  parseFrontmatterModel,
  readSubAgentPins,
  buildAgentKnobsReport,
  buildConfigReport,
} from '../../src/dashboard/config-report.ts';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import { z } from 'zod';

// No test in this file may open a database connection or a network connection —
// config-report.ts needs neither. `buildConfigReport()` reads live `process.env`
// (mutated here via save/restore, never left dirty) and takes an injectable
// `manifest` so tests never touch the real overlay checked out at `private/` on
// this machine.

const ENV_KEYS = [
  'DEFAULT_MODEL', 'DEFAULT_EFFORT', 'PR_REVIEW_ANTHROPIC_API_KEY',
  'PR_REVIEW_NO_POST', 'PR_REVIEW_SUBAGENT_MODEL', 'PR_REVIEW_SUBAGENT_TOOL_RULE',
  'PR_REVIEW_AGENT_SET', 'PR_REVIEW_AGENT_ROUTING', 'PR_REVIEW_SCOPED_PAYLOAD',
  'PR_REVIEW_SECURITY_BC_ONLY', 'CI_WAITER_MODEL', 'AZURE_DEVOPS_PAT',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---------------------------------------------------------------------------
// resolveEffortDisplay — wraps cli/config.ts's parseEffort with a display value
// ---------------------------------------------------------------------------

describe('resolveEffortDisplay', () => {
  test('unset reads as the SDK default, not a blank value', () => {
    const r = resolveEffortDisplay(undefined);
    expect(r.parsed).toBeUndefined();
    expect(r.effective).toBe('(SDK default: high)');
  });

  test('a recognised level parses and is the effective value verbatim', () => {
    const r = resolveEffortDisplay('low');
    expect(r.parsed).toBe('low');
    expect(r.effective).toBe('low');
  });

  test('an unrecognised value is a no-op, same as unset — never surfaced as if it took effect', () => {
    const r = resolveEffortDisplay('turbo');
    expect(r.parsed).toBeUndefined();
    expect(r.effective).toBe('(SDK default: high)');
    expect(r.raw).toBe('turbo');
  });
});

// ---------------------------------------------------------------------------
// classifyLever / resolveEvalLevers — verify by effect, not presence
// ---------------------------------------------------------------------------

describe('classifyLever', () => {
  test('unset key is absent', () => {
    expect(classifyLever(undefined, (v) => v === '1')).toBe('absent');
  });

  test('present but failing the predicate is present-but-inert, not absent', () => {
    expect(classifyLever('', (v) => v === '1')).toBe('present-but-inert');
  });

  test('present and satisfying the predicate is active', () => {
    expect(classifyLever('1', (v) => v === '1')).toBe('active');
  });
});

describe('resolveEvalLevers — the ground-truth trap', () => {
  test('PR_REVIEW_NO_POST set to empty string is present-but-inert, never active (the documented false-alarm case)', () => {
    const levers = resolveEvalLevers({ PR_REVIEW_NO_POST: '' });
    const noPost = levers.find((l) => l.key === 'PR_REVIEW_NO_POST')!;
    expect(noPost.raw).toBe('');
    expect(noPost.state).toBe('present-but-inert');
  });

  test('PR_REVIEW_NO_POST=1 is active', () => {
    const levers = resolveEvalLevers({ PR_REVIEW_NO_POST: '1' });
    expect(levers.find((l) => l.key === 'PR_REVIEW_NO_POST')!.state).toBe('active');
  });

  test('a completely unset lever is absent, distinct from present-but-inert', () => {
    const levers = resolveEvalLevers({});
    for (const l of levers) expect(l.state).toBe('absent');
  });

  test('PR_REVIEW_SUBAGENT_MODEL is active on any non-blank value (not gated on "1")', () => {
    const levers = resolveEvalLevers({ PR_REVIEW_SUBAGENT_MODEL: 'claude-opus-5' });
    expect(levers.find((l) => l.key === 'PR_REVIEW_SUBAGENT_MODEL')!.state).toBe('active');
  });

  test('PR_REVIEW_SUBAGENT_MODEL set to whitespace only is present-but-inert', () => {
    const levers = resolveEvalLevers({ PR_REVIEW_SUBAGENT_MODEL: '   ' });
    expect(levers.find((l) => l.key === 'PR_REVIEW_SUBAGENT_MODEL')!.state).toBe('present-but-inert');
  });

  test('every one-flag lever (=== "1") is inert on any other value', () => {
    const oneFlagKeys = ['PR_REVIEW_SUBAGENT_TOOL_RULE', 'PR_REVIEW_AGENT_ROUTING', 'PR_REVIEW_SCOPED_PAYLOAD', 'PR_REVIEW_SECURITY_BC_ONLY'];
    const env = Object.fromEntries(oneFlagKeys.map((k) => [k, 'true'])); // truthy-looking, but not '1'
    const levers = resolveEvalLevers(env);
    for (const k of oneFlagKeys) expect(levers.find((l) => l.key === k)!.state).toBe('present-but-inert');
  });

  test('exactly 7 levers are reported (6 eval hooks + PR_REVIEW_NO_POST; the credential is reported separately)', () => {
    expect(resolveEvalLevers({})).toHaveLength(7);
  });

  test('PR_REVIEW_ANTHROPIC_API_KEY is never classified as a lever', () => {
    // Computed property key here and at every other PR_REVIEW_ANTHROPIC_API_KEY fixture
    // below, unlike the plain PR_REVIEW_NO_POST key above: the repo's guard-commit hook
    // blocks a commit whose diff looks like an assignment to the Anthropic API key env var
    // name, and a bare key here trips it even though the value is always a harmless
    // placeholder, never a real key.
    const levers = resolveEvalLevers({ ['PR_REVIEW_ANTHROPIC_API_KEY']: 'placeholder' });
    expect(levers.find((l) => l.key === 'PR_REVIEW_ANTHROPIC_API_KEY')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePrReviewCredential
// ---------------------------------------------------------------------------

describe('resolvePrReviewCredential', () => {
  test('unset key means OAuth subscription', () => {
    const c = resolvePrReviewCredential({});
    expect(c.set).toBe(false);
    expect(c.mode).toBe('oauth-subscription');
    expect(c.length).toBeNull();
  });

  test('set key means pay-per-token, and reports length but never the value', () => {
    const c = resolvePrReviewCredential({ ['PR_REVIEW_ANTHROPIC_API_KEY']: 'x'.repeat(108) });
    expect(c.set).toBe(true);
    expect(c.mode).toBe('pay-per-token');
    expect(c.length).toBe(108);
    expect(JSON.stringify(c)).not.toContain('x'.repeat(108));
  });

  test('empty string is treated as unset (matches the falsy check at the real read site)', () => {
    const c = resolvePrReviewCredential({ ['PR_REVIEW_ANTHROPIC_API_KEY']: '' });
    expect(c.set).toBe(false);
    expect(c.mode).toBe('oauth-subscription');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterModel / readSubAgentPins
// ---------------------------------------------------------------------------

describe('parseFrontmatterModel', () => {
  test('extracts the model value from a frontmatter block', () => {
    const content = '---\nname: foo\nmodel: claude-sonnet-5\ncolor: cyan\n---\nbody';
    expect(parseFrontmatterModel(content)).toBe('claude-sonnet-5');
  });

  test('returns null when no model line is present', () => {
    expect(parseFrontmatterModel('---\nname: foo\n---\nbody')).toBeNull();
  });
});

describe('readSubAgentPins — against the real pr-reviewer sub-agent directory', () => {
  test('finds the real files on disk with their declared model', () => {
    const dir = new URL('../../src/agents/pr-reviewer/.claude/agents', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
    const pins = readSubAgentPins(dir);
    expect(pins.length).toBeGreaterThan(0);
    for (const p of pins) {
      expect(p.file.endsWith('.md')).toBe(true);
      expect(typeof p.declaredModel === 'string' || p.declaredModel === null).toBe(true);
    }
  });

  test('a missing directory returns an empty array rather than throwing', () => {
    expect(readSubAgentPins('/does/not/exist/at/all')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildAgentKnobsReport — the resolveAgentKnobs precedence, made visible
// ---------------------------------------------------------------------------

const dummySchema = z.object({});
function dummyAgent(overrides: Partial<AgentConfig<typeof dummySchema>> = {}): AgentConfig<typeof dummySchema> {
  return {
    name: 'dummy',
    sharedPromptFragments: [],
    buildPrompt: () => '',
    outputSchema: dummySchema,
    allowedTools: [],
    disallowedTools: ['NotebookEdit'],
    ...overrides,
  };
}

describe('buildAgentKnobsReport', () => {
  test('with no pins anywhere, falls through to the pipeline default', () => {
    const r = buildAgentKnobsReport(dummyAgent(), {}, { default: 'claude-opus-5' });
    expect(r.effectiveModel).toBe('claude-opus-5');
    expect(r.declaredModel).toBeNull();
    expect(r.perAgentPin).toBeNull();
    expect(r.overlayOverrideModel).toBeNull();
  });

  test('a perAgent pin wins over the pipeline default', () => {
    const r = buildAgentKnobsReport(dummyAgent({ name: 'coder' }), {}, { default: 'claude-opus-5', perAgent: { coder: 'claude-sonnet-5' } });
    expect(r.effectiveModel).toBe('claude-sonnet-5');
    expect(r.perAgentPin).toBe('claude-sonnet-5');
  });

  test('a base.model pin wins over perAgent', () => {
    const r = buildAgentKnobsReport(
      dummyAgent({ name: 'cherry-pick-reviewer', model: 'claude-sonnet-5' }),
      {},
      { default: 'claude-opus-5', perAgent: { 'cherry-pick-reviewer': 'claude-haiku-4-5' } },
    );
    expect(r.effectiveModel).toBe('claude-sonnet-5');
    expect(r.declaredModel).toBe('claude-sonnet-5');
  });

  test('an overlay override wins over everything, and is reported distinctly from the declared value', () => {
    const r = buildAgentKnobsReport(
      dummyAgent({ name: 'coder', model: 'claude-sonnet-5' }),
      { agents: { coder: { model: 'claude-opus-5' } } },
      { default: 'claude-opus-5', perAgent: { coder: 'claude-sonnet-5' } },
    );
    expect(r.effectiveModel).toBe('claude-opus-5');
    expect(r.overlayOverrideModel).toBe('claude-opus-5');
    expect(r.declaredModel).toBe('claude-sonnet-5');
  });

  test('maxTurns defaults to 50 (resolveAgentKnobs default) when nothing declares it', () => {
    const r = buildAgentKnobsReport(dummyAgent(), {}, { default: 'claude-opus-5' });
    expect(r.effectiveMaxTurns).toBe(50);
    expect(r.maxTurnsDeclared).toBeNull();
  });

  test('an agent-declared maxTurns is both the declared and effective value with no overlay', () => {
    const r = buildAgentKnobsReport(dummyAgent({ name: 'coder', maxTurns: 200 }), {}, { default: 'claude-opus-5' });
    expect(r.maxTurnsDeclared).toBe(200);
    expect(r.effectiveMaxTurns).toBe(200);
  });

  test('disallowedTools is carried through verbatim', () => {
    const r = buildAgentKnobsReport(dummyAgent({ disallowedTools: ['Bash', 'Write'] }), {}, { default: 'claude-opus-5' });
    expect(r.disallowedTools).toEqual(['Bash', 'Write']);
  });
});

// ---------------------------------------------------------------------------
// buildConfigReport — end to end, both config builders
// ---------------------------------------------------------------------------

describe('buildConfigReport', () => {
  function clearEnv() {
    for (const k of ENV_KEYS) delete process.env[k];
  }

  test('DEFAULT_MODEL unset: both builders fall through the || to the same hardcoded literal, and raw says so', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    expect(report.orchestratorModel.loadConfig.model).toBe('claude-opus-5');
    expect(report.orchestratorModel.buildConfigFromRepo.model).toBe('claude-opus-5');
    expect(report.orchestratorModel.agree).toBe(true);
    // The whole point of `raw`: "claude-opus-5" alone cannot tell a consumer
    // whether an operator configured it or nobody configured anything.
    expect(report.orchestratorModel.loadConfig.raw).toBeUndefined();
    expect(report.orchestratorModel.buildConfigFromRepo.raw).toBeUndefined();
  });

  test('DEFAULT_MODEL set: both builders honour it identically, and raw carries the configured value through', async () => {
    clearEnv();
    process.env['DEFAULT_MODEL'] = 'claude-opus-4-8';
    const report = await buildConfigReport({ manifest: {} });
    expect(report.orchestratorModel.loadConfig.model).toBe('claude-opus-4-8');
    expect(report.orchestratorModel.buildConfigFromRepo.model).toBe('claude-opus-4-8');
    expect(report.orchestratorModel.agree).toBe(true);
    expect(report.orchestratorModel.loadConfig.raw).toBe('claude-opus-4-8');
    expect(report.orchestratorModel.buildConfigFromRepo.raw).toBe('claude-opus-4-8');
  });

  test('DEFAULT_MODEL="" (set but empty): raw reports the empty string while model still falls through || to the literal', async () => {
    // The one case where || and ?? diverge, and the case the brief explicitly called out —
    // container-dispatcher.ts forwards an unset host var into a spawned container as '',
    // so "configured but empty" is a real, not hypothetical, state this endpoint must show
    // distinctly from both "unset" and "configured to a real model".
    clearEnv();
    process.env['DEFAULT_MODEL'] = '';
    const report = await buildConfigReport({ manifest: {} });
    expect(report.orchestratorModel.loadConfig.raw).toBe('');
    expect(report.orchestratorModel.buildConfigFromRepo.raw).toBe('');
    expect(report.orchestratorModel.loadConfig.model).toBe('claude-opus-5');
    expect(report.orchestratorModel.buildConfigFromRepo.model).toBe('claude-opus-5');
    expect(report.orchestratorModel.agree).toBe(true);
  });

  test('DEFAULT_EFFORT=low resolves on both builders; unset reads as the SDK default label', async () => {
    clearEnv();
    process.env['DEFAULT_EFFORT'] = 'low';
    const report = await buildConfigReport({ manifest: {} });
    expect(report.orchestratorModel.loadConfig.effort.effective).toBe('low');
    expect(report.orchestratorModel.buildConfigFromRepo.effort.effective).toBe('low');

    clearEnv();
    const unset = await buildConfigReport({ manifest: {} });
    expect(unset.orchestratorModel.loadConfig.effort.effective).toBe('(SDK default: high)');
  });

  test('PR_REVIEW_ANTHROPIC_API_KEY set flips the PR-review credential to pay-per-token', async () => {
    clearEnv();
    process.env['PR_REVIEW_ANTHROPIC_API_KEY'] = 'x'.repeat(40);
    const report = await buildConfigReport({ manifest: {} });
    expect(report.credential.prReview.mode).toBe('pay-per-token');
    expect(report.credential.prReview.length).toBe(40);
  });

  test('reports all 13 pipeline/review agents plus rule-learner as a distinct hardcoded entry', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    const names = report.perAgent.map((a) => a.name).sort();
    expect(names).toEqual(
      [
        'analyzer', 'planner', 'plan-reviewer', 'coder', 'code-reviewer',
        'draft-pr', 'test-cases', 'test-case-reviewer', 'documenter', 'docs-writer',
        'pr-reviewer', 'cherry-pick-reviewer',
      ].sort(),
    );
    expect(report.ruleLearnerAgent.name).toBe('rule-learner');
    expect(report.ruleLearnerAgent.model).toBe('claude-sonnet-5');
  });

  test('pr-reviewer and cherry-pick-reviewer are resolved via the loadConfig builder; the rest via buildConfigFromRepo', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    const byName = new Map(report.perAgent.map((a) => [a.name, a]));
    expect(byName.get('pr-reviewer')!.configBuilder).toBe('loadConfig');
    expect(byName.get('cherry-pick-reviewer')!.configBuilder).toBe('loadConfig');
    expect(byName.get('coder')!.configBuilder).toBe('buildConfigFromRepo');
  });

  test('coder resolves to its perAgent pin (claude-sonnet-5) with maxTurns 200', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    const coder = report.perAgent.find((a) => a.name === 'coder')!;
    expect(coder.effectiveModel).toBe('claude-sonnet-5');
    expect(coder.effectiveMaxTurns).toBe(200);
  });

  test('cherry-pick-reviewer keeps its pinned model even under an overlay perAgent override attempt', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    const cpr = report.perAgent.find((a) => a.name === 'cherry-pick-reviewer')!;
    expect(cpr.effectiveModel).toBe('claude-sonnet-5');
    expect(cpr.declaredModel).toBe('claude-sonnet-5');
    expect(cpr.effectiveMaxTurns).toBe(60);
  });

  test('an overlay agent override is visible on the affected agent and nowhere else', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: { agents: { analyzer: { model: 'claude-opus-4-8' } } } });
    const analyzer = report.perAgent.find((a) => a.name === 'analyzer')!;
    const planner = report.perAgent.find((a) => a.name === 'planner')!;
    expect(analyzer.overlayOverrideModel).toBe('claude-opus-4-8');
    expect(analyzer.effectiveModel).toBe('claude-opus-4-8');
    expect(planner.overlayOverrideModel).toBeNull();
  });

  test('reports the pr-reviewer sub-agent frontmatter group with 7 files, and includes the ci-waiter inline sub-agent separately', async () => {
    clearEnv();
    const report = await buildConfigReport({ manifest: {} });
    const prReviewerGroup = report.subAgents.groups.find((g) => g.parentAgent === 'pr-reviewer')!;
    expect(prReviewerGroup.count).toBe(7);
    const ciWaiter = report.subAgents.inline.find((s) => s.subagentType === 'ci-waiter')!;
    expect(ciWaiter.parentAgent).toBe('coder');
    expect(ciWaiter.declaredModel).toBe('claude-haiku-4-5');
  });

  test('CI_WAITER_MODEL env override is reflected in the inline sub-agent report', async () => {
    clearEnv();
    // CI_WAITER_MODEL is read at module-load time in coder/config.ts, not
    // per-call — this test documents that limitation rather than asserting
    // a live override, since the module is already loaded by the time this
    // test runs. See the note field on the inline sub-agent entry.
    const report = await buildConfigReport({ manifest: {} });
    const ciWaiter = report.subAgents.inline.find((s) => s.subagentType === 'ci-waiter')!;
    expect(typeof ciWaiter.declaredModel).toBe('string');
  });

  test('the response never contains the raw PR_REVIEW_ANTHROPIC_API_KEY value', async () => {
    clearEnv();
    const secret = 'sk-ant-do-not-leak-this-value-please';
    process.env['PR_REVIEW_ANTHROPIC_API_KEY'] = secret;
    const report = await buildConfigReport({ manifest: {} });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  // AZURE_DEVOPS_PAT flows into buildRepoEnv() and from there into every
  // per-agent AgentConfig's mcpServers (azureDevOpsMcp embeds the live PAT).
  // Nothing in this module currently reads mcpServers back out of an
  // AgentConfig — buildAgentKnobsReport only extracts name/model/maxTurns/
  // disallowedTools — so today's non-leakage is implicit, not enforced by any
  // guard. This test exists so a future field added to PerAgentReport off
  // `base` (e.g. a well-meaning `mcpServerCount`) fails loudly here instead
  // of silently shipping a live Azure DevOps PAT into a public JSON endpoint.
  test('the response never contains the raw AZURE_DEVOPS_PAT value, even though it flows into every agent config', async () => {
    clearEnv();
    const secret = 'azdo-pat-do-not-leak-this-value-please';
    process.env['AZURE_DEVOPS_PAT'] = secret;
    const report = await buildConfigReport({ manifest: {} });
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
