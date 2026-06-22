# Overlay Agent Overrides — Design

**Date:** 2026-06-22
**Status:** Approved (design), pending implementation plan
**Topic:** Let a private overlay override an agent's prompt and a bounded set of
config knobs, with the public core's files shipping as defaults.

## Problem

The public core ships each agent as a mini Claude Code project
(`src/agents/<name>/`: `CLAUDE.md`, `.claude/`, `config.ts`, `schema.ts`). A
deployment (e.g. Continia) wants to iterate **privately** on agent behaviour —
first concretely on the `pr-reviewer` prompt — without forking the public repo.

Today the overlay can already do *some* of this:

- `private/agents/<name>/.claude/` → copy-merged over the base `.claude/`
  (overlay wins on per-file clash) via `stageAgentWorkspace`.
- `private/agents/<name>/CLAUDE.append.md` → **appended** to the base `CLAUDE.md`.
- `private/` is mounted read-only at `/app/private` in spawned containers, so the
  above already works in production (`resolveAgentOverlayDir` resolves it from
  `PRIVATE_DIR`).

Two gaps remain:

1. **No full prompt replacement.** The overlay can only *append* to `CLAUDE.md`,
   never rewrite it. Substantial prompt rework fights the public default.
2. **No typed per-agent config override.** `allowedTools`, `maxTurns`,
   `sharedPromptFragments` cannot be overridden by an overlay. (And the declared
   `OverlayManifest.models` / `.ado` fields are currently **dead** — never
   consumed; per-agent model is hardcoded in `src/cli/config.ts`
   `models.perAgent`.)

## Goals

- Public `CLAUDE.md` / `.claude/` files remain the defaults, used verbatim when no
  overlay is installed.
- An overlay can **replace** an agent's `CLAUDE.md` (and still *append* on top).
- An overlay can override a **bounded, versioned** set of non-prompt knobs:
  `model`, `allowedTools`, `maxTurns`, `sharedPromptFragments`.
- The contract lives on the existing `public-api.ts` boundary (like
  `repos`/`companions`), not on internal config shapes.
- Empty/absent overlay → byte-identical behaviour to today.

## Non-Goals

