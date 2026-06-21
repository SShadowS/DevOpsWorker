---
name: claude-code-uplift
description: >-
  Runbook for bumping the Claude Agent SDK and the container's Claude Code CLI in
  DevOpsWorker, then reconciling every AL-LSP hack, verifying agents still see the
  LSP tool, and rebuilding images. Use this whenever upgrading
  @anthropic-ai/claude-agent-sdk or @anthropic-ai/claude-code, when the user says
  "uplift", "bump the SDK", "update Claude Code", "pull the newest dependency", or
  mentions a new Claude Code / SDK build fixing an LSP bug. Claude Code ships
  frequently, so reach for this skill on any routine dependency uplift of these
  packages — even when the user doesn't name every step.
---

# Claude Code / SDK Uplift Runbook

## Why this exists

Two Claude versions run in this project and they drift independently:

1. **`@anthropic-ai/claude-agent-sdk`** — pinned in `package.json` / `bun.lock`. This is
   what the pipeline imports and runs locally and in spawned containers.
2. **`@anthropic-ai/claude-code`** (the CLI) — installed **unpinned** in `Dockerfile:32`
   (`npm install -g @anthropic-ai/claude-code`). It floats to latest on every image build.

Around these we carry a stack of AL-LSP hacks (binary patches, plugin resolution, container
symlinks, prompt steering). Upstream fixes land often and silently make some hacks redundant
— or break them. This runbook bumps the deps and walks every hack site so nothing rots.

**Golden rule:** a bump is not done until agents in a *spawned container* still see the `LSP`
tool and structured output (Zod) still validates. Everything else is in service of that.

## The hack inventory (single source of truth)

Walk every row on each uplift. If a row is now obsolete because upstream fixed it, delete the
hack and note it — don't leave dead workarounds.

| # | Thing | Location | On uplift |
|---|-------|----------|-----------|
| 1 | SDK version pin | `package.json` + `bun.lock` `@anthropic-ai/claude-agent-sdk` | bump |
| 2 | Claude Code CLI (container) | `Dockerfile:32` `npm i -g @anthropic-ai/claude-code` (unpinned) | verify floats clean; pin if it breaks |
| 3 | Global MCP servers | `Dockerfile` `npm i -g @sshadows/mcp-server-azure-devops business-central-mcp @vjeko.com/al-object-id-ninja-mcp` | verify still resolve |
| 4 | `cli.js` race binary-patch | `scripts/patch-lsp.cjs` (regex on minified `isEnabled()`) | regex dead (no `cli.js`). Keep transform as reference; re-host on tweakcc only if the race recurs. |
| 4a | Production cli.js patcher | `scripts/apply-production-patches.ts` + `docker/entrypoint.sh` hook (~L251) | `findCliJs()` is dead. **Port to tweakcc** (see "Binary patching" below). Also retarget: patch the SDK binary, not the standalone CLI. |
| 4b | workspaceSymbol query fix | `scripts/ab-test-lsp/patches/workspace-symbol-fix.js` (the "missing query param" fix) | **obsolete — fixed upstream** (workspaceSymbol op confirmed present unpatched). Retire this transform. |
| 4c | Tool-desc AL-steering patch | `TOOL_DESC_ADDITIONS` in `apply-production-patches.ts` (grep/glob string-anchor append) | still wanted — re-host on tweakcc against the SDK binary. Prompt steering (rows 10-12) is the fallback channel. |
| 4d | A/B binary-patch dimension | `scripts/ab-test-lsp/patches.ts` (+ tests) | same cli.js assumption — also needs the tweakcc port if the patch arm is still exercised. |
| 5 | Plugin resolver | `src/sdk/mcp-configs.ts` `resolveAlLspPlugin()` + version-dir filter | re-check against plugin dir layout |
| 6 | LSP tool sets | `src/sdk/mcp-configs.ts` `fsReadOnlyWithLSP`, `fsAndBashWithLSP` | confirm `TOOLS.LSP` name unchanged |
| 7 | Plugin clone + version-dir symlinks | `docker/entrypoint.sh` (`ls -A` for `.lsp.json`, chmod bin) | confirm `.lsp.json` still required + present |
| 8 | .NET runtime for AL LS | `Dockerfile` `libicu72` | leave unless AL LS runtime changes |
| 9 | NO marketplace file | `docker/claude-known-marketplaces.json` must stay OUT of container (hangs CLI) | confirm still excluded |
| 10 | Prompt steering — op-map | each agent `CLAUDE.md` operation-mapping table | re-tune if LSP tool surface changed |
| 11 | Prompt steering — append | `src/prompts/lsp-reinforcement.md` | re-tune / trim if redundant |
| 12 | Prompt steering — rules | `src/agents/{coder,planner,plan-reviewer,code-reviewer,test-cases}/.claude/rules/USE-AL-LSP-TOOLS.md` | re-tune / trim |
| 13 | A/B harness | `scripts/ab-test-lsp.ts`, `scripts/ab-test-lsp/variants.ts` | re-run when prompt behavior may have shifted |
| 14 | LSP availability test | `scripts/test-lsp-availability.ts` | run as the gate (see Verify) |
| 15 | Rebuild spawned image | `docker build -t devopsworker:latest .` | always, after any container-affecting change |

