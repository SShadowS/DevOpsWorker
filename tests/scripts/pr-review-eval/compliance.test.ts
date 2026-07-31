import { describe, test, expect } from 'bun:test';
import { checkArmCompliance, type SubAgentTelemetryEntry } from '../../../scripts/pr-review-eval/compliance.ts';

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
});
