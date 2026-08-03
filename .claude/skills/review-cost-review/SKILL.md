---
name: review-cost-review
description: >-
  Weekly analysis of PR-reviewer runs to decide whether the current cost/quality
  configuration is still right. Use when asked to review reviewer cost, check how the
  reviewer is performing, analyse recent reviews, tune the reviewer, decide whether a
  model or effort setting is working, or when a scheduled cost review comes due. Also
  use before changing any reviewer model, effort or prompt setting — it carries the
  measurement traps that make naive readings wrong.
---

# Weekly PR-reviewer cost review

Decide whether the current configuration is still the right cost/quality trade.

**Read the tuning log first**: `private/internal-docs/pr-review-tuning-log.md`. It holds the
current configuration, every combination already tested, and conclusions that are NOT derivable
from the database. Re-testing something already settled is the main waste this skill exists to
prevent. Append to it at the end.

## The one metric that decides

**Cost per read-band item**, where read-band = `critical` + `major`.

Not total findings, not the verdict, not raw cost. Measured behaviour: readers go to Critical and
Major, decide whether to continue, and largely ignore the overall rating. A config that halves the
bill while halving read-band items has bought nothing.

This distinction is not cosmetic — it reversed a recommendation once. Three cheap configurations
looked like wins on raw cost and were **no cheaper per actionable item** than the expensive control,
while a fourth was 45% cheaper. Raw cost ranking hides that completely.

```sql
SELECT date_trunc('week', created_at)::date AS week, count(*) AS reviews,
  round(avg(cost_usd)::numeric,2) AS avg_cost,
  round(avg((SELECT count(*) FROM jsonb_array_elements(findings_list) f
             WHERE f->>'severity' IN ('critical','major')))::numeric,2) AS avg_read_band,
  round(avg(cost_usd)::numeric / nullif(avg((SELECT count(*) FROM jsonb_array_elements(findings_list) f
             WHERE f->>'severity' IN ('critical','major'))),0)::numeric, 2) AS cost_per_item
FROM pr_reviews
WHERE findings_list IS NOT NULL AND cost_usd IS NOT NULL
  AND created_at > now() - interval '8 weeks'
GROUP BY 1 ORDER BY 1;
```

Compare `cost_per_item` and `avg_read_band` against the baselines in the tuning log. A drift in
`avg_read_band` toward the low end is the signal that a cost setting has started costing findings.

## Before trusting ANY number — the integrity checks

Every one of these has produced a confidently wrong conclusion on this project.

**1. Which models actually billed.** Never assume the configured model ran.

```sql
SELECT id, (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_each(model_usage) AS m(k,v)) AS models
FROM pr_reviews WHERE created_at > now() - interval '7 days' ORDER BY id DESC LIMIT 20;
```

An unexpected model means the run is void, not interesting. Watch for:
- a **more expensive** model than configured — sub-agent model pins have been silently ignored
- a `[1m]` suffix — the long-context premium tier at different pricing, easy to miss
- **rate-limit fallback**: model substitution correlates with running on the OAuth subscription. Do
  not run model-sensitive comparisons on OAuth; the API key has no throttle and no fallback.

**2. Dispatch count comes from `tool_calls->'Agent'`, never from `sub_agents`.** The `sub_agents`
roster undercounts nondeterministically — one run recorded ONE agent while emitting seven dispatches
and billing real sub-agent work. A conclusion built on the roster count is worthless.
This is how a prompt lever was found to have never bound: every "routed" run emitted the full seven.

**3. `applied_levers` proves a prompt was MODIFIED, never that the model OBEYED it.** A lever can
record as applied while changing nothing. Confirm the intended behaviour separately.

**4. The verdict (`recommendation`) is display-only.** Verified: nothing gates on it. Do not treat a
verdict change as a quality regression on its own.

## Comparing findings across runs

**Cluster by DEFECT, not by title.** The same defect gets wildly different titles run to run
("Backoff sleeps while a database write is still uncommitted" / "The new retry pause runs while the
database transaction is still open" / "Sleep runs inside the open posting transaction"). Exact or
fuzzy title matching will report phantom misses.

Pull `file` + `severity` + `title` for critical/major across the runs being compared, group by file,
then read them. Ten minutes of reading beats any automatic matcher at this scale.

**Severity labels are unstable.** The same defect has been graded `critical` in three runs and
`major` in a fourth — same config, same PR. Never conclude from a single run's severity. A config
reporting zero criticals may simply be less inclined to escalate while finding exactly the same
things.

**A finding present in one run and absent in another is usually noise.** A critical finding has
appeared in only 1 of 3 identical runs. Treat n=1 differences as unmeasured, not as evidence.

## Sample sizes that mean something

- **Cost**: stable. Same-config repeats vary ±8%. n=2 separates a >20% effect.
- **Quality**: unstable. Detecting a 15-point recall drop needs four figures of runs. **Do not try.**
  Use consensus over runs already banked instead — cluster findings across all runs on one PR, treat
  what appears in ≥50% as real, and check whether a candidate config finds those. It costs nothing
  and reuses sunk spend.

## The weekly ritual

1. Read the tuning log — current config, open questions, what is already settled.
2. Run the trend query above. Compare `avg_read_band` and `cost_per_item` to the recorded baseline.
3. Run the model-integrity query. Any unexpected model → investigate before reading anything else.
4. Spot-check 2-3 reviews' `findings_list` for whether read-band items look actionable.
5. If something looks off, cluster by defect across recent runs on the same PR before concluding.
6. **Append to the tuning log**: what you observed, what you concluded, what you ruled out. Include
   negative results — "tested X, no effect" is the most reusable kind of entry and the easiest to
   lose.

## Changing a setting

Any config change must be verified to BIND, not just to be set. Three separate controls on this
project were forwarded correctly, documented, and read by nobody.

- Verify by **effect**, not by flag. Reasoning effort, for example, is not persisted anywhere — its
  binding was confirmed by orchestrator output tokens falling far outside the known band for the
  previous setting. Establish the expected band BEFORE the run so the reading cannot be fitted after.
- Prefer a reversible switch (env var) and record the revert in the tuning log.
- Rebuild the spawned-container image after changing anything under `src/` — compose services pick up
  changes while spawned containers silently run stale code.
