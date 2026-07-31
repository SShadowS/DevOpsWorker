// scripts/pr-review-eval/compliance.ts
export interface ComplianceVerdict {
  arm: string;
  compliant: boolean;
  actual: number;
  reason?: string;
  note?: string;
}

/**
 * Minimal per-sub-agent telemetry shape this check reads. A real entry (see
 * `SubAgentUsage` in `src/types/pipeline.types.ts`) also carries `turns`,
 * `tokens`, `toolCalls`, and `apportionedCostUsd` — none of that matters here.
 */
export interface SubAgentTelemetryEntry {
  model?: string;
}

/**
 * Strip a trailing `-YYYYMMDD` date suffix so SDK-reported model ids compare
 * equal to the bare ids assistant messages carry.
 *
 * `src/sdk/agent-stream.ts` records `entry.model ??= message.message?.model`,
 * which reports bare ids like `claude-sonnet-5`; model ids sourced elsewhere in
 * this stack carry a release date suffix. Never collapses the version segment:
 * `sonnet-4-5` vs `sonnet-5` names a real, distinct model and must still
 * mismatch — family-only matching would be too loose to catch an arm that
 * silently ran the wrong version.
 */
function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

/**
 * Decide whether an arm's run actually applied its configuration.
 *
 * Routing and payload-scoping directives are prompt instructions the
 * orchestrator can ignore, so a cell whose configuration never took effect
 * must be reported VOID rather than scored — otherwise "the lever did
 * nothing" and "the lever was never pulled" are indistinguishable in the
 * results.
 *
 * SCOPE — read this before trusting a `compliant: true`. This check verifies
 * the sub-agent ROSTER (an excluded agent still ran, or nothing ran at all)
 * and, when `expectedModel` is given, the MODEL each sub-agent ran on. It does
 * **not** verify prompt-CONTENT levers (scoped payload, BC-only security
 * narrowing) — those produce IDENTICAL `sub_agents` telemetry whether the
 * injected instruction actually changed the agent's behaviour or silently
 * no-opped. A `compliant: true` verdict means "the right agents ran, on the
 * right model" — not "every lever this arm configures took effect". (That gap
 * is closed separately, runner-side, by asserting each hook's `[eval]` log
 * line appears in the container output — not this function's job.)
 *
 * `expected === null` means the arm does not pin an exact roster (baseline, or
 * a routed arm whose roster is legitimately diff-dependent).
 *
 * `expectedModel === null` means the arm does not pin a model for its
 * sub-agents — skip the model check entirely.
 *
 * MODEL-CHECK CAVEAT: `agent-stream.ts` records only the model of the FIRST
 * assistant message attributed to a sub-agent (`entry.model ??= ...`). A
 * sub-agent that started on the pinned model and switched mid-run would still
 * read as compliant here — no such mechanism exists in this stack today, but
 * this check proves "started on the right model", not "every turn ran on it".
 */
export function checkArmCompliance(
  armName: string,
  expected: string[] | null,
  expectedModel: string | null,
  subAgents: Record<string, SubAgentTelemetryEntry> | null,
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

  if (expectedModel !== null) {
    const expectedNorm = normalizeModel(expectedModel);
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const name of actualNames) {
      const model = subAgents[name]?.model;
      if (!model) {
        missing.push(name);
      } else if (normalizeModel(model) !== expectedNorm) {
        mismatched.push(`${name}=${model}`);
      }
    }

    // Live evidence: 490/490 sub-agent entries in pr_reviews carry a non-null
    // model. Absence signals upstream telemetry breakage, not a benign gap —
    // VOID on its own, even before checking whether the model itself matches.
    if (missing.length > 0) {
      return {
        arm: armName,
        compliant: false,
        actual,
        reason: `entry lacks model telemetry: ${missing.join(', ')}`,
      };
    }
    if (mismatched.length > 0) {
      return {
        arm: armName,
        compliant: false,
        actual,
        reason: `ran on the wrong model (expected ${expectedModel}): ${mismatched.join(', ')}`,
      };
    }
  }

  const note = actual === 7 && armName !== 'baseline'
    ? `ran all 7 sub-agents — verify this arm's instruction took effect`
    : undefined;

  return { arm: armName, compliant: true, actual, ...(note ? { note } : {}) };
}