Treat this table as the source of truth. If you discover a new hack site, **add a row here**
in the same change — that's how the runbook stays complete across future uplifts.

## Procedure

### Pre-flight — know the gap before touching anything

```bash
# installed SDK
grep '"@anthropic-ai/claude-agent-sdk"' package.json
# latest published
npm view @anthropic-ai/claude-agent-sdk version dist-tags --json
npm view @anthropic-ai/claude-code version
```

Then read what actually changed. Don't bump blind — a multi-minor jump can move minified
internals (breaks the binary patch) and the LSP tool schema (makes prompt steering stale).
Skim the SDK / CLI changelog for: LSP tool changes, structured-output / Zod changes, plugin
loading changes, permission/tool-name changes. Note anything touching a row in the inventory.

### A — Bump

```bash
bun add @anthropic-ai/claude-agent-sdk@<target>   # updates package.json + bun.lock together
```

`Dockerfile:32` CLI is unpinned — it picks up latest on next `docker build`. If a CLI release
is bad, pin it: `npm install -g @anthropic-ai/claude-code@<good-version>`.

### B — Reconcile the patches

- **`scripts/patch-lsp.cjs`** matches a *minified* `isEnabled()` shape. A bump almost always
  reshapes that. Run it (`node scripts/patch-lsp.cjs`) — if it logs `ERROR — isEnabled pattern
  not found`, either re-derive the regex against the new `cli.js`, or **delete the patch** if
  the SDK now handles the LSP-init race itself. Confirm whether it's even wired in (it has no
  `postinstall` hook and isn't called from the Dockerfile — verify before relying on it).
- **`resolveAlLspPlugin()`** assumes `AL_LSP_DIR/<version>/` with `plugin.json` + `.lsp.json`
  inside. If plugin packaging changed, fix the filter.

### C — Verify (this is the gate — don't skip)

```bash
bun run typecheck            # types still line up with new SDK surface
bun run test                 # unit suite (watch for Zod / structured-output failures)
```

