# Coder Deps Pre-stage — Plan A (Overlay Floor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the coder hunting/recompiling dependency symbols on multi-companion BC repos by (1) fatally pre-staging the symbol closure into `.alpackages` at env-provision and (2) orienting the coder (repo structure, `.dependencies`-are-normal) + putting `--workspace-root` into the deploy commands it's given.

**Architecture:** All changes are in the **overlay** (`private/`); the public DevOpsWorker core is untouched (it has no `continia` concept). Plan A is the independently-testable floor — it gets a run *to* publish. Plan B (separate) closes the publish-side fights (CLI version-validation + the installed-baseline/AppSourceCop deploy recipe).

**Tech Stack:** Bun + TypeScript, `bun:test`. Overlay env-provision shells out to the `continia` CLI.

**Spec:** `docs/superpowers/specs/2026-06-23-coder-deps-prestage-orientation-design.md`

---

## File Structure
- `private/sdk/continia-cli.ts` — already exports `downloadDeps`; no change.
- `private/pipeline/env-provision.ts` — add `downloadDeps` to the `EnvProvisionDeps`
  interface + wiring, and call it (fatal) after `installDeps` in the appPaths loop. (Modify)
- `private/tests/pipeline/env-provision.test.ts` — add an execute-path test asserting
  `downloadDeps` runs per app path and is fatal on failure. (Modify)
- `private/agents/coder/CLAUDE.append.md` — add Repository-Structure + `.dependencies`
  orientation; add `--workspace-root` to the deploy commands. (Modify)

---

## Task 1: Fatal symbol pre-stage in env-provision

**Files:**
- Modify: `private/pipeline/env-provision.ts`
- Test: `private/tests/pipeline/env-provision.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `private/tests/pipeline/env-provision.test.ts` (inside the top-level
`describe('env-provision', ...)`). It drives the full execute path with mocked
deps and asserts `downloadDeps` is called once per app path, after `installDeps`.

```ts
import { mock } from 'bun:test';

// Build a depsOverride whose mocks let execute() run through to the deps loop.
// Return shapes mirror continia-cli: createEnv → ContiniaEnv, fetchEnvCredentials
// → { credentials, selectedBy }, resolveBcProfile → a profile id string.
function fullDeps(over: Record<string, any> = {}) {
  const env = { id: 'env-1', status: 'Running', description: 'WI-42', url: 'https://e', profileId: 'p', createdUtc: '' };
  return {
    resolveBcProfile: mock(async () => 'test-profile-id'),
    createEnv: mock(async () => env),
    startEnv: mock(async () => {}),
    pollUntilRunning: mock(async () => {}),
    installAppById: mock(async () => {}),
    fetchEnvCredentials: mock(async () => ({ credentials: { username: 'u', password: 'pw' }, selectedBy: 'flag' })),
    installDeps: mock(async () => {}),
    downloadDeps: mock(async () => {}),
    ...over,
  };
}

test('execute pre-stages symbols (downloadDeps) once per app path', async () => {
  const ctx = mockContext();
  const deps = fullDeps();
  const stage = envProvision(ctx.config, deps as any);
  const state = freshState({ devPlan: { summary: 't', steps: [], testPlan: [] } as any });
  await stage.execute(state, ctx);
  const appPaths = ['DocumentOutput/Cloud', 'DocumentOutput/Test'];
  expect(deps.downloadDeps.mock.calls.map((c: any[]) => c[2])).toEqual(appPaths);
  // installDeps must run before downloadDeps for each path
  expect(deps.installDeps.mock.calls.map((c: any[]) => c[2])).toEqual(appPaths);
});

