# Coder Deps Pre-stage — Plan B (Continia CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the publish-side fights that Plan A's fatal pre-stage will surface: (1) fix the deps version-resolution that rejects a dependency whose required version isn't an *exact* catalogue match (treat the requirement as a minimum), and (2) rework the `continia-deploy` skill so the agent deploys *scoped to its app with pre-staged symbols* instead of `--with-deps`/`--all` (which recompile companions), and treats AppSourceCop/AS0003 as CI's gate (not a local fight).

**Architecture:** All changes are in the **Continia CLI repo** (`U:\Git\CLI`). The deps fix is `src/core/demoportal-client.ts`; the skill is `skills/continia-deploy/SKILL.md` (synced into the overlay at image-build time). Public DevOpsWorker core untouched.

**Tech Stack:** TypeScript on Bun, `bun:test`.

**Spec:** `DevOpsWorker/docs/superpowers/specs/2026-06-23-coder-deps-prestage-orientation-design.md`. Prereq: Plan A (`...-planA-overlay.md`).

**Repo for ALL tasks:** `U:\Git\CLI` (branch off `main`).

---

## Task 1: deps version-resolution — treat a dependency version as a minimum

The bug: `getAppById(appId, bcVersion, target, version?)` filters catalogue builds
with **`a.version === version`** (exact). A dependency's `app.json` `version` is a
**minimum** ("≥"), so a dep requiring `25.0.0.0` when the catalogue only has `28.x`
→ 0 matches → "could not find" reject (the forensic test-framework symbol failure).
Fix: filter by `satisfiesMin`, and apply the env-major preference always (so we
don't install a build newer than the env's platform).

**Files:**
- Modify: `U:\Git\CLI/src/core/demoportal-client.ts`
- Test: `U:\Git\CLI/tests/core/demoportal-client.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

`getAppById` issues an HTTP GET via the client's injectable fetch. Build a client
with a fake fetch returning a catalogue and assert resolution. (Match the existing
client-construction pattern — `demoportal-client.ts:37` notes the 3rd ctor arg is a
`FetchFn`; read the constructor + an existing client test to copy the exact shape.)

```ts
import { describe, test, expect } from "bun:test";
import { DemoPortalClient } from "../../src/core/demoportal-client";

// Catalogue: same appId, builds 25.0.0.500 and 28.0.0.900. apps.json shape is the
// raw (snake_case) API; the client camelCases it. Mirror the real keys: app_id, version.
const CATALOGUE = [
  { app_id: "APPX", version: "25.0.0.500", name: "Test Lib", publisher: "MS" },
  { app_id: "APPX", version: "28.0.0.900", name: "Test Lib", publisher: "MS" },
];
function clientWithCatalogue() {
  const fakeFetch = async () => new Response(JSON.stringify(CATALOGUE), { status: 200 });
  // Construct per the real ctor signature (apiUrl/token/fetch). Adjust to match.
  return new DemoPortalClient({ apiUrl: "https://x", apiToken: "t" } as any, undefined as any, fakeFetch as any);
}

