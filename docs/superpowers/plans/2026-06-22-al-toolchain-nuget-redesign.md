# AL Toolchain NuGet Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Continia CLI the single owner of the AL compiler — fetch the self-contained `Microsoft.Dynamics.BusinessCentral.Development.Tools.Linux` nupkg from nuget.org (default: newest prerelease), cache + validate it, and invoke its `alc`. Drop the VSIX-alc scrape and the `al`→`alc` shim from DevOpsWorker.

**Architecture:** CLI gains an AL-tool manager (resolve version → download nupkg → unzip to a version-keyed cache → validate → expose alc path + analyzer dir). `resolveToolchain` gets a `nuget` source (CONTINIA_ALC_PATH still wins). DevOpsWorker stops fetching alc and removes the shim; keeps the VSIX only for the LSP host.

**Tech Stack:** TypeScript on Bun, `bun:test`. Spike-proven: `.Tools.Linux` alc is a self-contained ELF (no .NET runtime), compiles headless in ~1 s, analyzers bundled in `lib/net10.0/`.

**Design:** `docs/superpowers/specs/2026-06-22-al-toolchain-nuget-redesign-design.md`

**Repos:** `U:\Git\CLI` (most tasks) + `DevOpsWorker` (container).

## Verified facts (use these literally)
- Versions index: `GET https://api.nuget.org/v3-flatcontainer/microsoft.dynamics.businesscentral.development.tools.linux/index.json` → `{"versions":[...]}`. Prerelease versions carry a `-beta` suffix. Stable tops at `17.0.34.45391`; 18.x are all `-beta`.
- Download: `GET https://api.nuget.org/v3-flatcontainer/<id>/<ver>/<id>.<ver>.nupkg` (id + ver lowercase). It is a zip; 61 MB.
- Inside: `lib/net10.0/alc` (78 KB ELF, self-contained), analyzers `lib/net10.0/Microsoft.Dynamics.Nav.{CodeCop,AppSourceCop,UICop}.dll`.
- Existing CLI guard already merged path: `validateAlcBinary(path)` in `src/core/compiler.ts` returns null if ELF/PE, else an error string.
- `resolveAnalyzers(options)` (`src/core/analyzer-resolver.ts`) looks for DLLs in `<options.alExtPath>/bin/Analyzers/` — the nuget layout has them flat in `lib/net10.0/`, so the manager must expose that dir and the resolver must accept it.

---

## File Structure
- `U:\Git\CLI/src/core/al-nuget.ts` — **new**: version resolution + nupkg download/unzip/cache/validate. Pure-ish, HTTP + fs injected for tests.
- `U:\Git\CLI/src/core/al-toolchain.ts` — add a `nuget` source to `resolveToolchain`.
- `U:\Git\CLI/src/core/analyzer-resolver.ts` — also accept analyzers directly under `alExtPath` (nuget flat layout).
- `U:\Git\CLI/src/cli/commands/compile.ts` + `deploy.ts` — add `--alc-version` / `--stable` flags, thread to toolchain.
- `U:\Git\CLI/tests/core/al-nuget.test.ts` — **new**.
- `DevOpsWorker/docker/entrypoint.sh` — remove the `al` shim; export `CONTINIA_ALC_CACHE` → `/state/tools/alc`.
- `DevOpsWorker/docker/fetch-al-extension.sh` — trim to LSP-host only (stop owning alc).

---

## Task 1: Version resolution (`al-nuget.ts`)

**Files:** Create `U:\Git\CLI/src/core/al-nuget.ts`; Test `U:\Git\CLI/tests/core/al-nuget.test.ts`