test('execute FAILS the stage when downloadDeps rejects (fatal, not swallowed)', async () => {
  const ctx = mockContext();
  const deps = fullDeps({ downloadDeps: mock(async () => { throw new Error('symbol 25.x not found'); }) });
  const stage = envProvision(ctx.config, deps as any);
  const state = freshState({ devPlan: { summary: 't', steps: [], testPlan: [] } as any });
  await expect(stage.execute(state, ctx)).rejects.toThrow(/symbol 25.x not found/);
});
```

NOTE: `mockContext()`'s config has `repoKey: 'DocumentOutput'`, `layout.appRoot:
'Cloud'`, `layout.testAppRoot: 'Test'`, so the appPaths the loop builds are
`DocumentOutput/Cloud` and `DocumentOutput/Test`. If the execute path needs other
mock return values to reach the deps loop (e.g. a specific env field), read the
`envProvision` execute flow and adjust the `fullDeps` returns until the first test
reaches the loop — the assertions stay as written.

- [ ] **Step 2: Run the test — expect FAIL**

Run: `bun test private/tests/pipeline/env-provision.test.ts`
Expected: FAIL — `deps.downloadDeps` is not part of `EnvProvisionDeps` / never called.

- [ ] **Step 3: Wire `downloadDeps` into env-provision**

In `private/pipeline/env-provision.ts`:

(a) Import it — extend the existing `from '../sdk/continia-cli.ts'` import block
(which already imports `installDeps as defaultInstallDeps`):
```ts
  installDeps as defaultInstallDeps,
  downloadDeps as defaultDownloadDeps,
```

(b) Add to the `EnvProvisionDeps` interface (after `installDeps`):
```ts
  installDeps: typeof defaultInstallDeps;
  downloadDeps: typeof defaultDownloadDeps;
```

(c) Add to the `deps` wiring object (after the `installDeps:` line):
```ts
        installDeps: depsOverride?.installDeps ?? defaultInstallDeps,
        downloadDeps: depsOverride?.downloadDeps ?? defaultDownloadDeps,
```

(d) In the appPaths loop (the one guarded by `!credentials` that runs
`installDeps`), add the download after the install. Replace:
```ts
          for (const appPath of appPaths) {
            context.logger?.log(`Installing app dependencies for ${appPath}`);
            await deps.installDeps(cliPath, env.envId, appPath, config.paths.sessionRoot);
          }
```
with:
```ts
          for (const appPath of appPaths) {
            context.logger?.log(`Installing app dependencies for ${appPath}`);
            await deps.installDeps(cliPath, env.envId, appPath, config.paths.sessionRoot);
            // Pre-stage the transitive symbol closure into <appPath>/.alpackages so the
            // coder's LOCAL compile finds symbols first-try (no missing-symbols hunt, no
            // recompiling companions). FATAL on failure: a partial pre-stage hands the
            // coder a broken env and recreates the deps death-spiral — better to fail the
            // stage loud (it's retryable) and surface the deps/version bug at provision time.
            context.logger?.log(`Pre-staging dependency symbols for ${appPath}`);
            await deps.downloadDeps(cliPath, env.envId, appPath, config.paths.sessionRoot);
          }
```
(`downloadDeps` already throws an `ExternalServiceError` on non-zero CLI exit, so
no extra error handling is needed — the surrounding try/catch preserves the
partial env and rethrows, failing the stage. Do NOT wrap it in a try/catch that
swallows.)

- [ ] **Step 4: Run the test — expect PASS**

Run: `bun test private/tests/pipeline/env-provision.test.ts`
Expected: PASS (both new tests + existing tests green).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
```bash
git add private/pipeline/env-provision.ts private/tests/pipeline/env-provision.test.ts
git commit -m "feat(env-provision): fatally pre-stage dependency symbols (deps download) for Cloud+Test"
```

---

## Task 2: Coder orientation + `--workspace-root` in the deploy commands

**Files:**
- Modify: `private/agents/coder/CLAUDE.append.md`

This is prose/agent-instruction content. "Test" = it renders into the staged
prompt and contains the required anchors; verified by a grep assertion + the
overlay suite staying green.

- [ ] **Step 1: Add the Repository Structure + `.dependencies` sections**

Insert near the top of `private/agents/coder/CLAUDE.append.md` (before the
"Definition of Done" section), a new block. Frame it generically (the append is
shared across overlay repos) — the target app comes from the task prompt:

```markdown
## Repository Structure — what to build vs. what to read

