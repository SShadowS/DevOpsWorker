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
 * Which prompt-content levers an ARM enables — the config side of the
 * comparison, supplied by the matrix definition (Task 7), not read from
 * telemetry. Named to match `AppliedLevers`'s keys 1:1 (see below) so there is
 * exactly one name per lever and no translation table between "what the arm
 * configures" and "what got recorded" — a second naming scheme for the same
 * four things is exactly the kind of transcription hazard this gate exists to
 * remove, not add.
 *
 * Deliberately only the four levers that are prompt-CONTENT edits (an
 * excluded/wrong sub-agent is already caught by the roster check above, and
 * the wrong model by the `expectedModel` check) — `subagentModel` and
 * `subagentToolRule` are recorded in `AppliedLevers` for completeness but are
 * NOT gated here.
 */
export interface LeverFlags {
  agentSet?: boolean;
  routing?: boolean;
  scopedPayload?: boolean;
  securityBcOnly?: boolean;
}

/**
 * Mirrors `AppliedLevers` in `src/pipeline/pr-review-store.interface.ts` — the
 * shape persisted to `pr_reviews.applied_levers` by `collectAppliedLevers` in
 * `src/cli/review-pr.ts`. Kept as a local duplicate rather than an import, the
 * same choice already made for `SubAgentTelemetryEntry` above: this module
 * reads a narrow slice of a row and should not need the full `src/` module
 * graph to typecheck.
 *
 * A key absent means that lever was not enabled this run (its own env var was
 * unset) — never that it was enabled and recorded a zero.
 */
export interface AppliedLevers {
  agentSet?: number;
  routing?: number;
  scopedPayload?: number;
  securityBcOnly?: number;
  subagentModel?: number;
  subagentToolRule?: number;
}

/**
 * The exact file-modification count each lever's hook returns when it fully
 * applies — NOT "non-zero". `maybeTrimSecurityDomains` (`securityBcOnly`) can
 * return 1 in a genuinely half-applied state: the sub-agent file trims (+1),
 * but if the orchestrator's dispatch-line regex fails to match (BC heading
 * text drifted), the second write never happens and no warning fires either —
 * the sub-agent narrows while the orchestrator still hands back every domain
 * it just removed. A "value !== 0" check would wave that straight through as
 * compliant. See task-9 brief correction C1.
 */
const REQUIRED_LEVER_COUNTS: Record<keyof LeverFlags, number> = {
  agentSet: 1,
  routing: 1,
  scopedPayload: 1,
  securityBcOnly: 2,
};

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
 * the sub-agent ROSTER (an excluded agent still ran, or nothing ran at all),
 * when `expectedModel` is given the MODEL each sub-agent ran on, and — when
 * `expectedLevers` is given — that every prompt-CONTENT lever the arm enables
 * (scoped payload, BC-only security narrowing) actually applied. Those two
 * edit what an agent is TOLD, not which agents dispatch, so they produce
 * `sub_agents` telemetry IDENTICAL whether the injected instruction changed
 * the agent's behaviour or silently no-opped — the roster and model checks
 * alone cannot see that gap. `expectedLevers`/`appliedLevers` is what closes
 * it (an EARLIER version of this doc proposed asserting the hooks' `[eval]`
 * log lines instead; rejected — `spawnContainer` uses `stdout: 'inherit'` and
 * returns only an exit code, so capturing them means changing a function the
 * production watcher shares, and string-matching log text is fragile in
 * exactly the way this plan keeps getting bitten by).
 *
 * `expected === null` means the arm does not pin an exact roster (baseline, or
 * a routed arm whose roster is legitimately diff-dependent).
 *
 * `expectedModel === null` means the arm does not pin a model for its
 * sub-agents — skip the model check entirely.
 *
 * `expectedLevers === null` or an object with every flag false/absent means
 * the arm enables no prompt-content lever (baseline) — skip the lever check
 * entirely, regardless of what `appliedLevers` holds. For every lever the arm
 * DOES enable: `appliedLevers` being null/undefined outright, the key being
 * absent, or the recorded count not being EXACTLY the value that lever's hook
 * returns when fully applied (see `REQUIRED_LEVER_COUNTS`) all VOID the arm —
 * never just "value is 0". A too-high count VOIDs too; the hooks' contracts
 * name one specific fully-applied count each, not a floor.
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
  expectedLevers: LeverFlags | null = null,
  appliedLevers: AppliedLevers | null = null,
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

  // Prompt-content levers (scoped payload, BC-only security) — the gap the
  // roster/model checks above cannot see (see the SCOPE doc above). Only the
  // levers THIS arm enables are checked; an arm that enables none (baseline)
  // is unaffected no matter what `appliedLevers` holds — bias every ambiguous
  // case toward VOID, but "no lever configured" is not ambiguous.
  const enabledLevers = (Object.keys(REQUIRED_LEVER_COUNTS) as (keyof LeverFlags)[])
    .filter((lever) => expectedLevers?.[lever]);

  if (enabledLevers.length > 0) {
    if (!appliedLevers || typeof appliedLevers !== 'object') {
      return {
        arm: armName,
        compliant: false,
        actual,
        reason: `arm enables ${enabledLevers.join(', ')} but no applied_levers telemetry was recorded`,
      };
    }
    for (const lever of enabledLevers) {
      const required = REQUIRED_LEVER_COUNTS[lever];
      const value = appliedLevers[lever];
      if (value === undefined) {
        return {
          arm: armName,
          compliant: false,
          actual,
          reason: `lever ${lever} was enabled but no application was recorded`,
        };
      }
      // Exact match, not "!== 0" — see REQUIRED_LEVER_COUNTS' doc (correction
      // C1): securityBcOnly can return 1 in a genuinely half-applied state,
      // and a too-high count is just as much a sign something is wrong as a
      // too-low one.
      if (value !== required) {
        return {
          arm: armName,
          compliant: false,
          actual,
          reason: `lever ${lever} was enabled but applied to ${value} file(s), expected exactly ${required}`,
        };
      }
    }
  }

  const note = actual === 7 && armName !== 'baseline'
    ? `ran all 7 sub-agents — verify this arm's instruction took effect`
    : undefined;

  return { arm: armName, compliant: true, actual, ...(note ? { note } : {}) };
}
