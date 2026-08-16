# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single pipeline operator is the primary user, working in long operate sessions:
dispatching work items, reading review telemetry, deciding checkpoints, and tuning the
reviewer. Two or three secondary users visit occasionally for three specific jobs —
administering dashboard users, checking what the pipeline costs, and reading review
findings/proposals. Secondary users never open the pipeline code, so any card they are
expected to read must explain itself without it.

Developers whose pull requests get reviewed encounter the product's OUTPUT (review
comments, inline threads on their PRs) but do not use the dashboard.

## Product Purpose

DevOpsWorker takes Azure DevOps work items through a chain of specialized Claude agents
(analysis → planning → coding → review → PR → documentation) and reviews human-created
pull requests automatically. Success means work items become merged, reviewed PRs with
less human effort — without the humans losing the ability to see, gate, and correct what
the AI did. The dashboard is the operating surface for that: state, cost, quality,
integrity, and the approval gates live there.

## Positioning

**Evidence-gated autonomy.** No AI output binds without a verifiable gate: human
checkpoints before plans execute and PRs publish, telemetry that verifies controls
actually bound (not just that they were configured), outcome measurement of what humans
did with AI findings, and prompt changes shipped only with pre-registered, next-cycle
expectations. A neighbouring "AI dev pipeline" can copy the agent chain; it cannot
truthfully claim that every consequential step is measured and gated, because that
discipline is the architecture here, not a feature flag.

## Operating Context

- Work arrives as Azure DevOps work items and pull requests; results return there
  (comments, threads, tags). The dashboard complements ADO, it does not replace it.
- The pipeline runs as Docker services (watcher, dashboard, webhook server) plus
  spawned per-job containers; PostgreSQL holds all state and telemetry.
- A public core composes with a private overlay per deployment: site-specific agents,
  registries, and prompts stay out of the public repo. Anything user-facing in the core
  must make sense without deployment knowledge.
- The operator frequently acts on the dashboard in response to notifications (Discord)
  and returns to ADO or a terminal afterwards — visits are purposeful, not ambient.

## Capabilities and Constraints

- Pipeline stages are composable and gated by checkpoints (tags, PR status, comments).
- PR reviews post evidence-cited findings with inline threads keyed by stable finding
  identity; a nightly sweep classifies what humans said and did about each finding; a
  monthly reflection agent proposes prompt changes that a human approves or rejects on
  the dashboard before anything applies.
- Telemetry (cost, turns, tool calls, models, image provenance) is recorded per run and
  is the authority over any configured intention.
- Constraint: dashboard data must never show a guessed or stale number without saying
  so; "no data yet" is a rendered state, not an empty panel.
- Constraint: the public core carries no customer, tenant, or internal-tool names.

## Brand Commitments

- **The plain-English rule is binding product truth, not style preference:** name the
  thing, never the database field or enum ("the team disputed the finding", not
  `said = 'rejected-wrong'`). Every user-facing string on every surface follows it.
- The current dark amber-on-slate look is incumbent convention, explicitly NOT a brand
  commitment — future design work may evolve it deliberately.

## Evidence on Hand

- Real production telemetry in PostgreSQL (`pr_reviews`, `finding_outcomes`,
  `reflection_proposals`) — every dashboard number is backed by recorded runs.
- A tuning log of measured configuration experiments, including negative results,
  maintained in the deployment's private overlay.
- README with architecture diagram (`README.md`); `docs/extending.md` for the overlay
  contract. No testimonials, benchmarks, or customer claims exist — future surfaces
  must not invent any.

## Product Principles

1. **Evidence before claims.** A number appears only when a recorded run backs it; a
   control is trusted only after telemetry shows it bound.
2. **Humans gate consequence.** Anything that changes what ships or what the AI is
   allowed to say passes a human decision, and that decision is auditable.
3. **Plain English at every surface.** The reader of a card has no access to the code
   that produced it; the card carries the meaning.
4. **Silence is a rendered state.** Empty, loading, degraded, and "not recorded" are
   explicit, sayable states — never blank panels or silently stale numbers.
5. **Generic core, specific overlay.** The public product stays deployable by
   strangers; everything site-specific composes in privately.

## Accessibility & Inclusion

An accessibility standard is required: WCAG AA contrast minimums as the working target
on every surface (the deployment confirmed a required standard, naming AA contrast as
the bar). Existing palette choices that encode this (e.g. the lighter error-text
variant for small text on dark surfaces) are load-bearing, not decorative.
