# Coder Turn-Budget Exhaustion on Multi-Companion BC Repos — Forensic Analysis

**Date:** 2026-06-23
**Status:** Findings + recommended fix (not yet built)
**Trigger:** WI 79397 (Document Output) coder stage repeatedly died `error_max_turns`
after the toolchain bugs were fixed.

## TL;DR

After fixing four real toolchain bugs (see below), WI 79397's coder run got all
the way to **compile → deploy → publish → run tests** (proving the fixes work),
then died at `error_max_turns`. A per-turn forensic analysis of the full
~425-internal-turn (200 SDK-turn) run shows the genuine task was **done by turn
~144 (36% of budget)**; the remaining ~64% was consumed by a **deps/deploy/publish
battle** that is **structural to multi-companion BC repos**, not a fluke and not a
fresh toolchain regression. The single highest-leverage fix is to **pre-stage
companion/baseline/test symbols into `.alpackages` (download, never recompile
companions from source) and pin `--workspace-root`** — that reclaims ~half the
budget.

## Context: the four toolchain bugs already fixed (all held in this run)

1. **alc infinite-exec hang** — corrupted 252-byte self-exec `alc` cached on the
   state volume. Fixed: CLI owns alc via the self-contained NuGet `.Tools.Linux`
   package + cache self-heal + a fail-loud `validateAlcBinary` guard. See
   `2026-06-22-al-toolchain-nuget-redesign-design.md`.
2. **Forward-slash logo** — `Images\Logo.png` → Linux alc "Specified part does not
   exist in the package". Fixed in source across all 4 DO manifests (WI 79294,
   PR #50504).
3. **alc default channel** — defaulted to prerelease (18.x-beta) ≠ CI's stable
   (17.0.34) → BC tenant collision. Fixed: default to newest **stable**,
   `--prerelease` opt-in.
4. **Persisted revision counter** — `state.revisionAttempts.coding` pinned at 5/5
   across resumes → instant `revision-exhausted` on every rerun. Reset to 0.

This run confirmed all four: it compiled, deployed, published (no "Specified
part"), and ran the test suite (4/10 passed). It died on something else.

## The run

- WI 79397, stage `coding`, model `claude-sonnet-4-6`, `maxTurns: 200` (SDK).
- 23:18:54 → 00:16:26 (**57.5 min**), internal "Turn" counter reached **425**,
  terminated `error_max_turns`.
- 235 tool calls: Bash 110, Glob 49, Read 24, Edit 16, LSP 13, Grep 9, rest MCP/
  Agent/ToolSearch. Bash subcommands: `continia deps` 21, `continia deploy` 19,
  `continia env` 7, `unpublish` 3, `compile` 1, `test` 1.

## Phase histogram

| Phase | Internal turns | Wall span | Tools | Note |
|---|---|---|---|---|
| 1. LSP warm-up (mandatory) | 2–9 | ~22s | 3 | mostly waste; found nothing used |
| 2. Codebase exploration | 9–80 | 2m46s | 43 | ~half waste — LSP/Glob hunts where `grep` was one shot |
| 3. Implementation (4 files) | 80–122 | 8m | 17 | **necessary** — the actual task |
| 4. Commit + push + CI trigger | 122–144 | ~40s | 12 | necessary; task essentially done here |
| **5. Deps/deploy/publish battle** | **144–402** | **22m13s** | **145** | **~85% waste — the sink** |
| 6. Test run | 402–404 | ~73s | 1 | necessary; 4/10 passed |
| 7. Test-fix + compaction stall | 404–425 | ~22m | 14 | ~20m lost to a context-compaction stall; never re-tested |

**~120–130 of the ~200 SDK turns produced no durable forward progress.**

## The sink: the deps/deploy/publish battle (62% of tool calls)

Three nested, self-inflicted fights:

1. **`workspace-local` mis-resolution (~turns 149–213, ~30 turns).** Sibling
   source dirs (`Core/`, `DeliveryNetwork/`, `BC/`) made `continia deps`/`deploy`
   resolve companion AND Microsoft packages as `workspace-local` and try to
   **recompile them from source** instead of downloading symbols. The agent
   brute-forced `--workspace-root` permutations until packages resolved.
2. **AppSourceCop baseline (turns 219–245).** `AppSourceCop.json` pointed at a
   baseline missing from the cache (AS0003); the agent hand-edited it.
3. **Installed-baseline version-conflict loop (turns 245–396).** A newer baseline
   (29.0.0.114611) was already installed via the admin API, so the dev-endpoint
   publish refused. The agent looped `--allow-downgrade` / `unpublish` /
   manual app.json version-bumps, then repeated the **entire fight for the Test
   app** + 6 test-framework symbols the CLI wouldn't download (version validation
   too strict: "rejects 28.x when 25.x requested") — finally dropping to raw
   `curl`/`python3`/`node` to hand-copy `.app` files into `.alpackages`.