- [ ] **Step 1: Failing test** — create `tests/core/al-nuget.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { pickAlcVersion } from "../../src/core/al-nuget";

const VERSIONS = [
  "16.0.28.13140", "17.0.34.45391",
  "18.0.36.64936-beta", "18.0.37.7221-beta", "18.0.37.11445-beta",
];

describe("pickAlcVersion", () => {
  test("default = newest including prerelease", () => {
    expect(pickAlcVersion(VERSIONS, {})).toBe("18.0.37.11445-beta");
  });
  test("--stable = newest without -beta", () => {
    expect(pickAlcVersion(VERSIONS, { stable: true })).toBe("17.0.34.45391");
  });
  test("explicit pin wins and must exist", () => {
    expect(pickAlcVersion(VERSIONS, { version: "18.0.36.64936-beta" })).toBe("18.0.36.64936-beta");
  });
  test("explicit pin not found throws", () => {
    expect(() => pickAlcVersion(VERSIONS, { version: "99.0.0.0" })).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run — fails** (`bun test tests/core/al-nuget.test.ts`): module missing.

- [ ] **Step 3: Implement `pickAlcVersion`** in `src/core/al-nuget.ts`:

```ts
export interface AlcVersionOpts {
  /** Exact version pin (wins over all). */
  version?: string;
  /** Opt out of prerelease — newest stable only. */
  stable?: boolean;
}

const isPrerelease = (v: string) => v.includes("-");

/** 4-part dotted compare; treats a prerelease (`-beta`) as lower than its stable. */
function compareVersions(a: string, b: string): number {
  const [ca, pa = ""] = a.split("-");
  const [cb, pb = ""] = b.split("-");
  const na = ca.split(".").map(Number);
  const nb = cb.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa === pb) return 0;
  if (pa === "") return 1;   // stable > its own prerelease
  if (pb === "") return -1;
  return pa < pb ? -1 : 1;
}

/** Choose the alc version from a nuget flat-container version list. */
export function pickAlcVersion(versions: string[], opts: AlcVersionOpts): string {
  if (opts.version) {
    if (!versions.includes(opts.version)) {
      throw new Error(`AL compiler version "${opts.version}" not found on the feed. Available newest: ${[...versions].sort(compareVersions).slice(-3).reverse().join(", ")}`);
    }
    return opts.version;
  }
  const pool = opts.stable ? versions.filter((v) => !isPrerelease(v)) : versions;
  if (pool.length === 0) throw new Error("No AL compiler versions available on the feed");
  return [...pool].sort(compareVersions).at(-1)!;
}
```

- [ ] **Step 4: Run — passes** (`bun test tests/core/al-nuget.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/core/al-nuget.ts tests/core/al-nuget.test.ts
git commit -m "feat(al-nuget): alc version resolution (default prerelease, --stable, pin)"
```

---

## Task 2: Download + unzip + cache + validate (`al-nuget.ts`)

**Files:** Modify `src/core/al-nuget.ts`; Test `tests/core/al-nuget.test.ts`

Inject the network + unzip so the test is hermetic (no real 61 MB download).

- [ ] **Step 1: Failing test** — append:

```ts
import { ensureAlc } from "../../src/core/al-nuget";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("ensureAlc", () => {
  test("downloads + extracts once, then reuses the cached valid alc", async () => {
    const cacheRoot = mkdtempSync(path.join(tmpdir(), "alc-cache-"));
    let downloads = 0;
    const deps = {
      listVersions: async () => ["18.0.37.11445-beta"],
      download: async (_url: string) => { downloads++; return Buffer.from("ZIPBYTES"); },
      // fake unzip: write a real ELF alc + an analyzer dll into <dest>/lib/net10.0
      unzip: async (_buf: Buffer, dest: string) => {
        const d = path.join(dest, "lib", "net10.0");
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, "alc"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
        writeFileSync(path.join(d, "Microsoft.Dynamics.Nav.CodeCop.dll"), "x");
      },
    };
    const a = await ensureAlc({ cacheRoot }, {}, deps);
    expect(existsSync(a.alcPath)).toBe(true);
    expect(a.analyzerDir.endsWith(path.join("lib", "net10.0"))).toBe(true);
    const b = await ensureAlc({ cacheRoot }, {}, deps); // second call: cached
    expect(b.alcPath).toBe(a.alcPath);
    expect(downloads).toBe(1);
  });
});
```

- [ ] **Step 2: Run — fails** (`ensureAlc` missing).

- [ ] **Step 3: Implement** `ensureAlc` + the default deps in `src/core/al-nuget.ts`:

```ts
import { existsSync, mkdirSync, chmodSync, rmSync } from "fs";
import path from "path";
import { validateAlcBinary } from "./compiler";

