# Overlay Agent Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a private overlay fully replace an agent's `CLAUDE.md` (today: append-only) and override a bounded set of typed knobs (`model`, `allowedTools`, `maxTurns`, `sharedPromptFragments`) via a new `OverlayManifest.agents` map, with the public core's files as defaults.

**Architecture:** Two channels. (1) Prompt assets stay a filesystem convention `private/agents/<name>/` — extend `stageAgentWorkspace` so an overlay `CLAUDE.md` replaces the base. (2) Typed knobs come from `OverlayManifest.agents`, folded onto the realized config by one pure resolver `resolveAgentKnobs`, applied at the single `runAgent` chokepoint. The resolved model is surfaced on `AgentResult` so `stage.ts` telemetry stops independently re-deriving it (removes a pre-existing label/run divergence).

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, Claude Agent SDK. No `mock.module()` (contaminates the Bun process — replace `globalThis.fetch` or use real temp dirs instead).

**Spec:** `docs/superpowers/specs/2026-06-22-overlay-agent-overrides-design.md`

---

## File Structure

- `src/overlay/types.ts` — add `AgentConfigOverride` + `OverlayManifest.agents`; deprecate `models`. (Modify)
- `src/overlay/public-api.ts` — export the `AgentConfigOverride` type. (Modify)
- `src/overlay/agent-knobs.ts` — **new** pure resolver `resolveAgentKnobs` + `ResolvedAgentKnobs` + validation. (Create)
- `src/overlay/index.ts` — re-export the resolver. (Modify)
- `src/types/agent.types.ts` — add `model: string` to `AgentResult`. (Modify)
- `src/sdk/run-agent.ts` — apply the resolver; put `model` on the result and on the `AgentExecutionError` details. (Modify)
- `src/pipeline/stage.ts` — telemetry consumes `result.model` / `err.details.model`. (Modify)
- `src/sdk/agent-workspace.ts` — `CLAUDE.md` replace + replace/append mutual exclusivity. (Modify)
- Tests: `tests/overlay/agent-knobs.test.ts` (new), `tests/overlay/public-api-contract.test.ts` (modify), `tests/sdk/agent-workspace.test.ts` (modify).
- Docs/example: `private.example/agents/pr-reviewer/CLAUDE.md` (new), `private.example/manifest.ts` (modify if present), `CLAUDE.md` (modify), spec/overlay docs.

---

## Task 1: Contract — `AgentConfigOverride` type + `OverlayManifest.agents`

**Files:**
- Modify: `src/overlay/types.ts`
- Modify: `src/overlay/public-api.ts`
- Test: `tests/overlay/public-api-contract.test.ts`

- [ ] **Step 1: Add `AgentConfigOverride` to the contract test's type-import block (failing compile)**

In `tests/overlay/public-api-contract.test.ts`, add `AgentConfigOverride` to the `import type { ... }` block (after `McpServerConfig`):

```ts
  AgentConfig,
  McpServerConfig,
  AgentConfigOverride,
  RepoConfig,
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — `TS2305: Module '"../../src/overlay/public-api.ts"' has no exported member 'AgentConfigOverride'`.

- [ ] **Step 3: Add the type + manifest field in `src/overlay/types.ts`**

Add this interface above `OverlayManifest`:

```ts
/**
 * Bounded, typed per-agent knobs an overlay may override. Prompt ASSETS
 * (CLAUDE.md / .claude/) come from private/agents/<name>/, NOT this map.
 * REPLACE semantics for arrays (allowedTools, sharedPromptFragments) — never
 * merged, so the effective set is explicit and auditable.
 */
export interface AgentConfigOverride {
  /** Model id (e.g. 'claude-opus-4-8'). Wins over the perAgent/default chain. */
  model?: string;
  /** REPLACE allowedTools wholesale. Omit to keep the public set. */
  allowedTools?: string[];
  /** Override max agent turns. Omit to keep the public value. */
  maxTurns?: number;
  /** REPLACE shared prompt fragments (filenames resolved from src/prompts/). */
  sharedPromptFragments?: string[];
}
```

Inside `OverlayManifest`, add the `agents` field and re-document `models`:

```ts
  /** Per-agent typed knobs, keyed by AgentConfig.name. Prompt assets come from
   *  private/agents/<name>/, NOT this map. */
  agents?: Record<string, AgentConfigOverride>;
  /** @deprecated DEAD field — consumed nowhere; NOT wired by agent overrides.
   *  Use agents[name].model. Kept only so existing manifests type-check. */
  models?: Record<string, string>;