The underlying need (publish 2 apps) was ~4–6 commands; it took ~80.

## Verdict on cause (ranked by turn cost)

1. **~70% — inherent multi-companion complexity × an incomplete deps workflow.**
   `continia deps`/`deploy` does not cleanly handle "Cloud app whose companion
   dependencies are present as source dirs" + an already-installed baseline + the
   3-independent-version-axes hazard (`project_deps_wrong_major_28v29`). The agent
   had to discover the recipe (`--workspace-root` incantation, AppSourceCop strip,
   version-bump-to-upgrade) by trial and error. The decisive difference from the
   successful single-app run (WI 73961, 0 companions) is exactly this dimension.
2. **~15% — the less-bash / mandatory-LSP steering.** Real but secondary:
   exploration was inflated; LSP/Glob used where `grep` would resolve in one shot.
3. **Secondary — a ~20-min context-compaction stall (phase 7)**, itself *caused by*
   the bloated context from the deps battle.
4. **Not** a one-time fluke; **not** a fresh toolchain regression (the 4 fixes held);
   **not** the "Discovered 236 apps" bloat (that is fixed — this run saw ~6 apps).

Note: WI 72264 (same DO repo) shows the same pattern far harder (cumulatively 177
`deps`, 120 `deploy`, 56 companion compile-fails across its many resumed attempts)
and only "passed" by **accumulating progress across resumes** — each resume = a
fresh 200-turn budget on the *same* workspace. Deleting the workspace per rerun
(as we did for 79397) removes that accumulation.

## Highest-leverage fix

**Pre-stage companion + baseline + test-framework symbol packages into
`.alpackages` before the coder starts (download, never recompile companions from
source), and pin `--workspace-root` to the single target app.** Kills ~120 of the
145 phase-5 calls (~half the entire budget) — the difference between finishing the
test-fix loop and dying at turn 425.

Complementary, in priority:
1. Encode a deterministic "deploy companions in order with an already-installed
   baseline" recipe in the `continia-deploy` skill (topological order +
   `--allow-downgrade`/version-bump decision) so it isn't rediscovered each run.
2. Fix the CLI deps version-validation that rejected downloadable test-framework
   symbols (too strict across version axes) — ties to
   `project_deps_wrong_major_28v29`.
3. Raise coder `maxTurns` (200→~320) for multi-companion repos as a **safety net
   only** — without #1 the extra turns drown in the same battle + compaction stall.

## Method (how this was produced — reusable)

1. Tool histogram per run: `substring(content from 'TOOL INPUT: ([A-Za-z_]+)')`
   counted over `stage_logs` filtered to the run window.
2. Bash-subcommand taxonomy: extract the leading token of the `"command"` field.
3. Loop/failure counts: `FILTER (WHERE content ILIKE '%Compilation failed%' / '%Exit code 1%')`.
4. Baseline diff: same metrics on a *successful* run (single-app WI 73961) and a
   same-repo run (WI 72264).
5. Per-turn narrative: read the full assistant-text + tool-result timeline, bucket
   every turn into phases, tally waste vs necessary.

## Related
- [[project_alc_toolchain_redesign]], [[project_deps_wrong_major_28v29]],
  [[project_env_publish_logo_backslash]], [[project_coder_cost_controls]]
- `docs/superpowers/specs/2026-06-22-al-toolchain-nuget-redesign-design.md`