**Zod / structured output:** the SDK peer-depends on `zod@^4`. Confirm agents that return
structured output still validate — a schema-validation failure after a bump usually means the
SDK changed how it strips/forwards JSON schema. (Historically a `$schema`-stripping shim was
needed; the project now uses Zod 4 elsewhere, so this should hold — but verify, don't assume.)

**LSP tool visibility — the real proof.** Types passing ≠ agents seeing the tool. Run the
availability check inside a spawned container, because that's where it silently breaks:

```bash
docker build -t devopsworker:latest .   # MUST rebuild first — spawned containers run baked code
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint bash \
  -v do-pipeline-state:/state -v "$PWD/scripts:/app/scripts" \
  -v "<path/to/AL/project>:/workspace/al-project" --env-file .env \
  devopsworker:latest -c '... entrypoint LSP setup ... bun scripts/test-lsp-availability.ts /workspace/al-project'
```

Pass = agent sees the `LSP` tool. If the plugin "loads" but no `LSP` tool appears, suspect a
missing `.lsp.json` in the version dir (row 7) — the most subtle failure mode.

### D — Re-tune prompts / A-B (only when LSP behavior changed)

If the changelog or verify step shows the LSP tool surface moved (new operation, fixed param,
different schema), the prompt steering (rows 10-12) may now over- or under-instruct. Re-run the
A/B harness to re-measure, then trim scaffolding that's no longer pulling its weight:

```bash
bun scripts/ab-test-lsp.ts --task <task.md> --models sonnet --docker --runs 3 --yes
```

Prompt-tuning lore that still holds: CLAUDE.md op-map is the critical channel; negative framing
backfires; Sonnet follows LSP steering far better than Opus. Don't re-litigate these unless data
says otherwise.

### E — Rebuild both images (they drift independently)

```bash
docker build -t devopsworker:latest .   # spawned pipeline + PR-review containers
docker compose build                    # watcher / dashboard / webhook-server
docker compose up -d
```

Forgetting `devopsworker:latest` is the classic trap: compose services pick up new code,
spawned containers silently run stale code. If InternalActivation must stay baked, rebuild with
its `--build-arg` / `--secret` (see project CLAUDE.md "InternalActivation App").

### F — Record what changed

- Update version numbers + any obsolete-hack removals in project `CLAUDE.md`.
- Update the inventory table above if a hack was added, removed, or moved.
- Save a memory note (the uplift outcome: target version, what broke, what got deleted) so the
  next uplift starts from truth, not stale claims.

## Binary patching (post-0.3.x: tweakcc, not cli.js)

If the LSP still needs tweaking (it does), patching is still on the table — but the mechanism
changed completely at SDK 0.3 / CLI v2:

- There is **no `cli.js`** anymore. The CLI is a **Bun single-file executable** (`claude.exe`)
  with the JS bundle embedded in `$bunfs`. `extractFromBunfs.js` enforces that "a native binary
  must not come out named cli.js." Any patch that does `readFileSync(cli.js)` → string-replace →
  `writeFileSync` is dead on arrival.
- **Use [tweakcc](https://github.com/Piebald-AI/tweakcc)**, which patches the native binary via
  `node-lief`: `tweakcc unpack` (extract embedded JS) → apply transform → `tweakcc repack`
  (re-embed), with ad-hoc signing on Apple Silicon. It auto-detects native vs npm installs.
- **Patch the right binary.** Agents run via the SDK's **bundled** binary
  (`node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude.exe`), NOT the standalone
  `@anthropic-ai/claude-code` global install. The legacy `apply-production-patches.ts` targeted
  the standalone CLI — likely a no-op for SDK-spawned agents. The port must target the SDK binary
  (and re-apply after every `bun install`, since the binary is replaced on upgrade).
- **Reuse the transforms, replace the delivery.** The JS string-edits in
  `scripts/ab-test-lsp/patches/*.js` and the tool-desc additions are still valid inputs; only the
  read/write-cli.js plumbing is obsolete. Retire transforms that upstream has fixed (workspaceSymbol).

Porting this is its own task — scope it deliberately, don't bolt it onto a routine version bump.

## Done means

- [ ] SDK + CLI at intended versions
- [ ] `typecheck` + `test` green, structured output validates
- [ ] `test-lsp-availability.ts` shows the `LSP` tool **inside a freshly-built container**
- [ ] obsolete hacks deleted, inventory table current
- [ ] both images rebuilt and `docker compose up -d` clean
- [ ] CLAUDE.md + memory updated
