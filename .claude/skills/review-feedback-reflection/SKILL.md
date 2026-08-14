---
name: review-feedback-reflection
description: >-
  Monthly reflection on human responses to the PR reviewer's findings. Use when asked to
  learn from review feedback, analyse why humans rejected or disputed findings, turn
  rejected-wrong / wontfix outcomes into prompt improvements, or when a scheduled
  reflection comes due. Also use before adding any "the team said we were wrong" fact to
  a reviewer prompt — it carries the verification and clustering rules that keep one-off
  or mistaken rejections out of the prompts.
---

# Monthly review-feedback reflection

Turn what humans said about the reviewer's findings into verified prompt improvements.

**The data already exists — never scrape Azure DevOps comments.** A nightly sweep
classifies every settled read-band finding into the `finding_outcomes` table: `said` is
what the team said (`fixed` / `rejected-wrong` / `rejected-wontfix` / `deferred` /
`ignored` / `unclear`), grounded in a verbatim `said_quote` from a human comment; `did`
is what the branch did afterwards, judged from the post-review diff. It reads the whole
PR discussion, not just the finding's thread, so "replied elsewhere" is already handled.

Coverage caveats before you read any number: only critical+major findings, only settled
PRs; `said` is null when nobody wrote a word or the sweep hasn't reached the row yet.
Say what fraction of the month's rows carry a `said` label — conclusions rest on that
slice, not on "the month".

## Step 1 — pull the learning set

```sql
SELECT o.pr_id, o.repo_key, o.severity, o.title, o.file,
       o.said, o.said_quote, o.said_confidence, o.did, o.lead_time_mins
FROM finding_outcomes o
WHERE o.first_raised_at >= now() - interval '35 days'
  AND o.said IN ('rejected-wrong', 'rejected-wontfix', 'deferred')
  AND o.said_model_verified IS NOT FALSE
ORDER BY o.said, o.first_raised_at DESC;
```

For each row, recover the full finding body from the review that raised it — the quote
alone is not enough to judge the dispute:

```sql
SELECT r.id, f->>'title' AS title, f->>'body' AS body
FROM pr_reviews r, jsonb_array_elements(r.findings_list) f
WHERE r.pr_id = $PR AND f->>'file' IS NOT NULL;
```

(Match rows by the finding key — sha1 of normalised file + title, `findingKey()` in
`src/sdk/ado/finding-key.ts` — not by title text, which rewords between runs.)

## Step 2 — adjudicate every dispute. This is the step, not a formality.

**A human rejection is a claim, not a verdict.** The reflection's output is only as good
as this step, and skipping it writes the team's mistakes into the prompt. For each
rejected finding, decide with evidence — never from the quote alone:

- **reviewer-wrong** — the rejection holds up. Platform-behaviour claims (units,
  defaults, implicit conversions, what an API does) must be checked against
  documentation or a real measurement (the `bc-measure` skill, where available, runs
  real AL in a container) before you accept that the reviewer "fabricated" anything. The human's
  "it's in the documentation" is a pointer, not proof — follow it.
- **human-wrong** — the finding was right and the rejection doesn't hold. This is a
  different lesson: the finding failed to *convince*. Fix its evidence presentation,
  not its detection.
- **both-defensible** — a policy or taste split (e.g. "matches the sibling feature").
  Candidate for severity calibration, never for suppression.

Domain facts you cannot check from the code ("table X only accepts type Y") may be
accepted as team knowledge — recorded with attribution, still subject to Step 3.

## Step 3 — cluster, then apply the n-rule

Group adjudicated rejections by failure class (missing domain fact, unverified platform
claim, missing release-state context, calibration on special-purpose code, …).

**A class earns a prompt change only when it has ≥2 occurrences on ≥2 different PRs, or
one occurrence whose adjudication actually verified the reviewer factually wrong.**
"Checkable in principle" is not checked — if you didn't run the check, the occurrence
counts as unverified. Everything below the bar goes into the watch ledger in the tuning
log (`private/internal-docs/pr-review-tuning-log.md`), where it can mature into a class
next cycle. Verdict instability is measured on this project; n=1 is noise until proven
otherwise.

## Step 4 — route each fix, and cap the batch

| Kind of lesson | Where it goes |
|---|---|
| Generic process rule (evidence bar, release-state check, calibration) | `src/agents/pr-reviewer/CLAUDE.md` — public repo, so nothing site-specific |
| Domain fact the reviewer can't derive (site data models, team conventions) | `private/agents/pr-reviewer/CLAUDE.append.md` — the overlay append mechanism |
| Sub-agent-specific rule | the matching file under `src/agents/pr-reviewer/.claude/agents/` |

Write every rule as a positive instruction or a gate ("verify platform claims against
documentation before posting them as Critical"; "X has its own default-dimension
table") — negative framing ("never flag…", "don't report…") is measured on this project
to suppress far more than intended.

**Ship at most 3 changes per cycle, and at most 1 severity-calibration change.** A batch
that edits the main prompt, four sub-agents and the severity table at once cannot be
attributed by the next cost review — if everything changes, nothing is measurable. Rank
by adjudicated impact; the rest waits a month. "We want it all shipped today" is how the
unmeasurable batch happens.

## Traps — each one has already produced a wrong conclusion here

- **`ignored` is not evidence the finding was wrong, and not evidence of severity
  over-assignment.** The ignore rate is half a scheduling artifact: 94% of findings
  posted <30 min before merge are ignored, 37% when >24 h. Split by `lead_time_mins`
  before reading any ignore number, and never tighten severity from ignore rates alone.
- **ADO thread status is worthless** — branch policy forces every thread to "fixed" at
  merge, including the bot's own.
- **The bot posts under a human identity.** Bot-vs-human is decided structurally (the
  `<!-- ai-finding:… -->` marker, the stale-notice prefix), never by author name.
- **Other pipeline agents write PR comments under that same identity.** A `said_quote`
  that reads like the pipeline talking to itself ("I will await the human review…") is
  the coder agent, not the team — a sweep misclassification. Log it to the tuning log
  for the classifier, and never learn from it.
- **Prompt levers frequently do not bind.** Record the expected effect in the tuning
  log BEFORE shipping (e.g. "class-X rejections: 3 this month → 0 next"), so next
  cycle's reading cannot be fitted after the fact.
- **Rebuild the spawned-container image** (`pwsh private/deploy/docker-build.ps1`) —
  compose services pick up prompt changes while spawned review containers silently run
  the stale image. No error; the change just never runs.

## Step 5 — log, verify, close the loop

1. Append to the tuning log: the labelled learning set, each adjudication verdict with
   its evidence, the clusters, what shipped, what went to the watch ledger, and the
   expected effect of each change. Negative results ("cluster X: human was right, no
   fixable class") are entries too — they stop next month's rerun.
2. Acceptance: replay one PR whose finding you addressed (the `acceptance-run` skill,
   NO-POST mode) and confirm the finding is now absent, downgraded, or evidence-gated.
3. Next cycle starts by comparing this cycle's expected effects against what happened.

Cadence: monthly, manually or scheduled. Expect ~10–20 disputed findings per month —
sized for real adjudication, not for skimming.
