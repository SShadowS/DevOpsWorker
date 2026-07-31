import { describe, test, expect } from 'bun:test';
import { checkArmCompliance } from '../../../scripts/pr-review-eval/compliance.ts';

describe('checkArmCompliance', () => {
  const seven = Object.fromEntries(
    ['code-review-validator', 'code-quality-assessor', 'security-edge-case-analyzer',
     'al-performance-analyzer', 'al-architecture-analyzer', 'al-error-pattern-analyzer',
     'al-integration-analyzer'].map((n) => [n, {}]),
  );

  test('baseline with all seven is compliant', () => {
    const v = checkArmCompliance('baseline', null, seven);
    expect(v.compliant).toBe(true);
    expect(v.actual).toBe(7);
  });

  test('no-cqa arm that still ran code-quality-assessor is VOID', () => {
    const expected = Object.keys(seven).filter((n) => n !== 'code-quality-assessor');
    const v = checkArmCompliance('no-cqa', expected, seven);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('code-quality-assessor');
  });

  test('routed arm that dispatched all seven is flagged, not silently accepted', () => {
    const v = checkArmCompliance('routed', null, seven);
    expect(v.compliant).toBe(true);
    expect(v.note).toContain('all 7');
  });

  test('missing telemetry is VOID, never assumed compliant', () => {
    const v = checkArmCompliance('routed', null, null);
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
    const v = checkArmCompliance('baseline', null, {});
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
    expect(v.reason).toContain('no sub-agent actually ran');
  });

  test('empty sub_agents object is VOID even under an arm with a pinned roster', () => {
    const expected = Object.keys(seven).filter((n) => n !== 'code-quality-assessor');
    const v = checkArmCompliance('no-cqa', expected, {});
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
  });

  test('array-shaped sub_agents (malformed telemetry) is VOID, not read as agent names', () => {
    // jsonb_typeof(sub_agents) is documented to always be 'object'; if some
    // upstream defect ever wrote a JSON array instead, Object.keys() on it
    // would yield numeric-index strings ('0', '1', ...) that are not real
    // agent names but would otherwise slip through as "actual" data.
    const v = checkArmCompliance('baseline', null, ['a', 'b', 'c'] as unknown as Record<string, unknown>);
    expect(v.compliant).toBe(false);
    expect(v.actual).toBe(0);
    expect(v.reason).toContain('array');
  });
});
