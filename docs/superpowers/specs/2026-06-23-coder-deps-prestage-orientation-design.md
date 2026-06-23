# Coder Deps Pre-stage + Multi-Repo Orientation — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Placement:** Overlay + (no public-core changes). Continia-CLI-specific.

## Problem

On multi-companion BC repos (e.g. Document Output, whose Cloud app depends on
Core + Delivery Network), the coder burns ~half its turn budget (the documented
case: 145 of 235 tool calls, ~half the 200-SDK-turn budget) on a self-inflicted
deps/deploy battle. Forensic analysis (`2026-06-23-coder-deps-turn-budget-analysis.md`)
traced it to three gaps:

1. **Symbols are not pre-staged.** `env-provision` runs `continia deps install`
   (installs deps **on the env**) but **not** `continia deps download` (symbols →
   workspace `.alpackages`). So the coder's **local** compile hits "missing
   symbols" and runs `deps download` itself.
2. **No build scoping.** `continia deploy <env> DocumentOutput/Cloud` with sibling
   `Core/`, `DeliveryNetwork/` **source** present makes the CLI resolve them as
   `workspace-local` and **recompile them from source** — the coder then
   brute-forces `--workspace-root` permutations.
3. **No explicit "what is what" orientation.** The coder has only a vague core
   note ("other directories are read-only references"). It doesn't name the
   companions, say "never compile/deploy them," or that `.dependencies/` folders
   are normal shipped code (not a symbol cache).

`continia deps download` already does exactly the right thing (transitive symbol
closure → `.alpackages`). The fix is to **use it (pre-stage) + scope the build +
orient the coder** — not to change the CLI dependency resolver.

The user already maintains the correct orientation in a **separate manual-coding
file** `U:\Git\DO.Support\CLAUDE.md` (Repository Structure, ".dependencies are
normal code", LSP-first, az recipes). The pipeline coder uses a *different*
CLAUDE.md (core `src/agents/coder/CLAUDE.md` + overlay `CLAUDE.append.md`) and
never received that orientation — the two diverged.

## Decisions (made during brainstorming)

- **Keep the companion source** in the workspace — it is intentional; the coder
  reads dependency source to make good decisions.
- **All changes live in the overlay + the Continia CLI** (the public DevOpsWorker
  core has no `continia` concept and stays untouched).
- **Copy the missing orientation sections** from `DO.Support/CLAUDE.md` into the
  overlay coder append now (single-source sync is deferred; accepted drift).
- **`--workspace-root` does not hinder reading.** It only scopes what the CLI
  *compiles/deploys*; the agent still reads companions via Grep/Glob/Read/LSP.

## Design

### Component 1 — COMPLETE, FATAL pre-stage (`private/pipeline/env-provision.ts`)

In the existing loop that runs `deps.installDeps(...)` over the Cloud + Test
`appPaths` (the block guarded by `!credentials`, which already explains it makes
"publish work first-try"), add a `deps.downloadDeps(cliPath, env.envId, appPath,
config.paths.sessionRoot)` call for each app path, right after `installDeps`.
`downloadDeps` already exists in `private/sdk/continia-cli.ts` (wraps
`continia deps download <env> <appPath>` → symbols into `<appPath>/.alpackages`).

Result: when the coder runs its **local** `continia compile`/`deploy`, the
transitive symbol closure is already in `.alpackages` — no "missing symbols", no
self-run `deps download`, no recompile of companions.

- **FATAL on failure (not a silent warning).** A partial/failed pre-stage hands
  the coder a broken env → it hits missing symbols mid-run and re-enters the
  ~145-call death spiral. So a `downloadDeps` failure **throws** and fails the
  env-provision stage (which is retryable via the `resume` path), matching the
  project's fail-loud posture (cf. the alc `validateAlcBinary` guard). This is a
  feature: it **surfaces deps/version bugs at provision time** — loud, cheap,
  before the agent ever runs — instead of letting the agent discover them at
  $/token. If the toolchain genuinely can't resolve a dependency, that is a
  toolchain bug to fix, not the agent's job.
- **Complete closure — Cloud AND Test.** The pre-stage must cover **both** apps,
  including the Test app's test-framework + Microsoft baseline symbols (the
  forensic run died fighting exactly those). Because the pre-stage is fatal, if
  `deps download` for the Test app cannot pull a test-framework symbol (the
  too-strict deps version-validation in §"Version-validation", below), env-provision
  fails loud → forcing that CLI bug to be fixed rather than deferred.
- **Idempotent on resume:** stays inside the same `!credentials` guard as
  `installDeps`, so a resumed (already-provisioned) env skips it.
