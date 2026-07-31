// scripts/pr-review-eval/compliance.ts
export interface ComplianceVerdict {
  arm: string;
  compliant: boolean;
  actual: number;
  reason?: string;
  note?: string;
}

/**
 * Decide whether an arm's run actually applied its configuration.
 *
 * Routing and payload scoping are prompt instructions, so the orchestrator can
 * ignore them. A cell whose configuration never took effect must be reported as
 * VOID rather than scored — otherwise "the lever did nothing" and "the lever was
 * never pulled" are indistinguishable in the results.
 *
 * `expected === null` means the arm does not pin an exact roster (baseline, or a
 * routed arm whose roster is legitimately diff-dependent).
 */
export function checkArmCompliance(
  armName: string,
  expected: string[] | null,
  subAgents: Record<string, unknown> | null,
): ComplianceVerdict {
  if (!subAgents || typeof subAgents !== 'object') {
    return { arm: armName, compliant: false, actual: 0, reason: 'no sub_agents telemetry recorded' };
  }

  // `sub_agents` is a JSONB object keyed by agent name (`jsonb_typeof` = 'object').
  // An array shape means something upstream wrote malformed telemetry —
  // Object.keys() on an array yields numeric-index strings that would otherwise
  // pass the "unexpected agent" check below by coincidence and look like real data.
  if (Array.isArray(subAgents)) {
    return { arm: armName, compliant: false, actual: 0, reason: 'sub_agents telemetry is an array, not an object — malformed' };
  }

  const actualNames = Object.keys(subAgents);
  const actual = actualNames.length;

  // Telemetry present but empty means the review ran and recorded a row, but the
  // orchestrator never actually dispatched a sub-agent — the worst case this
  // check exists to catch: a run that costs money and measures nothing, yet
  // would otherwise look identical to "no violations" under the checks below
  // (an empty set has no unexpected members, vacuously).
  if (actual === 0) {
    return { arm: armName, compliant: false, actual: 0, reason: 'sub_agents telemetry is present but empty — no sub-agent actually ran' };
  }

  if (expected !== null) {
    const unexpected = actualNames.filter((n) => !expected.includes(n));
    if (unexpected.length > 0) {
      return {
        arm: armName,
        compliant: false,
        actual,
        reason: `ran agents outside its configured set: ${unexpected.join(', ')}`,
      };
    }
  }

  const note = actual === 7 && armName !== 'baseline'
    ? `ran all 7 sub-agents — verify this arm's instruction took effect`
    : undefined;

  return { arm: armName, compliant: true, actual, ...(note ? { note } : {}) };
}