```

(If `models?` already exists in the interface, just replace its doc comment with the `@deprecated` one above — do not duplicate the field.)

- [ ] **Step 4: Export the type from the public-api barrel**

In `src/overlay/public-api.ts`, find the type re-export block that includes `OverlayManifest`/`AdoDefaults` and add `AgentConfigOverride` to it:

```ts
export type {
  OverlayManifest,
  AdoDefaults,
  PipelineBuildContext,
  AgentConfigOverride,
} from './types.ts';
```

(Add `AgentConfigOverride` to whichever `export type { ... } from './types.ts'` block already exists; do not create a second block.)

- [ ] **Step 5: Run typecheck + contract test to verify pass**

Run: `bun run typecheck && bun test tests/overlay/public-api-contract.test.ts`
Expected: typecheck clean; contract test PASS (value-surface test still green — no new value export was added).

- [ ] **Step 6: Commit**

```bash
git add src/overlay/types.ts src/overlay/public-api.ts tests/overlay/public-api-contract.test.ts
git commit -m "feat(overlay): add AgentConfigOverride contract + manifest.agents"
```

---

## Task 2: `resolveAgentKnobs` resolver + validation

**Files:**
- Create: `src/overlay/agent-knobs.ts`
- Modify: `src/overlay/index.ts`
- Test: `tests/overlay/agent-knobs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/overlay/agent-knobs.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { resolveAgentKnobs } from '../../src/overlay/agent-knobs.ts';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { z } from 'zod';

// Minimal base AgentConfig — only the fields the resolver reads matter.
function baseConfig(over: Partial<AgentConfig<z.ZodTypeAny>> = {}): AgentConfig<z.ZodTypeAny> {
  return {
    name: 'pr-reviewer',
    sharedPromptFragments: ['dependencies-folder.md'],
    buildPrompt: () => '',
    outputSchema: z.object({}),
    allowedTools: ['Read', 'Bash'],
    maxTurns: 80,
    ...over,
  } as AgentConfig<z.ZodTypeAny>;
}

const MODELS = { default: 'claude-opus-4-8', perAgent: { 'pr-reviewer': 'claude-sonnet-4-6' } };