- **Staleness caveat:** the pre-stage is correct at coder start. If the coder
  later edits the **target app's** own dependency requirements, it must re-stage —
  see the recovery path in Component 3 (a working, scoped `deps download`).

### Component 2 — Overlay coder orientation (`private/agents/coder/CLAUDE.append.md`)

First **diff against the core `src/agents/coder/CLAUDE.md`** and add only what is
genuinely missing (core already has the generic "modify only the target repo /
other dirs are read-only references" note and LSP-first guidance — do not
duplicate). Add these Continia-specific sections (sourced from
`DO.Support/CLAUDE.md`, adapted so they fit every overlay repo, not just DO):

1. **Repository Structure / "what is what".**
   - The workspace contains your **target extension** (named in your task prompt)
     plus its **dependency companion repos** cloned as siblings at the session root.
   - A short map of the Continia extensions and what each is (Core = foundation;
     Delivery Network = e-doc delivery; Document Capture = capture/recognition;
     Document Output = output/email), so the coder understands the dependency graph.
   - **The rule:** read the companion source freely to inform your decisions, but
     **NEVER compile / deploy / `--with-deps` a companion** — they are
     dependencies, their compiled **symbols are pre-staged in `.alpackages`**. You
     only build **your target app**.

2. **`.dependencies/` folders are normal code** (≈ verbatim from DO.Support):
   not a symbol cache, not read-only, not a separate extension — regular compiled
   shipped AL source belonging to the surrounding extension. Do not flag changes
   to `.dependencies/` as suspicious or architecturally wrong.

3. **Build-scoping rule** (prose is *support*, not the mechanism — see Component
   2b). Read companion source freely; build only your target app; the build is
   scoped to it via `--workspace-root`.

The append already owns the authoritative env workflow (deploy with
`--allow-downgrade`, Definition-of-Done gates) — these sections slot in alongside
it; the existing "you don't need deps download" claim becomes true once Component
1 ships.

### Component 2b — ENFORCE `--workspace-root` (not prose)

The forensic run proved the agent **ignores prose guidance under pressure** (it
had a rich workflow and still brute-forced `--workspace-root` permutations + hand-
copied files). So `--workspace-root` must reach the build as the **command the
agent is given / runs**, not a request:

- **Inject it into the command** the agent is handed. The overlay append's
  deploy/compile snippets must show `continia deploy <env> <target>/Cloud
  --workspace-root <target>/Cloud --json` (and Test) — the literal, correct command.
- **Hard guard (preferred): a PreToolUse hook** (overlay-side, like the existing
  ci-waiter hook) that intercepts `continia compile`/`deploy` Bash calls and
  **forces** `--workspace-root` to the target app dir if absent. This removes the
  choice from the LLM entirely. Decide hook-vs-injected-command in the plan;
  hook is the stronger guarantee, injected-command is the cheaper floor — do at
  least the injected command, add the hook if low-cost.
- *Mechanism note:* `--workspace-root` scopes the **continia CLI's `discoverApps`**
  (which walks the workspace root) — NOT `alc` (which only reads
  `--packagecachepath`/`.alpackages`). Pinning it stops the CLI from discovering
  sibling companion source as a buildable app. **Verify this empirically in the
  plan** (a scoped deploy with siblings present must NOT rebuild them).

### Component 3 — Deterministic deploy recipe + baseline alignment

The installed-baseline version conflict + AppSourceCop baseline (AS0003) were the
**majority** of the wasted turns (>170). They are NOT deferrable — without them the
run survives the sibling fight then dies on publish. Two parts:

- **`continia-deploy` skill (CLI repo, synced to overlay):** encode the
  deterministic recipe the agent currently rediscovers by trial-and-error — the
  installed-baseline → `--allow-downgrade` (or version-bump) decision, in
  dependency order, and the AppSourceCop-baseline handling. A single known recipe
  instead of N permutations.
- **env-provision baseline alignment (`env-provision.ts`):** since env-provision
  already deploys the product-app baseline from `master`, also ensure the
  **AppSourceCop baseline cache** is present/consistent so the agent never hits
  AS0003. (Confirm the exact mechanism in the plan.)

### Version-validation (CLI repo) — now in scope

The deps **version-validation** that rejected downloadable test-framework symbols
("rejects 28.x when 25.x requested") becomes load-bearing: the fatal Component-1
pre-stage of the **Test** app will fail loud if it can't download those symbols.
Fix the validation so the legitimate symbol versions download (ties to
`project_deps_wrong_major_28v29`). Also provides the coder's **staleness recovery**
path (a working, `--workspace-root`-scoped `deps download`) for when it edits the
target's deps mid-run.

### What stays in the public core

