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

### Component 1 — Pre-stage symbols (`private/pipeline/env-provision.ts`)

In the existing loop that runs `deps.installDeps(...)` over the Cloud + Test
`appPaths` (the block guarded by `!credentials`, which already explains it makes
"publish work first-try"), add a `deps.downloadDeps(cliPath, env.envId, appPath,
config.paths.sessionRoot)` call for each app path, right after `installDeps`.
`downloadDeps` already exists in `private/sdk/continia-cli.ts` (wraps
`continia deps download <env> <appPath>` → symbols into `<appPath>/.alpackages`).

Result: when the coder runs its **local** `continia compile`/`deploy`, the
transitive symbol closure is already in `.alpackages` — no "missing symbols", no
self-run `deps download`, no recompile of companions.

- **Error handling:** `downloadDeps` failures should be **non-fatal warnings**
  (logged), not aborts — a missing pre-stage degrades to the coder's existing
  reactive `deps download` recovery, it does not block env-provision. (Match the
  surrounding stage's failure posture; do not let a download hiccup orphan the env.)
- **Idempotent on resume:** stays inside the same `!credentials` guard as
  `installDeps`, so a resumed (already-provisioned) env skips it.

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

3. **Build-scoping rule.** In the deploy/compile workflow, pin
   **`--workspace-root <target>/Cloud`** (and the Test app dir) so sibling
   companion source is not resolved as `workspace-local`. Clarify that this scopes
   only the *build*; reading companion source for understanding is unaffected.

The append already owns the authoritative env workflow (deploy with
`--allow-downgrade`, Definition-of-Done gates) — these sections slot in alongside
it; the existing "you don't need deps download" claim becomes true once Component
1 ships.

### What stays in the public core

Nothing changes in `src/agents/coder/`. The core keeps its generic, CLI-agnostic
coder prompt + the deploy `buildPrompt` (which is a generic env-CLI fallback; the
overlay append is the authoritative continia workflow). `--workspace-root`,
`deps download`, named companions are all continia-specific → overlay only.

## Testing

- **`private/tests/pipeline/env-provision*.test.ts`:** extend to assert
  `downloadDeps` is called once per app path after `installDeps`, and that a
  `downloadDeps` rejection is swallowed (warning, env-provision still succeeds).
- **Append render:** a check that the overlay `CLAUDE.append.md` contains the new
  section anchors (Repository Structure, `.dependencies`, `--workspace-root`), and
  that `bun run typecheck` + the overlay suite stay green.
- **Manual smoke (optional):** a multi-companion WI run that reaches local compile
  in far fewer turns, with no companion recompile in the transcript.

## Non-goals (deferred)

- **CLI dependency-resolver fix** — making `continia deps`/`deploy` not treat
  sibling companion source as `workspace-local`, and the deps **version-validation**
  that rejected downloadable test-framework symbols. The pre-stage + `--workspace-root`
  sidestep these; they remain a separate tracked task (ties to
  `project_deps_wrong_major_28v29`).
- **Single-source sync** of `DO.Support/CLAUDE.md` ↔ overlay (chosen: copy now).
- **`maxTurns` bump** — a symptom-level safety net; out of scope for this fix.

## Open question (resolve in plan)

The overlay `CLAUDE.append.md` is shared across overlay repos (document-output,
delivery-network, continia-banking…). The Repository Structure section must be
framed **generically** ("your target is named in your prompt; the siblings are
dependency source") rather than hardcoding DO-only paths — the extension-map prose
can stay (it's useful Continia context) but the target/dependency distinction is
driven by the per-WI prompt.

## Related
- `2026-06-23-coder-deps-turn-budget-analysis.md` (the forensic root-cause)
- [[project_coder_deps_turn_budget]], [[project_deps_wrong_major_28v29]],
  [[project_overlay_agent_overrides]], [[project_continia_cli_skill_sync]]