describe('resolveAgentKnobs', () => {
  test('empty manifest → identity on base (model from perAgent)', () => {
    const k = resolveAgentKnobs(baseConfig(), {}, MODELS);
    expect(k.model).toBe('claude-sonnet-4-6');
    expect(k.allowedTools).toEqual(['Read', 'Bash']);
    expect(k.maxTurns).toBe(80);
    expect(k.sharedPromptFragments).toEqual(['dependencies-folder.md']);
  });

  test('overlay model wins over perAgent/default', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { model: 'claude-opus-4-8' } } };
    expect(resolveAgentKnobs(baseConfig(), m, MODELS).model).toBe('claude-opus-4-8');
  });

  test('falls back to default when no perAgent and no override', () => {
    const k = resolveAgentKnobs(baseConfig({ name: 'unknown-agent' }), {}, MODELS);
    expect(k.model).toBe('claude-opus-4-8');
  });

  test('overlay replaces allowedTools, maxTurns, fragments', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': {
      allowedTools: ['Read'], maxTurns: 5, sharedPromptFragments: ['tdd.md'],
    } } };
    const k = resolveAgentKnobs(baseConfig(), m, MODELS);
    expect(k.allowedTools).toEqual(['Read']);
    expect(k.maxTurns).toBe(5);
    expect(k.sharedPromptFragments).toEqual(['tdd.md']);
  });

  test('maxTurns defaults to 50 when neither override nor base set it', () => {
    const k = resolveAgentKnobs(baseConfig({ maxTurns: undefined }), {}, MODELS);
    expect(k.maxTurns).toBe(50);
  });

  test('throws on empty allowedTools override', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { allowedTools: [] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).toThrow(/allowedTools is empty/);
  });

  test('throws on missing shared prompt fragment', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { sharedPromptFragments: ['does-not-exist.md'] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).toThrow(/not found under src\/prompts/);
  });

  test('accepts an existing shared prompt fragment override', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { sharedPromptFragments: ['tdd.md'] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/overlay/agent-knobs.test.ts`
Expected: FAIL — cannot resolve `../../src/overlay/agent-knobs.ts` (module not created yet).

- [ ] **Step 3: Implement the resolver**

Create `src/overlay/agent-knobs.ts`:

```ts
import type { AgentConfig } from '../types/agent.types.ts';
import type { OverlayManifest } from './types.ts';
import { readPromptFile } from '../sdk/prompt-loader.ts';

export interface ResolvedAgentKnobs {
  model: string;
  allowedTools: string[];
  maxTurns: number;
  sharedPromptFragments: string[];
}

/** Core (non-MCP) tool names known to the SDK. Used only to WARN on an
 *  overridden allowedTools list that names something unexpected — MCP tools
 *  (mcp__*) are dynamic and intentionally not validated. */
const CORE_TOOLS = new Set([
  'Agent', 'Task', 'Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Grep',
  'Glob', 'Skill', 'LSP', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
]);

/**
 * Fold an overlay's per-agent knobs onto a base AgentConfig. Pure: with an empty
 * manifest (or no entry for this agent) it returns the base values unchanged.
 * Validates overridden knobs and throws a clear error rather than letting a typo
 * surface as a cryptic mid-run SDK failure.
 *
 * `model` precedence: override → base.model → perAgent[name] → default.
 * (The deprecated OverlayManifest.models map is deliberately NOT consulted.)
 */
export function resolveAgentKnobs(
  base: AgentConfig<any>,
  manifest: OverlayManifest,
  pipelineModels: { default: string; perAgent?: Record<string, string> },
): ResolvedAgentKnobs {
  const ov = manifest.agents?.[base.name];

  const allowedTools = ov?.allowedTools ?? base.allowedTools;
  if (ov?.allowedTools) {
    if (allowedTools.length === 0) {
      throw new Error(
        `Overlay agent override "${base.name}": allowedTools is empty — an agent with no tools cannot act.`,
      );
    }
    for (const t of allowedTools) {
      if (!t.startsWith('mcp__') && !CORE_TOOLS.has(t)) {
        console.warn(`[overlay] agent "${base.name}": allowedTools includes unknown core tool "${t}"`);
      }
    }
  }

  const sharedPromptFragments = ov?.sharedPromptFragments ?? base.sharedPromptFragments;
  if (ov?.sharedPromptFragments) {
    const missing = ov.sharedPromptFragments.filter((name) => {
      try { readPromptFile(`prompts/${name}`); return false; } catch { return true; }
    });
    if (missing.length > 0) {
      throw new Error(
        `Overlay agent override "${base.name}": sharedPromptFragments not found under src/prompts/: ${missing.join(', ')}`,
      );
    }
  }

  return {
    model: ov?.model ?? base.model ?? pipelineModels.perAgent?.[base.name] ?? pipelineModels.default,
    allowedTools,
    maxTurns: ov?.maxTurns ?? base.maxTurns ?? 50,
    sharedPromptFragments,
  };
}
```

- [ ] **Step 4: Re-export from the overlay barrel**

In `src/overlay/index.ts`, add near the other re-exports (e.g. below the `loadManifest` re-export line):

```ts
export { resolveAgentKnobs } from './agent-knobs.ts';
export type { ResolvedAgentKnobs } from './agent-knobs.ts';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/overlay/agent-knobs.test.ts && bun run typecheck`
Expected: all 8 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/overlay/agent-knobs.ts src/overlay/index.ts tests/overlay/agent-knobs.test.ts
git commit -m "feat(overlay): resolveAgentKnobs resolver with fail-fast validation"
```

---

## Task 3: Surface resolved `model` on `AgentResult` + apply resolver in `runAgent`

**Files:**
- Modify: `src/types/agent.types.ts:91-102`
- Modify: `src/sdk/run-agent.ts`

This is wiring at the single chokepoint; it is verified by `bun run typecheck` plus the existing suite staying green (the SDK `query()` cannot be unit-tested without `mock.module`, which is forbidden here). The behavioural logic is already covered by Task 2's resolver tests.

- [ ] **Step 1: Add `model` to `AgentResult`**

In `src/types/agent.types.ts`, inside `interface AgentResult<T>`, add after `subtype`:

```ts
  /** SDK result subtype (e.g. 'success', 'error_max_turns'). */
  subtype: string;
  /** The model the run actually used (resolved knobs — authoritative for telemetry). */
  model: string;
```

- [ ] **Step 2: Import the resolver + loadManifest in run-agent**

In `src/sdk/run-agent.ts`, the existing import from `'../overlay/index.ts'` brings in `resolveAgentOverlayDir`. Extend it:

```ts
import { resolveAgentOverlayDir, loadManifest, resolveAgentKnobs } from '../overlay/index.ts';
```

- [ ] **Step 3: Resolve knobs once, replace the per-field reads**

In `runAgent`, replace the model block (currently lines ~153-155):

```ts
  const knobs = resolveAgentKnobs(config, await loadManifest(), context.config.models);
  const model = knobs.model;
```

Replace the `effectiveTools` initialiser (currently `let effectiveTools = [...config.allowedTools];`):

```ts
  let effectiveTools = [...knobs.allowedTools];
```

Replace the shared-fragment call (currently `buildSharedFragmentContent(config.sharedPromptFragments)`):

```ts
    const sharedContent = buildSharedFragmentContent(knobs.sharedPromptFragments);
```

Replace BOTH `config.maxTurns ?? 50` occurrences (the `logJson` `maxTurns:` field and the `query()` options `maxTurns:` field) with:

```ts
            maxTurns: knobs.maxTurns,
```

- [ ] **Step 4: Put `model` on the success result + the AgentExecutionError details**

In the success `return { ... }` (currently lines ~435-444), add `model`:

```ts
                  return {
                    output: parsed.data,
                    costUsd,
                    durationMs,
                    turns,
                    sessionId,
                    toolCalls,
                    tokens,
                    subtype: resultSubtype,
                    model,
                  };
```

In the "Agent failed or missing structured output" `AgentExecutionError` (currently lines ~467-473), add `model` to the details:

```ts
            const err = new AgentExecutionError(config.name, {
              subtype: message.subtype,
              errors,
              costUsd,
              durationMs,
              turns,
              model,
            });
```

- [ ] **Step 5: Verify typecheck + full suite green**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; existing tests PASS (no test references `AgentResult` without `model` in a way that breaks — `model` is additive). If any test constructs a literal `AgentResult` object, add `model: '...'` to it.

- [ ] **Step 6: Commit**

```bash
git add src/types/agent.types.ts src/sdk/run-agent.ts
git commit -m "feat(agent): apply overlay knobs at runAgent + surface resolved model on result"
```

---

## Task 4: `stage.ts` telemetry consumes the authoritative model

**Files:**
- Modify: `src/pipeline/stage.ts:55,71`

Goal: stop independently re-deriving the model label (the pre-existing divergence). The success path uses `result.model`; the error path uses the model captured in the `AgentExecutionError` details, falling back to `resolveAgentModel` (kept for safety + its existing unit tests).

- [ ] **Step 1: Success path — use `result.model`**

In `src/pipeline/stage.ts`, in the success telemetry entry (currently line ~71), replace:

```ts
        model: resolveAgentModel(config.agent.model, config.agent.name, context.config.models),
```

with:

```ts
        model: result.model,
```

- [ ] **Step 2: Error path — prefer the captured model**

In the `catch` block's `partialTelemetry` (currently line ~55), replace:

```ts
            model: resolveAgentModel(config.agent.model, config.agent.name, context.config.models),
```

with:

```ts
            model: (typeof d.model === 'string' ? d.model : undefined)
              ?? resolveAgentModel(config.agent.model, config.agent.name, context.config.models),
```

(`d` is the already-narrowed `err.details as Record<string, unknown>` in that block — confirm the variable name `d` matches; it does in the current code.)

- [ ] **Step 3: Verify typecheck + stage tests green**

Run: `bun run typecheck && bun test tests/pipeline/stage.test.ts`
Expected: PASS. `resolveAgentModel` is still imported + exported, so its 5 existing unit tests stay green.

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/stage.ts
git commit -m "refactor(pipeline): stage telemetry uses authoritative result.model"
```

---

## Task 5: `CLAUDE.md` replace + replace/append mutual exclusivity

**Files:**
- Modify: `src/sdk/agent-workspace.ts:96-117`
- Test: `tests/sdk/agent-workspace.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/sdk/agent-workspace.test.ts` (self-contained — creates real temp dirs; no mocks). If the file already imports `stageAgentWorkspace`, reuse that import rather than re-importing.

```ts
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { stageAgentWorkspace } from '../../src/sdk/agent-workspace.ts';

describe('stageAgentWorkspace — overlay CLAUDE.md replace', () => {
  const dirs: string[] = [];
  async function tmp(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  test('overlay CLAUDE.md replaces the base', async () => {
    const src = await tmp('agent-src-');
    const overlay = await tmp('agent-ovl-');
    const cwd = await tmp('agent-cwd-');
    await writeFile(join(src, 'CLAUDE.md'), 'BASE');
    await writeFile(join(overlay, 'CLAUDE.md'), 'OVERLAY');

    const staged = await stageAgentWorkspace(src, cwd, overlay);
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('overlay CLAUDE.md present → CLAUDE.append.md is ignored', async () => {
    const src = await tmp('agent-src-');
    const overlay = await tmp('agent-ovl-');
    const cwd = await tmp('agent-cwd-');
    await writeFile(join(src, 'CLAUDE.md'), 'BASE');
    await writeFile(join(overlay, 'CLAUDE.md'), 'OVERLAY');
    await writeFile(join(overlay, 'CLAUDE.append.md'), 'APPEND');

    const staged = await stageAgentWorkspace(src, cwd, overlay);
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('append-only (no overlay CLAUDE.md) concatenates onto base', async () => {
    const src = await tmp('agent-src-');
    const overlay = await tmp('agent-ovl-');
    const cwd = await tmp('agent-cwd-');
    await writeFile(join(src, 'CLAUDE.md'), 'BASE');
    await writeFile(join(overlay, 'CLAUDE.append.md'), 'APPEND');

    const staged = await stageAgentWorkspace(src, cwd, overlay);
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('BASE\n\nAPPEND');
    await staged.cleanup();
  });

  test('overlay-only CLAUDE.md with no public base stages correctly', async () => {
    const src = await tmp('agent-src-');       // no CLAUDE.md in src
    const overlay = await tmp('agent-ovl-');
    const cwd = await tmp('agent-cwd-');
    await writeFile(join(overlay, 'CLAUDE.md'), 'OVERLAY');

    const staged = await stageAgentWorkspace(src, cwd, overlay);
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('cleanup restores a pre-existing CLAUDE.md in cwd', async () => {
    const src = await tmp('agent-src-');
    const overlay = await tmp('agent-ovl-');
    const cwd = await tmp('agent-cwd-');
    await writeFile(join(src, 'CLAUDE.md'), 'BASE');
    await writeFile(join(overlay, 'CLAUDE.md'), 'OVERLAY');
    await writeFile(join(cwd, 'CLAUDE.md'), 'PREEXISTING');

    const staged = await stageAgentWorkspace(src, cwd, overlay);
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
    expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('PREEXISTING');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sdk/agent-workspace.test.ts`
Expected: the replace / mutual-exclusivity / overlay-only tests FAIL (today an overlay `CLAUDE.md` is not consulted; only `CLAUDE.append.md` is). The append-only test should already PASS.

- [ ] **Step 3: Implement replace + mutual exclusivity**

In `src/sdk/agent-workspace.ts`, replace the entire `// --- Stage CLAUDE.md file ---` block (currently lines ~96-117) with:

```ts
  // --- Stage CLAUDE.md file ---
  const claudeMdSource = join(agentSourceDir, 'CLAUDE.md');
  const claudeMdTarget = join(targetCwd, 'CLAUDE.md');
  const overlayClaudeMd = overlayDir ? join(overlayDir, 'CLAUDE.md') : undefined;
  const hasOverlayClaudeMd = !!overlayClaudeMd && existsSync(overlayClaudeMd);

  // Replace and append are mutually exclusive modes: an overlay CLAUDE.md OWNS
  // the file, so an overlay CLAUDE.append.md alongside it is ignored (+ warned).
  // CLAUDE.append.md only augments the PUBLIC base.
  if (hasOverlayClaudeMd && hasOverlayAppend) {
    console.warn(
      `[overlay] agent dir ${overlayDir}: both CLAUDE.md (replace) and ` +
      `CLAUDE.append.md present — append ignored; fold it into CLAUDE.md.`,
    );
  }
  const applyAppend = hasOverlayAppend && !hasOverlayClaudeMd;

  if (existsSync(claudeMdSource) || hasOverlayClaudeMd) {
    await backupTarget(claudeMdTarget, join(targetCwd, 'CLAUDE.md.bak'));

    if (applyAppend) {
      // Real concatenated file: public base CLAUDE.md + overlay append.
      const base = await readFile(claudeMdSource, 'utf8');
      const extra = await readFile(overlayAppend!, 'utf8');
      await writeFile(claudeMdTarget, `${base}\n\n${extra}`);
    } else if (hasOverlayClaudeMd) {
      // Overlay fully replaces — copy verbatim (real file, never a symlink into
      // the tracked source tree, consistent with the .claude/ copy-merge rule).
      await copyFile(overlayClaudeMd!, claudeMdTarget);
    } else {
      try {
        await symlink(claudeMdSource, claudeMdTarget, fileSymlinkType);
      } catch {
        // File symlinks need Developer Mode on Windows — fall back to copy
        await copyFile(claudeMdSource, claudeMdTarget);
      }
    }
    links.push(claudeMdTarget);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/sdk/agent-workspace.test.ts && bun run typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/agent-workspace.ts tests/sdk/agent-workspace.test.ts
git commit -m "feat(agent-workspace): overlay CLAUDE.md replace + replace/append exclusivity"
```

---

## Task 6: Docs + `private.example`

**Files:**
- Create: `private.example/agents/pr-reviewer/CLAUDE.md`
- Modify: `private.example/manifest.ts` (only if the file exists)
- Modify: `CLAUDE.md` (root) — "Agent Convention" section

- [ ] **Step 1: Add an example overlay agent prompt**

Create `private.example/agents/pr-reviewer/CLAUDE.md`:

```markdown
# PR Reviewer (overlay example)

This file REPLACES the public `src/agents/pr-reviewer/CLAUDE.md` when this
overlay is installed. Drop a full prompt here to own the agent's behaviour, or
use `CLAUDE.append.md` instead to only add to the public default (the two are
mutually exclusive — if both exist, the append is ignored).

<!-- Real deployments put their proprietary review guidance here. -->
```

- [ ] **Step 2: Add a manifest knobs snippet (only if `private.example/manifest.ts` exists)**

If `private.example/manifest.ts` exists, add an `agents` entry to the default-exported manifest object (keep existing fields):

```ts
  agents: {
    'pr-reviewer': {
      model: 'claude-opus-4-8',
      maxTurns: 120,
    },
  },
```

If the file does not exist, skip this step (no action).

- [ ] **Step 3: Document the two channels in the root `CLAUDE.md`**

In `CLAUDE.md`, in the "### Agent Convention" section, after the bullet list of agent files, add:

```markdown

**Overlay overrides (private deployments):** the public `CLAUDE.md` / `.claude/`
files are defaults. A private overlay at `private/agents/<name>/` may:
- ship a full `CLAUDE.md` to **replace** the public prompt, **or** a
  `CLAUDE.append.md` to **add** to it (mutually exclusive — replace wins);
- ship `.claude/` (rules/skills) which is copy-merged over the base;
- set typed knobs (`model`, `allowedTools`, `maxTurns`, `sharedPromptFragments`)
  via `OverlayManifest.agents['<name>']`.
Overrides are folded by `resolveAgentKnobs` at the `runAgent` chokepoint and
apply in both local and container runs.
```

- [ ] **Step 4: Verify + commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add private.example/ CLAUDE.md
git commit -m "docs(overlay): document + exemplify agent prompt/knob overrides"
```

---

## Final Verification

- [ ] **Run the full unit suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Optional manual smoke (overlay present):** with a real `private/agents/pr-reviewer/CLAUDE.md` and `manifest.agents['pr-reviewer'] = { maxTurns: 3 }`, run a pr-review and confirm the staged `CLAUDE.md` in the session cwd is the overlay copy and the agent config log (`AGENT CONFIG`) shows `maxTurns: 3`.

- [ ] **Push**

```bash
git push
```

---

## Spec Coverage Check

- Contract (`AgentConfigOverride`, `agents`, deprecated `models`) → Task 1.
- Prompt staging replace + mutual exclusivity + overlay-only + concurrency assumption → Task 5.
- Resolver + single fold point + model on `AgentResult` + error details → Tasks 2-4.
- Fail-fast validation (empty tools, missing fragments, unknown-tool warn) → Task 2.
- Manifest cache singleton / local DX → no code (documented in spec); behaviour relies on existing memoised `loadManifest`.
- Docs + example → Task 6.
- `models` stays dead (not consulted) → enforced by resolver in Task 2; deprecated in Task 1.