Your workspace (the session root) contains your **target extension** (named in
your task prompt, e.g. `DocumentOutput/`) plus its **dependency companion repos**
cloned as siblings (e.g. `Core/`, `DeliveryNetwork/`, `DocumentCapture/`, and the
`BC/` base-app reference). Continia extension map: **Core** = foundation/shared;
**Delivery Network** = electronic document delivery; **Document Capture** =
capture/recognition; **Document Output** = output/email.

- **Read the companion source freely** (Grep/Glob/Read/LSP) to understand APIs and
  patterns and make good decisions — that is why it is in your workspace.
- **NEVER compile, deploy, or `--with-deps` a companion.** They are *dependencies*,
  not your apps. Their compiled **symbols are pre-staged in `.alpackages`** by
  env-provision. You build **only your target app** (its `Cloud` and `Test` dirs).
- Reading source and building are separate: scoping the build to your app (below)
  does NOT limit what you can read.

### `.dependencies/` folders are normal code

In Continia repos, a `.dependencies/` folder is a legacy naming artifact (auto-
translated C/AL → AL). Files in it are regular, compiled, shipped AL source
belonging to the **same** extension as the surrounding folders — NOT a separate
extension, NOT read-only, NOT a symbol cache. Treat them like any other folder; do
not flag changes to `.dependencies/` as suspicious, no-op, or architecturally wrong.
```

- [ ] **Step 2: Pin `--workspace-root` in the deploy commands**

In the same file, the deploy step currently shows:
```
   continia deploy <envId> <target-repo>/Cloud --allow-downgrade --json
   continia deploy <envId> <target-repo>/Test --allow-downgrade --json
```
Replace those two lines with (add `--workspace-root` pinned to each app dir):
```
   continia deploy <envId> <target-repo>/Cloud --workspace-root <target-repo>/Cloud --allow-downgrade --json
   continia deploy <envId> <target-repo>/Test --workspace-root <target-repo>/Test --allow-downgrade --json
```
And add a sentence right after them:
```markdown
   **Always pass `--workspace-root <your-app-dir>`** — it scopes the build to your
   app so the CLI does not pick up the sibling companion source dirs as
   `workspace-local` and try to recompile them (their symbols are pre-staged). It
   does NOT affect what you can read.
```

- [ ] **Step 3: Verify render + anchors**

Run:
```bash
grep -c "Repository Structure — what to build" private/agents/coder/CLAUDE.append.md
grep -c "\.dependencies/ folders are normal code" private/agents/coder/CLAUDE.append.md
grep -c "\-\-workspace-root <target-repo>/Cloud" private/agents/coder/CLAUDE.append.md
```
Expected: each prints `1` (or more).

Run the overlay suite + typecheck to confirm nothing else broke:
`bun test private/tests/ && bun run typecheck`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add private/agents/coder/CLAUDE.append.md
git commit -m "feat(coder): repo-structure + .dependencies orientation; pin --workspace-root in deploy"
```

---

## Final Verification (Plan A)
- [ ] `bun test private/tests/ && bun run typecheck` — green.
- [ ] **Manual smoke (optional, real env):** a multi-companion WI reaches local
  compile with symbols already in `.alpackages` (no agent-run `deps download`), and
  the transcript shows no companion recompile. (It may still hit the installed-
  baseline/AppSourceCop fight — that's Plan B.)

## Spec Coverage (Plan A portion)
- Fatal pre-stage of Cloud+Test symbols → Task 1.
- Repository-structure / `.dependencies` orientation → Task 2 Step 1.
- `--workspace-root` injected into the given deploy command (the enforcement
  "floor") → Task 2 Step 2.

## Deferred to Plan B (CLI repo + harder overlay)
- The deps **version-validation** fix (so the fatal Test-app pre-stage can succeed
  on test-framework symbols) — **note:** until Plan B lands, Task 1's fatal
  download may fail on repos whose Test symbols hit the validation bug; that is the
  intended loud surfacing, and Plan B fixes the toolchain.
- The deterministic installed-baseline / AppSourceCop deploy **recipe** in the
  `continia-deploy` skill + env-provision AppSourceCop baseline alignment.
- The **hard** PreToolUse `--workspace-root` guard (needs a core/overlay hook-
  injection mechanism the overlay-override system doesn't yet provide).
