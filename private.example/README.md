# Private Overlay — Example Skeleton

This directory is a **template** for the private overlay. The public core ships
generic; your proprietary content (repo registry, env tooling, agent specifics,
prompt data) lives in a gitignored `private/` directory that the core loads at
runtime. Nothing here is wired into the public build — copy it to get started.

## Quick start

```bash
cp -r private.example private        # private/ is gitignored
# edit private/manifest.ts + the files it references
```

The core resolves the overlay directory in this order:
1. `--overlay <path>` CLI flag, else
2. `PRIVATE_DIR` env var, else
3. default-probe `./private`.

With no overlay installed, the core runs as a generic AL/BC pipeline.

For a walkthrough of the three main extensibility axes (stages, agents, agent
providers) see [`docs/extending.md`](../docs/extending.md).

## Injection points

| What | Where | Merge |
|------|-------|-------|
| Repo registry | `manifest.repos` | ADD (merged into the empty core registry) |
| Companion repos | `manifest.companions` | ADD (core ships only public `BC`) |
| Agent overrides | `manifest.agents[name].model` | OVERRIDE by agent name |
| Pipeline stages | `manifest.pipeline(ctx)` | declarative name-anchored edits |
| Env backend | `manifest.envProvider(ctx)` | provides BC env lifecycle |
| Agent CLAUDE.md additions | `agents/<name>/CLAUDE.append.md` | APPEND to base |
| Agent rules/skills | `agents/<name>/.claude/{rules,skills}/` | ADD (dir merge) |
| Prompt fragment override | `prompts/<fragment>.md` | OVERRIDE `src/prompts/<fragment>.md` |

## Files in this skeleton

- `manifest.ts` — the entry point; default-exports an `OverlayManifest`.
- `config/repos.ts` — example repo registration (referenced by the manifest).
- `prompts/project-context.md` — example prompt-fragment override.
- `agents/coder/CLAUDE.append.md` — example agent instruction append.

## Types

The overlay implements the `OverlayManifest` contract from
`src/overlay/types.ts`. Bun imports the manifest's TypeScript natively — no build
step. Use `tsconfig.private.json` locally to type-check `private/` against the
core.