const PKG = "microsoft.dynamics.businesscentral.development.tools.linux";
const FEED = "https://api.nuget.org/v3-flatcontainer";

export interface EnsureAlcConfig { cacheRoot: string; }
export interface ResolvedAlc { version: string; alcPath: string; analyzerDir: string; }

export interface AlNugetDeps {
  listVersions: () => Promise<string[]>;
  download: (url: string) => Promise<Buffer>;
  unzip: (buf: Buffer, destDir: string) => Promise<void>;
}

/** Default deps: real nuget.org + a zip extractor. */
export function defaultDeps(): AlNugetDeps {
  return {
    listVersions: async () => {
      const r = await fetch(`${FEED}/${PKG}/index.json`);
      if (!r.ok) throw new Error(`nuget index ${r.status} for ${PKG}`);
      return ((await r.json()) as { versions: string[] }).versions ?? [];
    },
    download: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`nuget download ${r.status}: ${url}`);
      return Buffer.from(await r.arrayBuffer());
    },
    unzip: async (buf, destDir) => { await extractZip(buf, destDir); }, // see Task 2a
  };
}

/** Resolve + ensure the alc for the requested version is present in the cache. */
export async function ensureAlc(
  cfg: EnsureAlcConfig,
  opts: AlcVersionOpts,
  deps: AlNugetDeps = defaultDeps(),
): Promise<ResolvedAlc> {
  const version = pickAlcVersion(await deps.listVersions(), opts);
  const verDir = path.join(cfg.cacheRoot, version);
  const alcPath = path.join(verDir, "lib", "net10.0", "alc");
  const analyzerDir = path.dirname(alcPath);

  if (existsSync(alcPath) && validateAlcBinary(alcPath) === null) {
    return { version, alcPath, analyzerDir };
  }

  // (Re)install: download nupkg, unzip into verDir, chmod, validate.
  rmSync(verDir, { recursive: true, force: true });
  mkdirSync(verDir, { recursive: true });
  const url = `${FEED}/${PKG}/${version}/${PKG}.${version}.nupkg`;
  const buf = await deps.download(url);
  await deps.unzip(buf, verDir);
  if (!existsSync(alcPath)) throw new Error(`alc not found at ${alcPath} after extracting ${PKG} ${version}`);
  try { chmodSync(alcPath, 0o755); } catch { /* windows */ }
  const err = validateAlcBinary(alcPath);
  if (err) throw new Error(`Extracted alc is invalid: ${err}`);
  return { version, alcPath, analyzerDir };
}
```

- [ ] **Step 4: Run — passes**.

- [ ] **Step 5: Commit** (`feat(al-nuget): download/unzip/cache/validate alc nupkg`).

---

## Task 2a: Zip extraction helper (`extractZip`)

**Decision:** the nupkg is a standard zip. Node/Bun has no built-in unzip. **Verify first** whether the CLI already depends on a zip lib (it extracts VSIX elsewhere?): `grep -rnE "adm-zip|yauzl|unzipper|JSZip|fflate|Bun.*unzip" package.json src`.

- [ ] **Step 1:** If a zip lib is already a dep, use it. Else add `fflate` (pure JS, no native) — `bun add fflate` — and implement:

```ts
import { unzipSync } from "fflate";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

