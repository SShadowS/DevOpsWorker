import { describe, test, expect } from 'bun:test';
import {
  checkArmCompliance,
  type SubAgentTelemetryEntry,
  type LeverFlags,
  type AppliedLevers,
} from '../../../scripts/pr-review-eval/compliance.ts';

describe('checkArmCompliance', () => {
  const AGENT_NAMES = ['code-review-validator', 'code-quality-assessor', 'security-edge-case-analyzer',
     'al-performance-analyzer', 'al-architecture-analyzer', 'al-error-pattern-analyzer',
     'al-integration-analyzer'];

  const seven = Object.fromEntries(AGENT_NAMES.map((n) => [n, {}]));

  test('baseline with all seven is compliant', () => {
    const v = checkArmCompliance('baseline', null, null, seven);
    expect(v.compliant).toBe(true);
    expect(v.actual).toBe(7);
  });

  test('no-cqa arm that still ran code-quality-assessor is VOID', () => {
    const expected = Object.keys(seven).filter((n) => n !== 'code-quality-assessor');
    const v = checkArmCompliance('no-cqa', expected, null, seven);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('code-quality-assessor');
  });

  test('routed arm that dispatched all seven is flagged, not silently accepted', () => {
    const v = checkArmCompliance('routed', null, null, seven);
    expect(v.compliant).toBe(true);
    expect(v.note).toContain('all 7');
  });

  test('missing telemetry is VOID, never assumed compliant', () => {
    const v = checkArmCompliance('routed', null, null, null);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('no sub_agents telemetry');
  });

  // --- Additional void-bias coverage beyond the brief's four cases ---
  //
  // The brief's implementation only checks for `unexpected` names present in
  // `subAgents` that aren't in `expected`. It never checks whether `subAgents`
  // is non-empty, so a row where the orchestrator recorded a row but dispatched
  // ZERO sub-agents (`sub_agents: {}`, a real, reachable state — see
  // src/sdk/agent-stream.ts's `subAgents` accumulator, which starts at `{}` and
  // is written verbatim by review-pr.ts even when nothing populated it) would
  // pass through both the brief's happy path AND its no-cqa VOID path silently:
  // an empty set has no members outside any `expected` list, vacuously. That is
  // exactly the "the lever did nothing, but looks like data" failure this module
  // exists to catch, just relocated from "wrong roster" to "no roster at all".

  test('empty sub_agents object (nothing dispatched) is VOID, not silently compliant', () => {
    const v = checkArmCompliance('baseline', null, null, {});
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
    expect(v.reason).toContain('no sub-agent actually ran');
  });

  test('empty sub_agents object is VOID even under an arm with a pinned roster', () => {
    const expected = Object.keys(seven).filter((n) => n !== 'code-quality-assessor');
    const v = checkArmCompliance('no-cqa', expected, null, {});
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
  });

  test('array-shaped sub_agents (malformed telemetry) is VOID, not read as agent names', () => {
    // jsonb_typeof(sub_agents) is documented to always be 'object'; if some
    // upstream defect ever wrote a JSON array instead, Object.keys() on it
    // would yield numeric-index strings ('0', '1', ...) that are not real
    // agent names but would otherwise slip through as "actual" data.
    const v = checkArmCompliance('baseline', null, null, ['a', 'b', 'c'] as unknown as Record<string, SubAgentTelemetryEntry>);
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
    expect(v.reason).toContain('array');
  });

  // --- Model-pin compliance (fix round 1) ---
  //
  // Live evidence settled this: 490/490 real sub-agent entries in pr_reviews
  // carry a non-null `model` (agent-stream.ts always sets it from the first
  // attributed assistant message), and rows 1580-1586 show all seven sub-agents
  // silently running on claude-opus-5 while every frontmatter file pinned
  // claude-sonnet-5 -- the exact "lever silently ignored" failure class this
  // module exists to catch, just in the model dimension instead of the roster.

  const sevenSonnet: Record<string, SubAgentTelemetryEntry> = Object.fromEntries(
    AGENT_NAMES.map((n) => [n, { model: 'claude-sonnet-5' }]),
  );

  test('model mismatch on one sub-agent VOIDs the arm, naming the offending agent', () => {
    const subAgents = { ...sevenSonnet, 'al-performance-analyzer': { model: 'claude-opus-5' } };
    const v = checkArmCompliance('sonnet-pin', null, 'claude-sonnet-5', subAgents);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('al-performance-analyzer');
  });

  test('entry missing model telemetry VOIDs, even though live telemetry is always populated', () => {
    const subAgents = { ...sevenSonnet, 'al-performance-analyzer': {} };
    const v = checkArmCompliance('sonnet-pin', null, 'claude-sonnet-5', subAgents);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('entry lacks model telemetry');
    expect(v.reason).toContain('al-performance-analyzer');
  });

  test('expectedModel: null skips the model check entirely', () => {
    // Same all-opus corruption as the mismatch test above, but this arm pins
    // no model -- the check must not touch model at all, and the roster is
    // still exactly `seven`, so this is compliant (with the routing note,
    // since all 7 ran and armName !== 'baseline').
    const subAgents = { ...sevenSonnet, 'al-performance-analyzer': { model: 'claude-opus-5' } };
    const v = checkArmCompliance('routed', null, null, subAgents);
    expect(v.compliant).toBe(true);
  });

  test('date-suffixed model ids normalise before comparison', () => {
    // Assistant messages report bare ids (`claude-sonnet-5`); SDK ids sourced
    // elsewhere in this stack carry a release-date suffix. Both must be
    // recognised as the same model.
    const subAgents: Record<string, SubAgentTelemetryEntry> = Object.fromEntries(
      AGENT_NAMES.map((n) => [n, { model: 'claude-sonnet-5-20260115' }]),
    );
    const v = checkArmCompliance('sonnet-pin', null, 'claude-sonnet-5', subAgents);
    expect(v.compliant).toBe(true);
  });

  test('version segment is not collapsed — sonnet-4-5 vs sonnet-5 still mismatches', () => {
    // Family-only matching would be too loose: these are different models and
    // an arm that silently ran the wrong version must still VOID.
    const subAgents: Record<string, SubAgentTelemetryEntry> = Object.fromEntries(
      AGENT_NAMES.map((n) => [n, { model: 'claude-sonnet-4-5' }]),
    );
    const v = checkArmCompliance('sonnet-pin', null, 'claude-sonnet-5', subAgents);
    expect(v.compliant).toBe(false);
  });

  // --- Applied-lever gate (task 9) ---
  //
  // Two of the arm's levers — scoped payload and BC-only security — are
  // prompt-CONTENT edits: they change what an agent is TOLD, not which agents
  // dispatch, so a silent no-op produces `sub_agents` telemetry IDENTICAL to a
  // working run. Every check above this point is blind to that failure mode;
  // these tests are the ones that would actually catch it.
  describe('applied-lever gate', () => {
    test('baseline (no lever enabled) is compliant even with null appliedLevers', () => {
      // C2: the runner passes every PR_REVIEW_* var with '' for a disabled
      // lever, so a naive "!== undefined" upstream would have recorded an
      // all-zeros map here instead of null — this proves the gate itself does
      // not treat "no levers configured" as something requiring evidence.
      const v = checkArmCompliance('baseline', null, null, seven, null, null);
      expect(v.compliant).toBe(true);
    });

    test('baseline is compliant even with an empty appliedLevers object', () => {
      const v = checkArmCompliance('baseline', null, null, seven, {}, {});
      expect(v.compliant).toBe(true);
    });

    test('an arm enabling a lever VOIDs when appliedLevers is entirely null', () => {
      const expectedLevers: LeverFlags = { scopedPayload: true };
      const v = checkArmCompliance('scoped', null, null, seven, expectedLevers, null);
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('scopedPayload');
      expect(v.reason).toContain('no applied_levers telemetry was recorded');
    });

    test('an arm enabling a lever VOIDs when that lever\'s key is absent from appliedLevers', () => {
      const expectedLevers: LeverFlags = { routing: true, scopedPayload: true };
      // routing recorded, scopedPayload never even attempted (key absent).
      const applied: AppliedLevers = { routing: 1 };
      const v = checkArmCompliance('routed-scoped', null, null, seven, expectedLevers, applied);
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('scopedPayload');
      expect(v.reason).toContain('no application was recorded');
    });

    test('an arm enabling scopedPayload VOIDs when it applied to 0 files', () => {
      const expectedLevers: LeverFlags = { scopedPayload: true };
      const v = checkArmCompliance('scoped', null, null, seven, expectedLevers, { scopedPayload: 0 });
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('scopedPayload');
      expect(v.reason).toContain('applied to 0 file');
    });

    // C1 — the defect a naive "value === 0 -> VOID" check would miss entirely.
    // maybeTrimSecurityDomains can return exactly 1 in a genuinely half-pulled
    // state: the sub-agent file trims (+1) but the orchestrator's dispatch
    // line never gets rewritten (its regex missed drifted BC heading text),
    // so the sub-agent narrows while the orchestrator still hands back every
    // domain it just removed. That is 1, not 0 — a "non-zero" check reads it
    // as fully compliant.
    test('securityBcOnly of exactly 1 (half-applied) VOIDs, not just 0', () => {
      const expectedLevers: LeverFlags = { securityBcOnly: true };
      const v = checkArmCompliance('bc-security', null, null, seven, expectedLevers, { securityBcOnly: 1 });
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('securityBcOnly');
      expect(v.reason).toContain('expected exactly 2');
    });

    test('securityBcOnly of exactly 2 (fully applied) is compliant', () => {
      const expectedLevers: LeverFlags = { securityBcOnly: true };
      const v = checkArmCompliance('bc-security', null, null, seven, expectedLevers, { securityBcOnly: 2 });
      expect(v.compliant).toBe(true);
    });

    test('a too-high count VOIDs too, not just too-low', () => {
      const expectedLevers: LeverFlags = { agentSet: true };
      const v = checkArmCompliance('agent-set', null, null, seven, expectedLevers, { agentSet: 2 });
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('agentSet');
      expect(v.reason).toContain('expected exactly 1');
    });

    test('every enabled lever fully applied is compliant', () => {
      const expectedLevers: LeverFlags = { agentSet: true, routing: true, scopedPayload: true, securityBcOnly: true };
      const applied: AppliedLevers = { agentSet: 1, routing: 1, scopedPayload: 1, securityBcOnly: 2 };
      const v = checkArmCompliance('lean', null, null, seven, expectedLevers, applied);
      expect(v.compliant).toBe(true);
    });

    test('a lever the arm does NOT enable is ignored even if its recorded count would fail', () => {
      // securityBcOnly=1 would VOID an arm that enabled it — this arm never
      // enabled it at all, so its (nonsensical, but harmless) presence must
      // not affect the verdict.
      const expectedLevers: LeverFlags = { agentSet: true };
      const applied: AppliedLevers = { agentSet: 1, securityBcOnly: 1 };
      const v = checkArmCompliance('agent-set', null, null, seven, expectedLevers, applied);
      expect(v.compliant).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Dispatch evidence (SG-1a) and model-billing evidence (SG-1b).
//
// Both exist because the `sub_agents` roster lies. It undercounts
// nondeterministically — row 1715 recorded ONE agent while emitting seven
// dispatches and billing $1.58 of sub-agent work — so every check built on its
// COUNT is unreliable. `tool_calls->'Agent'` and `model_usage` are not.
// ---------------------------------------------------------------------------

describe('dispatch evidence — tool_calls->Agent, not the sub_agents roster', () => {
  const roster = (n: number, model = 'claude-sonnet-5') =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, { model }]));

  test('an under-counted roster does NOT void when dispatch evidence says all seven ran', () => {
    // The real row-1714 shape: 5 recorded, 7 emitted. Before this, the roster count
    // was the only signal and looked like under-dispatch.
    const v = checkArmCompliance('baseline', null, 'claude-sonnet-5', roster(5), null, null, {
      dispatchCount: 7,
      expectedDispatch: 7,
    });
    expect(v.compliant).toBe(true);
  });

  test('a roster recording ONE agent still passes when seven were emitted — row 1715', () => {
    const v = checkArmCompliance('inverted', null, 'claude-opus-4-8', roster(1, 'claude-opus-4-8'), null, null, {
      dispatchCount: 7,
      expectedDispatch: 7,
    });
    expect(v.compliant).toBe(true);
  });

  test('VOIDs when the arm restricted the roster but seven dispatches were emitted', () => {
    // THE routing failure: prompt written, model ignored it, 7 dispatched anyway.
    // Previously this scored compliant because the roster happened to record fewer.
    const v = checkArmCompliance('routed', null, 'claude-sonnet-5', roster(3), null, null, {
      dispatchCount: 7,
      expectedDispatch: 6,
    });
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('emitted 7');
    expect(v.reason).toContain('expected 6');
  });

  test('VOIDs when the orchestrator dispatched nothing at all', () => {
    const v = checkArmCompliance('baseline', null, null, roster(1), null, null, {
      dispatchCount: 0,
      expectedDispatch: 7,
    });
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('no sub-agent dispatches');
  });

  test('the old roster-based note is suppressed once dispatch evidence exists', () => {
    // The note was a hint standing in for this check; keeping both would double-report.
    const withEvidence = checkArmCompliance('routed', null, null, roster(7), null, null, {
      dispatchCount: 7,
      expectedDispatch: 7,
    });
    expect(withEvidence.compliant).toBe(true);
    expect(withEvidence.note).toBeUndefined();

    const withoutEvidence = checkArmCompliance('routed', null, null, roster(7), null, null);
    expect(withoutEvidence.note).toContain('verify this arm');
  });
});

describe('model billing evidence — model_usage keys', () => {
  const roster = { a0: { model: 'claude-sonnet-5' } };

  test('VOIDs a premium [1m] long-context variant — row 1715 billed one silently', () => {
    const v = checkArmCompliance('inverted', null, null, roster, null, null, {
      modelUsageKeys: ['claude-opus-4-8[1m]', 'claude-sonnet-5'],
      allowedModels: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    });
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('claude-opus-4-8[1m]');
  });

  test('VOIDs a model that billed on an UNATTRIBUTED sub-agent', () => {
    // The per-agent check reads sub_agents, which undercounts — so opus billing on a
    // lost entry is invisible to it. model_usage misses nothing.
    const v = checkArmCompliance('baseline', null, 'claude-sonnet-5', roster, null, null, {
      modelUsageKeys: ['claude-opus-5', 'claude-sonnet-5'],
      allowedModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    });
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('claude-opus-5');
  });

  test('accepts exactly the expected set, including SDK-internal haiku', () => {
    const v = checkArmCompliance('baseline', null, 'claude-sonnet-5', roster, null, null, {
      modelUsageKeys: ['claude-haiku-4-5-20251001', 'claude-opus-5', 'claude-sonnet-5'],
      allowedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    });
    expect(v.compliant).toBe(true);
  });

  test('a dated model id still matches its undated allowed entry', () => {
    const v = checkArmCompliance('baseline', null, null, roster, null, null, {
      modelUsageKeys: ['claude-sonnet-5-20260101'],
      allowedModels: ['claude-sonnet-5'],
    });
    expect(v.compliant).toBe(true);
  });
});