describe("getAppById version resolution", () => {
  test("a required version is a MINIMUM: requesting 25.0.0.0 resolves a 28.x build", async () => {
    const app = await (clientWithCatalogue() as any).getAppById("APPX", "28.0.0.0", "OnPrem", "25.0.0.0");
    expect(app?.version).toBe("28.0.0.900"); // highest satisfying >= 25, env major 28
  });

  test("prefers the env-major build, not the absolute highest", async () => {
    // env BC major 25 → prefer the 25.x build even though 28.x is higher
    const app = await (clientWithCatalogue() as any).getAppById("APPX", "25.0.0.0", "OnPrem", "25.0.0.0");
    expect(app?.version).toBe("25.0.0.500");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test tests/core/demoportal-client.test.ts`
Expected: FAIL — exact-match returns `undefined` for the `25.0.0.0` request, or
picks the wrong build.

- [ ] **Step 3: Fix `getAppById`**

In `src/core/demoportal-client.ts`, ensure `satisfiesMin` is imported from
`./version` (alongside the existing `versionMajor`, `compareAppVersion`):
```ts
import { satisfiesMin, versionMajor, compareAppVersion } from "./version";
```
Replace the resolution block (currently the `if (version) matches = matches.filter(
(a) => a.version === version);` line through the `return matches[0];` at the end of
the method) with:
```ts
    // A dependency's app.json `version` is a MINIMUM (">="), not an exact build.
    if (version) matches = matches.filter((a) => satisfiesMin(a.version, version));
    if (matches.length === 0) return undefined;
    matches.sort((a, b) => compareAppVersion(b.version, a.version));

    // Prefer the highest build whose major matches the env's BC version — installing
    // a build newer than the env's platform fails with app_add_not_possible. Fall back
    // to the overall highest when the env's major has no satisfying build.
    const bcMajor = versionMajor(bcVersion);
    const sameMajor = matches.filter((a) => versionMajor(a.version) === bcMajor);
    return sameMajor[0] ?? matches[0];
```
(This applies the env-major preference unconditionally — previously it was gated on
`!version`, which is what let an exact-version request bypass it.)

- [ ] **Step 4: Run — expect PASS + no regressions**

Run: `bun test tests/core/demoportal-client.test.ts && bun test tests/core/`
Expected: the 2 new tests pass; the broader core suite stays green. (If an existing
test asserted the old exact-match `undefined`, update it — exact-as-minimum is the
intended change; report any such test.)

- [ ] **Step 5: Commit**

```bash
git add src/core/demoportal-client.ts tests/core/demoportal-client.test.ts
git commit -m "fix(deps): treat a dependency version as a minimum (>=) and prefer env-major build"
```

---

## Task 2: Rework the `continia-deploy` skill — scope to the app, don't recompile companions

The skill's "Strategy Selection" leads with `--with-deps` (recompiles workspace
companion source) and `--all --workspace-root <sessionRoot>` (discovers everything)
— the exact patterns that burned the budget. Rework it to default to a **scoped,
pre-staged** deploy and treat AppSourceCop/AS0003 as CI's gate.

**Files:**
- Modify: `U:\Git\CLI/skills/continia-deploy/SKILL.md`

This is agent-instruction content; "test" = the new guidance is present and the old
traps are gone (grep assertions).

- [ ] **Step 1: Replace the "Strategy Selection" section**

Replace the entire `## Strategy Selection` block (from that heading down to just
before `**Override schema sync mode**`) with:

```markdown
## Strategy Selection

**Default — deploy ONLY your target app, scoped, against pre-staged symbols.**
Your dependency symbols are already in `.alpackages` (the pipeline pre-stages them;
when coding manually run `continia deps download <envId> <appPath>` once). So you
do NOT compile or deploy your dependencies — you deploy just your app:
```bash
continia deploy <envId> <appPath> --workspace-root <appPath> --allow-downgrade --json
```
- **`--workspace-root <appPath>`** scopes app discovery to your app so sibling
  dependency source dirs (e.g. `Core/`, `DeliveryNetwork/`) are NOT picked up and
  recompiled. It does not affect what you can read.
- **`--allow-downgrade`** lets your branch build replace the higher-versioned
  CI-built baseline the env already has (BC refuses a downgrade by default).

**Do NOT use `--with-deps` or `--all` for a normal change.** `--with-deps`
recompiles your dependency apps from their source dirs (slow, fails without their
own deps, and unnecessary — their symbols are pre-staged). `--all` discovers every
app in the workspace (including 200+ BC base apps). Deploy your specific app only.

**`--with-deps` is ONLY for the rare case** where you genuinely changed a
companion's source and must rebuild it as part of your change — not for resolving
missing symbols (use `continia deps download` for that).
```

- [ ] **Step 2: Add AppSourceCop/AS0003 local guidance**

In the `## Result Interpretation` failure list, add a bullet (after the
"Specified part" bullet):

```markdown
- **AppSourceCop `AS0003` (baseline missing) on a LOCAL deploy:** AppSourceCop's
  breaking-change baseline is an **AppSource-submission gate enforced in CI**, not a
  requirement for deploying to your test env. Do NOT hand-edit `AppSourceCop.json`
  to strip its `version`/baseline. Instead deploy with a ruleset that excludes the
  AppSourceCop analyzer locally — ship/point to a sibling `.cli-ruleset.json` (see
  Rulesets) without `${AppSourceCop}` in `al.codeAnalyzers`, or pass
  `--ruleset <that-file>`. CI still runs the full AppSourceCop gate.
```

- [ ] **Step 3: Fix the stale "Gotchas" so it agrees with the new default**

In `## Gotchas`, the `--all deploys too much` bullet already warns against `--all`
— keep it. Update the "Deploy from the correct working directory" bullet to also
mention `--workspace-root`:
```markdown
- **Deploy from the session root and pin `--workspace-root`** — pass
  `--workspace-root <appPath>` so discovery is scoped to your app regardless of cwd,
  and sibling dependency source isn't treated as workspace-local.
```

- [ ] **Step 4: Verify the traps are gone + the defaults are in**

Run:
```bash
# the default scoped command is present:
grep -c "deploy <envId> <appPath> --workspace-root <appPath> --allow-downgrade" skills/continia-deploy/SKILL.md
# the AS0003 local guidance is present:
grep -c "AppSourceCop .AS0003. (baseline missing) on a LOCAL deploy" skills/continia-deploy/SKILL.md
# --with-deps is NO LONGER presented as a normal-path default (only the "rare case" mention remains):
grep -c "with local dependencies (or fresh env)" skills/continia-deploy/SKILL.md   # expect 0
```
Expected: first two ≥1, the third `0`.

- [ ] **Step 5: Commit**

```bash
git add skills/continia-deploy/SKILL.md
git commit -m "fix(skill): default continia-deploy to scoped --workspace-root; drop --with-deps/--all default; AS0003-is-CI guidance"
```

---

## Final Verification (Plan B)
- [ ] `bun test tests/core/` green in `U:\Git\CLI`.
- [ ] The reworked skill no longer leads with `--with-deps`/`--all`; the default is
  the scoped `--workspace-root` deploy.
- [ ] **Deploy (after merge):** the skill is synced into the overlay at image-build
  (`docker-build.ps1`); a new prod image picks it up. The deps fix ships in the new
  `continia` binary baked into that image.
- [ ] **End-to-end (with Plan A):** a multi-companion WI run reaches local compile
  (symbols pre-staged) → deploys scoped (no companion recompile) → publishes
  (`--allow-downgrade`, no AS0003 fight) → tests — well within turn budget.

## Spec Coverage (Plan B portion)
- Deps version-validation / major-resolution fix → Task 1.
- Deterministic deploy recipe (scoped deploy + `--allow-downgrade`) in the
  `continia-deploy` skill → Task 2 Step 1.
- AppSourceCop/AS0003 handling (CI's gate, ruleset-skip locally) → Task 2 Step 2.

## Still deferred
- The **hard** PreToolUse `--workspace-root` guard (needs a core/overlay hook-
  injection mechanism). Plan A's injected command + this skill default are the
  enforcement floor; the hard guard is a separate task if injected-command proves
  insufficient in practice.
- A deeper `continia deps`/`deploy` resolver change to ignore sibling companion
  source even WITHOUT `--workspace-root` — verify `--workspace-root` is sufficient
  (Plan A smoke) before considering it.