export async function extractZip(buf: Buffer, destDir: string): Promise<void> {
  const files = unzipSync(new Uint8Array(buf));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const out = path.join(destDir, name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
}
```

- [ ] **Step 2:** Add a test extracting a tiny in-memory zip (build with `fflate.zipSync`) and assert a file lands on disk.
- [ ] **Step 3:** Run + commit (`feat(al-nuget): zip extraction via fflate`).

(If `fflate` is undesirable, the fallback is shelling to `unzip` — but that breaks Windows local use; prefer the JS lib.)

---

## Task 3: Wire `nuget` source into `resolveToolchain` + analyzers

**Files:** `src/core/al-toolchain.ts`, `src/core/analyzer-resolver.ts`

- [ ] **Step 1:** In `resolveToolchain`, after the `CONTINIA_ALC_PATH` check (which still wins), add a `nuget` branch that, when a managed alc exists, returns `{ alcPath, argv0Args: [], source: "nuget", alExtPath: <analyzerDir> }`. (The async ensure happens in the command before calling `compile`; `resolveToolchain` itself stays sync — pass the resolved alc path via `CONTINIA_ALC_PATH` or a new optional arg. **Choose:** the command calls `ensureAlc`, sets `process.env.CONTINIA_ALC_PATH = alcPath` and an analyzer-dir hint, so the existing sync `resolveToolchain` picks it up via the env branch — minimal change.) Add `"nuget"` to the `source` union type if a distinct source is used.

- [ ] **Step 2:** `analyzer-resolver.ts`: when `<alExtPath>/bin/Analyzers/<dll>` does not exist, fall back to `<alExtPath>/<dll>` (the flat nuget layout). Add a unit test with a temp dir holding `Microsoft.Dynamics.Nav.CodeCop.dll` directly under `alExtPath` and assert it resolves.

- [ ] **Step 3:** Run analyzer + toolchain tests; commit (`feat(al): use nuget alc + flat analyzer layout`).

---

## Task 4: Command flags

**Files:** `src/cli/commands/compile.ts`, `deploy.ts`

- [ ] **Step 1:** Add `.option("--alc-version <v>", "Pin the AL compiler version")` and `.option("--stable", "Use the newest stable alc (default: newest prerelease)")` to both commands.
- [ ] **Step 2:** Before `compile(...)`/the deploy loop, resolve the cache root (`process.env.CONTINIA_ALC_CACHE ?? path.join(os.homedir(), ".continia", "alc")`), call `ensureAlc({cacheRoot}, {version: opts.alcVersion, stable: opts.stable})`, set `process.env.CONTINIA_ALC_PATH = alcPath` (so `compile()` uses it) and pass the analyzer dir.
- [ ] **Step 3:** Smoke (manual/CI): `continia compile Cloud --json` in the WI-79397 workspace → completes with real compiler output, no hang; `--stable` selects 17.x, default selects 18.x-beta.
- [ ] **Step 4:** Commit (`feat(cli): --alc-version/--stable flags; auto-provision alc`).

---

## Task 5: DevOpsWorker container

**Files:** `DevOpsWorker/docker/entrypoint.sh`, `docker/fetch-al-extension.sh`

- [ ] **Step 1:** `entrypoint.sh` — remove the `al`→`alc` shim block; `export CONTINIA_ALC_CACHE="${AL_TOOLS_DIR}/alc"` (persists on the state volume). Do NOT export the alc onto PATH anymore.
- [ ] **Step 2:** `fetch-al-extension.sh` — keep ONLY the LSP host extraction (`EditorServices.Host`); stop being the alc source (the `is_real_alc` self-heal guard can stay as defense for the LSP-era cache, or be removed with the alc role). The CLI now owns alc.
- [ ] **Step 3:** Rebuild prod image (`pwsh private/deploy/docker-build.ps1`); run the WI-79397 Cloud compile end-to-end inside a fresh container (empty alc cache) → CLI auto-downloads `.Tools.Linux` (default prerelease), compiles **sub-30 s**, analyzers load.
- [ ] **Step 4:** Commit (`feat(docker): CLI owns alc; drop VSIX-alc + al shim`).

---

## Final Verification
- [ ] `bun test` green in `U:\Git\CLI`.
- [ ] Fresh container, empty caches: `continia compile` on WI-79397 Cloud → sub-30 s, analyzers loaded, no hang.
- [ ] `--stable` vs default select 17.x vs 18.x-beta respectively.
- [ ] A deliberately-corrupt `CONTINIA_ALC_PATH` fails loud (validateAlcBinary), does not hang.

## Spec Coverage
- CLI owns alc via NuGet `.Tools.Linux` (self-contained, no .NET runtime) → T1–T4.
- Default prerelease + `--stable`/`--alc-version` → T1, T4.
- Validate-before-use → reuses shipped `validateAlcBinary` (T2 ensure + T4).
- Analyzers from flat `lib/net10.0/` → T3.
- DevOpsWorker drops VSIX-alc + shim, keeps VSIX for LSP → T5.
- Open: BC-major clamp (optional refinement, deferred); LSP-from-nuget (out of scope).