Nothing changes in `src/agents/coder/`. The core keeps its generic, CLI-agnostic
coder prompt + the deploy `buildPrompt` (a generic env-CLI fallback). All
`continia`-specifics — `--workspace-root`, `deps download`, the PreToolUse deploy
guard, named companions, the deploy recipe — live in the overlay + the Continia
CLI repo. Public DevOpsWorker core untouched.

## Testing

- **`private/tests/pipeline/env-provision*.test.ts`:** assert `downloadDeps` is
  called once per app path (Cloud + Test) after `installDeps`, and that a
  `downloadDeps` rejection **fails the stage** (throws, surfaced as a stage error —
  NOT swallowed).
- **PreToolUse deploy guard (if built):** unit-test that a `continia compile`/
  `deploy` command without `--workspace-root` gets it injected (to the target app
  dir), and one that already has it is left unchanged.
- **Version-validation (CLI repo):** test that the previously-rejected
  test-framework symbol version now resolves/downloads.
- **Append render:** the overlay `CLAUDE.append.md` contains the new section
  anchors (Repository Structure, `.dependencies`, `--workspace-root`), and the
  injected deploy command shows `--workspace-root`. `bun run typecheck` + overlay
  suite green.
- **Empirical scoping check (plan):** a scoped `continia deploy --workspace-root
  <target>/Cloud` with sibling companion source present must NOT rebuild siblings.
- **Manual smoke:** a multi-companion WI run reaches local compile → publish →
  test in far fewer turns, with no companion recompile and no AS0003 fight.

## Non-goals (deferred)

- **CLI dependency-resolver behavior change** — making `continia deps`/`deploy`
  intrinsically ignore sibling companion source even WITHOUT `--workspace-root`.
  `--workspace-root` scoping handles our case; the deeper resolver change is a
  separate task. (Verify `--workspace-root` is sufficient in the plan first.)
- **Single-source sync** of `DO.Support/CLAUDE.md` ↔ overlay (chosen: copy now).
- **`maxTurns` bump** — a symptom-level safety net; only if needed after this fix.

(Previously deferred but now IN scope per the Gemini review: the fatal pre-stage,
the installed-baseline/AppSourceCop deploy recipe, and the deps version-validation
fix — see Components 1, 3, and "Version-validation".)

## Open question (resolve in plan)

The overlay `CLAUDE.append.md` is shared across overlay repos (document-output,
delivery-network, continia-banking…). The Repository Structure section must be
framed **generically** ("your target is named in your prompt; the siblings are
dependency source") rather than hardcoding DO-only paths — the extension-map prose
can stay (it's useful Continia context) but the target/dependency distinction is
driven by the per-WI prompt.

## Scope / decomposition note

Post-review this spans three surfaces, in two repos — the implementation plan
should sequence them so each is independently verifiable:
1. **Overlay** (`private/`): fatal `downloadDeps` pre-stage in `env-provision.ts`
   (+ AppSourceCop baseline alignment); the coder `CLAUDE.append.md` orientation;
   the PreToolUse `--workspace-root` deploy guard (overlay coder hook).
2. **Continia CLI** (`U:\Git\CLI`): the `continia-deploy` skill recipe (synced to
   overlay); the deps **version-validation** fix.
3. **Verification gate**: the empirical `--workspace-root` scoping check decides
   whether the deeper resolver change (a deferred non-goal) is needed.

If this is too large for one plan, split: Plan A (overlay pre-stage + orientation
+ guard) is the floor and independently testable; Plan B (CLI version-validation +
deploy recipe) closes the publish-side fights. Plan A alone gets the run *to*
publish; Plan B gets it *through*.

## Review

Reviewed by Gemini 3.1 Pro (via OpenRouter), 2026-06-23 — **blocked v1**, valid.
Adjudication folded in:
- **Accepted:** make `downloadDeps` FATAL (was a silent warning — that recreates
  the grind); enforce `--workspace-root` via the injected command + a PreToolUse
  guard, not prose (the agent ignores prose under pressure); do NOT defer the
  installed-baseline/AppSourceCop deploy recipe or the deps version-validation
  (they were the majority of wasted turns — deferring = death on publish); ensure
  a working staleness-recovery `deps download`.
- **Nuance (Gemini overstated):** the sibling-rebuild is the continia CLI's
  `discoverApps`, not `alc` (which only reads `.alpackages`); `--workspace-root`
  scopes the CLI — to be **verified empirically** in the plan, not assumed.

## Related
- `2026-06-23-coder-deps-turn-budget-analysis.md` (the forensic root-cause)
- [[project_coder_deps_turn_budget]], [[project_deps_wrong_major_28v29]],
  [[project_overlay_agent_overrides]], [[project_continia_cli_skill_sync]]