- Overriding `outputSchema` or `buildPrompt` (they encode the structured-output
  contract; staying public keeps the pipeline's typed surface intact).
- Raw full-`AgentConfig` TS override (rejected: couples the overlay to internal
  shapes → high breakage; foot-gun for tools/schema).

## Approach (chosen: A — two-channel, both versioned)

Two channels, each holding what it is best at:

- **Prompt assets** — filesystem convention `private/agents/<name>/`
  (`CLAUDE.md` replace, `CLAUDE.append.md` add, `.claude/` merge). Big text and
  skill trees belong in files; the mount + staging already exist.
- **Typed knobs** — `OverlayManifest.agents` map, exposed via `public-api.ts`,
  folded onto the realized `AgentConfig` by a pure resolver.

Rejected alternatives: **B** all-filesystem (`agent.json` for knobs — untyped,
splits config from the rest of the manifest); **C** full TS `AgentConfig`
override (maximal power, worst coupling).

## Design

### 1. Contract

`src/overlay/types.ts`:

```ts
export interface AgentConfigOverride {
  /** Model id (e.g. 'claude-opus-4-8', 'claude-sonnet-4-6'). Wins over the
   *  hardcoded perAgent default and the legacy `models` map. */
  model?: string;
  /** REPLACE allowedTools wholesale (not merge — merge invites silent
   *  tool-scope creep). Omit to keep the public set. */
  allowedTools?: string[];
  /** Override max agent turns. Omit to keep the public value. */
  maxTurns?: number;
  /** REPLACE shared prompt fragments (filenames resolved from src/prompts/).
   *  Omit to keep the public set. */
  sharedPromptFragments?: string[];
}

export interface OverlayManifest {
  // ...existing fields...
  /** Per-agent typed knobs, keyed by AgentConfig.name. Prompt ASSETS
   *  (CLAUDE.md / .claude/) come from private/agents/<name>/, NOT this map. */
  agents?: Record<string, AgentConfigOverride>;
  /** @deprecated use agents[name].model — kept as a fallback for back-compat. */
  models?: Record<string, string>;
}
```

`AgentConfigOverride` is added to the versioned type block in
`src/overlay/public-api.ts` and asserted by
`tests/overlay/public-api-contract.test.ts`.

### 2. Prompt staging precedence (`src/sdk/agent-workspace.ts`)

In `stageAgentWorkspace`, introduce the overlay `CLAUDE.md` as a replace source:

```ts
const overlayClaudeMd = overlayDir ? join(overlayDir, 'CLAUDE.md') : undefined;
const hasOverlayClaudeMd = !!overlayClaudeMd && existsSync(overlayClaudeMd);
const baseMdSource = hasOverlayClaudeMd ? overlayClaudeMd! : claudeMdSource;
```

- Gate widened: enter the CLAUDE.md staging block when
  `existsSync(claudeMdSource) || hasOverlayClaudeMd` (supports an overlay-only
  agent with no public base file).
- If `hasOverlayAppend`: write `read(baseMdSource) + "\n\n" + read(append)`.
- Else if `hasOverlayClaudeMd`: copy `baseMdSource` (real file; no symlink into
  the tracked source tree, consistent with the existing copy-on-merge rule).
- Else: symlink/copy the public base as today.

Precedence (high → low): **overlay `CLAUDE.md` (replace) → public `CLAUDE.md`**,
then `CLAUDE.append.md` concatenated after whichever base won. `.claude/`
copy-merge is unchanged (overlay wins per-file). Backup/cleanup logic is
unchanged (it already backs up `CLAUDE.md` / `.claude/`).

Resulting overlay agent dir may hold any subset of: `CLAUDE.md` (replace),
`CLAUDE.append.md` (add), `.claude/` (merge).

### 3. Resolver + fold points

A pure function in `src/overlay/index.ts`:

```ts
export interface ResolvedAgentKnobs {
  model: string;
  allowedTools: string[];
  maxTurns: number;
  sharedPromptFragments: string[];
}

export function resolveAgentKnobs(
  base: AgentConfig<any>,
  manifest: OverlayManifest,
  pipelineModels: { default: string; perAgent?: Record<string, string> },
): ResolvedAgentKnobs;
```

Resolution rules:

- `model = agents[name].model ?? models[name] (legacy) ?? base.model
  ?? pipelineModels.perAgent?.[name] ?? pipelineModels.default`
- `allowedTools = agents[name].allowedTools ?? base.allowedTools`
- `maxTurns = agents[name].maxTurns ?? base.maxTurns`
- `sharedPromptFragments = agents[name].sharedPromptFragments
  ?? base.sharedPromptFragments`

Empty manifest → returns base values unchanged (identity).

**Fold points:**

- **Authoritative:** `src/sdk/run-agent.ts` `runAgent()` — the single chokepoint
  every agent passes through. Load the cached manifest (`loadManifest()`) and
  apply `resolveAgentKnobs` before the existing reads of `model` (~line 153),
  `allowedTools`, `maxTurns`, and `sharedPromptFragments` (~line 174). This
  governs the actual run.
- **Label consistency:** `src/pipeline/stage.ts` builds the pre-run telemetry
  model label via `resolveAgentModel(...)` (~lines 55/71). Call the same
  resolver there so the telemetry label matches what `runAgent` actually uses.
  (Only the `model` field matters for the label.)

One pure function, two call sites — no divergence between label and run.

### 4. Runtime — no new plumbing

Already in place: `private/` mounted read-only at `/app/private`
(`-v $HOST_PRIVATE_DIR:/app/private:ro`, `PRIVATE_DIR=/app/private` in
`src/sdk/docker.ts`); `resolveAgentOverlayDir(name)` resolves
`private/agents/<name>/`; the manifest is loaded at container startup
(`src/cli/index.ts` → `applyOverlayRegistries`). Overrides therefore apply in
both local and container runs with zero dispatch changes.

### 5. Back-compat & security

- No overlay, or no `agents[name]` entry → behaviour is byte-identical to today.
- `allowedTools` / `sharedPromptFragments` are **replace**, documented loudly.
  Broadening tools is acceptable because the overlay is the trusted deployment
  owner; replace (not merge) makes the effective set explicit and auditable.
- `OverlayManifest.models` is revived from dead as a deprecated alias folded by
  the resolver; existing (empty) usage is unaffected.

### 6. Testing

- `tests/sdk/agent-workspace.test.ts`:
  - overlay `CLAUDE.md` replaces the base;
  - replace + `CLAUDE.append.md` → base-replacement followed by append (order +
    separator asserted);
  - overlay-only `CLAUDE.md` with no public base stages correctly;
  - cleanup restores any backed-up target.
- `tests/overlay/agent-knobs.test.ts` (new):
  - each knob overridden independently;
  - `model` precedence chain including legacy `models` and the
    `perAgent`/`default` fallbacks;
  - empty manifest → identity on base.
- `tests/overlay/public-api-contract.test.ts`: `AgentConfigOverride` exported.
- One realize-the-config test: fake `private/agents/pr-reviewer/CLAUDE.md` +
  `agents: { 'pr-reviewer': { maxTurns, model } }` → assert the staged prompt
  and the resolved knobs.

### 7. Docs & example

- `private.example/agents/pr-reviewer/CLAUDE.md` (a trimmed replace example) and
  a manifest snippet:
  `agents: { 'pr-reviewer': { model: 'claude-opus-4-8', maxTurns: 120 } }`.
- Update the "Agent Convention" section of `CLAUDE.md` and the overlay design
  doc to describe the two channels and the precedence rules.

## Open Questions

None blocking. (`ado` defaults remain a separate dead-field cleanup, out of
scope here.)
