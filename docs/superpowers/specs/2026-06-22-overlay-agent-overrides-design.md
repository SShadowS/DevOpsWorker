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
  /** @deprecated DEAD field — currently consumed nowhere; NOT wired by this
   *  feature. Use agents[name].model. Left in the interface only so existing
   *  manifests still type-check; the resolver ignores it. */
  models?: Record<string, string>;
}
```

`AgentConfigOverride` is added to the versioned type block in
`src/overlay/public-api.ts` and asserted by
`tests/overlay/public-api-contract.test.ts`.

**On `models` (review adjudication):** it is declared but consumed nowhere today.
Wiring it into the precedence chain would silently change behaviour for any
deployment that set it expecting a no-op. So this feature does **not** resurrect
it — `resolveAgentKnobs` ignores `models` entirely. It stays `@deprecated` in the
type for compile back-compat only. (Removing it outright is a separate cleanup.)

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
- **Replace and append are mutually exclusive modes** (review adjudication):
  `CLAUDE.append.md` means "add to the PUBLIC base"; `CLAUDE.md` means "the
  overlay owns the file". When the overlay supplies a `CLAUDE.md`, the overlay's
  `CLAUDE.append.md` is ignored (and a warning is logged — both present is a
  misconfiguration; the overlay should fold its addition into its own
  `CLAUDE.md`). `CLAUDE.append.md` therefore only applies when falling back to
  the public base.

Staging branches:
- `hasOverlayClaudeMd` → copy `overlayClaudeMd` verbatim (real file; never a
  symlink into the tracked source tree — consistent with the copy-on-merge rule).
- else `hasOverlayAppend` → write `read(claudeMdSource) + "\n\n" + read(append)`.
- else → symlink/copy the public base as today.

Precedence (high → low): **overlay `CLAUDE.md` (replace) → public `CLAUDE.md`
[+ overlay `CLAUDE.append.md` only in the base case]**. `.claude/` copy-merge is
unchanged (overlay wins per-file). Backup/cleanup logic is unchanged (it already
backs up `CLAUDE.md` / `.claude/`).

Resulting overlay agent dir holds **either** `CLAUDE.md` (replace) **or**
`CLAUDE.append.md` (add) — plus optionally `.claude/` (merge).

**Concurrency assumption:** `stageAgentWorkspace` stages into the shared session
cwd with backup/restore on cleanup; it is **not** concurrency-safe. This is
sound because agents run **sequentially** within a container (the orchestrator
iterates stages one at a time; pr-reviewer is a single `runAgent` call;
containers are one-per-work-item). Parallelism inside an agent is via SDK
sub-agents, which do not re-stage the workspace. No change needed; documented so
a future concurrent-agents change knows to revisit staging isolation.

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

- `model = agents[name].model ?? base.model ?? pipelineModels.perAgent?.[name]
  ?? pipelineModels.default` (legacy `models` map deliberately excluded — see §1)
- `allowedTools = agents[name].allowedTools ?? base.allowedTools`
- `maxTurns = agents[name].maxTurns ?? base.maxTurns`
- `sharedPromptFragments = agents[name].sharedPromptFragments
  ?? base.sharedPromptFragments`

Empty manifest → returns base values unchanged (identity).

**Single fold point (review adjudication — kills an existing divergence).**
Today `stage.ts` re-derives the telemetry model label via `resolveAgentModel`
(~lines 55/71) **independently** of the model `runAgent` actually resolves
(~line 153) — they can already drift. Rather than add a second resolution site,
resolve **once** in `runAgent` and make the result authoritative everywhere:

1. `src/sdk/run-agent.ts` `runAgent()` is the one chokepoint every agent passes
   through (including pr-reviewer, which calls `runAgent` directly and **bypasses
   `stage.ts`** — so `stage.ts` is *not* a valid universal fold point). Load the
   memoised manifest and apply `resolveAgentKnobs` before the existing reads of
   `model`/`allowedTools`/`maxTurns`/`sharedPromptFragments`.
2. Add the resolved `model` to `AgentResult` (and to `AgentExecutionError`
   details for the error path).
3. `src/pipeline/stage.ts` consumes `result.model` (success) / `err.details.model`
   (error) for its telemetry label and **stops calling `resolveAgentModel`**.

Net: one resolution, no label/run divergence — strictly better than the status
quo.

`resolveAgentModel`'s existing perAgent/default fallback logic is preserved by
folding it into `resolveAgentKnobs` (it becomes the `?? pipelineModels...` tail).

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
- `OverlayManifest.models` stays dead (not consumed) — see §1.

**Fail-fast validation (review adjudication).** `resolveAgentKnobs` validates the
overridden knobs and throws a clear error at resolution time rather than letting
a typo surface as a cryptic mid-run SDK failure:

- `allowedTools` present but empty → error (almost always a mistake; an agent
  with zero tools cannot act).
- `sharedPromptFragments` entries must resolve to existing files under
  `src/prompts/` → error listing the missing fragment.
- `model` is passed through (model-id validity is the SDK's domain).
- Core tool names (the non-`mcp__` entries) are checked against the known core
  tool set and an **unknown name warns** (not errors — MCP tool names are
  dynamic and cannot be fully statically validated, so we don't hard-fail).

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

### 8. Runtime cost & local DX (review adjudication)

- **No per-call cost.** `loadManifest()` is a memoised singleton (`cached` in
  `src/overlay/loader.ts`); the first call parses `private/manifest.ts`, every
  subsequent call returns the in-memory object. Calling it inside `runAgent` is
  a reference read, not a filesystem hit.
- **Local DX mismatch (documented).** Prompt **assets** are re-read from disk on
  every run (each `runAgent` re-stages the workspace), so editing
  `private/agents/<name>/CLAUDE.md` takes effect on the next run with no restart.
  Manifest **knobs** are cached at first load, so editing `agents[name]` knobs
  locally requires a process restart (or `resetManifestCache()` in tests). This
  asymmetry is intentional (the manifest is a TS module imported once) and is
  called out in the docs so it does not surprise local iterators.

## Open Questions

None blocking. (`ado` defaults remain a separate dead-field cleanup, out of
scope here.)

## Review

Reviewed by Gemini 3.1 Pro (via OpenRouter), 2026-06-22. Adjudication:

- **Accepted:** single fold point at `runAgent` with the resolved model surfaced
  on `AgentResult` (§3) — also removes a pre-existing label/run divergence;
  replace/append mutual exclusivity (§2); keep `models` dead, do not resurrect
  (§1); fail-fast knob validation (§5); manifest-cache + local-DX notes (§8).
- **Confirmed as-is:** REPLACE (not merge) for `allowedTools` /
  `sharedPromptFragments` — endorsed as the deterministic, auditable choice.
- **Noted, no change:** staging-concurrency concern is moot under the
  sequential-agents / one-container-per-work-item model (§2), documented as an
  assumption for future revisits.
