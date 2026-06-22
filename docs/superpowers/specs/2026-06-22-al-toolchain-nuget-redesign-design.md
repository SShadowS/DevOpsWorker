# AL Toolchain Redesign — Continia CLI owns alc via NuGet/.NET

**Date:** 2026-06-22
**Status:** Design (spike-proven), pending implementation plan
**Repos:** `U:\Git\CLI` (Continia CLI) + `DevOpsWorker` (container/entrypoint)

## Problem

The AL compiler (`alc`) is currently obtained and managed by **DevOpsWorker**, not
the Continia CLI, and discovered by the CLI through a fragile 3-tier guess. This
split ownership produced a production failure: a corrupted `alc` (a 252-byte
self-execing shell wrapper) sat cached on the shared `do-pipeline-state` volume,
survived the version-marker cache skip, and made **every compile hang in an
infinite exec loop** — costing one work item ~2.6 h / $16 / 200 turns before the
coder gave up. The real `alc` compiles the same project in **~1 second**.

### Current mechanism (the smell)
- **DevOpsWorker** `docker/fetch-al-extension.sh` scrapes the **VS Code
  Marketplace** for the *latest* `ms-dynamics-smb.al` VSIX, extracts `bin/` to
  `/state/tools/al-extension/`, caches by a `.version` marker, and the entrypoint
  hand-writes an `al`→`alc` shim onto `$PATH`.
- **Continia CLI** `src/core/al-toolchain.ts:resolveToolchain` checks
  `CONTINIA_ALC_PATH` (unset) → `~/.vscode/extensions/ms-dynamics-smb.al-*`
  (absent in the container) → falls back to invoking bare `al` (the shim). It
  ignores `AL_EXTENSION_PATH` (the var the container actually exports) and never
  validates that the resolved `alc` is a real binary.
- Nobody owns alc end-to-end; a garbage file silently becomes a 2.6 h hang.

(Stop-gaps already shipped on branches `fix/alc-cache-guard` + `fix/alc-binary-guard`:
fetch self-heals a corrupt cache + `chmod +x`; the CLI `validateAlcBinary` fails
loud on a non-binary alc. Those are guards, not the fix.)

## Decision

Make the **Continia CLI the single owner of the AL compiler**, sourced from the
**official Microsoft NuGet AL tools** (`Microsoft.Dynamics.BusinessCentral.Development.Tools`)
instead of scraping the VSIX. DevOpsWorker stops managing alc.

### Spike evidence (in `devopsworker:latest`, against the real WI-79397 app)
- .NET 8 installs cleanly via `curl https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0` (no apt feed).
- `dotnet tool install --global Microsoft.Dynamics.BusinessCentral.Development.Tools` → `al` tool from **nuget.org, public, no auth**. Stable = `17.0.34`; `--prerelease` = `18.0.37.11445-beta`.
- `al compile /project:<p> /packagecachepath:<p>` is a thin alc wrapper (**same args** as alc), runs **headless on Linux in 0–1 s**, returns real `AL1022`/`AL1018` errors — **no hang**.
- **Analyzers bundled** (`Microsoft.Dynamics.Nav.CodeCop.dll`, `…AppSourceCop.dll`).
- nuget.org carries `16.x`/`17.x`/`18.x` + `18.x-beta` → version is pinnable; `--prerelease` is the preview channel.
- Platform-specific package `…Tools.Linux` is **self-contained** (RESOLVED): its
  nupkg ships alc at `lib/net10.0/alc` (the same 78 KB ELF) bundling its own
  runtime (`libcoreclr.so`, `libhostfxr.so`, 414 files). Verified: alc runs and
  compiles the 552-file Cloud app **with no `dotnet` installed**. So **no .NET
  runtime is needed in the image** — just download + unzip the nupkg.
  - Caveat: `…Tools.Linux` 18.x is currently **`-beta` only** (stable tops at
    17.0.34); BC 28/29 ⇒ use the **preview channel** (`--prerelease`).

Why this is the right architecture, not symptom-patching: it deletes the entire
fragile subsystem — marketplace scrape, `.version` cache, self-exec shim, missing
`chmod`, discovery guessing, "latest vs needed" version drift. Every defect we
hit becomes **structurally impossible**, and it's the supported MS distribution.

## Design

### 1. Continia CLI — own the toolchain lifecycle
A toolchain manager that does: **resolve version → ensure installed → discover →
validate → invoke**.

- **Version resolution** (precedence):
  1. explicit `--alc-version <x.y.z.w>` flag / config;
  2. `--preview` (a.k.a. `--prerelease`) → newest pre-release on nuget.org;
  3. derived from the project's BC platform (`app.json` `application`/`platform`)
     — pick the matching `Microsoft.Dynamics.BusinessCentral.Development.Tools`
     major;
  4. default: newest stable.
- **Ensure installed:** download the **self-contained `…Tools.Linux` nupkg** for
  the resolved version from nuget.org (`v3-flatcontainer/<id>/<ver>/<id>.<ver>.nupkg`,
  public, no auth), unzip to a CLI-managed cache, `chmod +x lib/net10.0/alc`. No
  `dotnet tool install`, **no .NET runtime** — the package bundles its own.
  Idempotent; keyed by version so multiple BC versions coexist. (A `dotnet tool`
  install is the cross-platform alternative but needs the runtime; the
  self-contained platform nupkg avoids it on Linux.)
- **Discover:** deterministic path under the CLI cache — no `~/.vscode` /
  `AL_EXTENSION_PATH` guessing.
- **Validate:** reuse `validateAlcBinary` (already added) — a non-executable /
  stub fails loud, never hangs.
- **Invoke:** `al compile <alc-args>` (the tool wraps alc and accepts the same
  `/project:` args `buildCompileArgs` already emits) — or the bundled `alc`
  directly. Analyzers resolve from the tool's own package (drop the
  `alExtPath`-from-VSIX analyzer resolution).
- **Remove** the `altool-fallback` path and the assumption that an `al` shim
  exists on `$PATH`. `resolveToolchain` collapses to "the CLI-managed alc".

### 2. DevOpsWorker — stop managing alc
- Drop `fetch-al-extension.sh`'s alc responsibility and the entrypoint `al`→`alc`
  shim. The container just calls `continia compile`.
- **No .NET runtime needed** — the `…Tools.Linux` nupkg is self-contained
  (verified). The CLI does the download+unzip itself.
- **Keep** the VSIX fetch **only** for the AL **LSP** server
  (`Microsoft.Dynamics.Nav.EditorServices.Host`), which the LSP plugin still
  needs — unless that is also sourced from NuGet. Trim the fetch to just the LSP
  host to shrink it.

### 3. Backwards-compat / rollout
- The CLI change is additive: if a `CONTINIA_ALC_PATH` is set it still wins
  (escape hatch + the validation guard protects it).
- Ship the CLI first (it can self-provision alc even on the current image once
  .NET is present), then slim the container (remove shim + VSIX-alc).

## Open Questions (resolve before/within implementation)
1. **`…Tools.Linux` self-containment** — RESOLVED: self-contained, **no .NET
   runtime needed** (verified — alc compiled with no dotnet present). Remaining:
   confirm the **analyzers** (CodeCop/AppSourceCop) ship inside `…Tools.Linux`'s
   `lib/net10.0/` (very likely — 414 files — but verify), else source them
   separately.
2. **BC-version → alc-version mapping** — confirm the policy (match major to the
   app's `application` version vs. always-newest). The app targets BC 28/29;
   nuget has matching 18.x. Tie into the existing 3-version-axes knowledge
   ([[project_deps_wrong_major_28v29]]).
3. **LSP host source** — keep a trimmed VSIX pull for `EditorServices.Host`, or is
   the language server also on NuGet?
4. **Feed pinning/caching** — pin to nuget.org; decide on an offline/restore cache
   for reproducibility and to avoid per-container network installs.

## Testing / verification
- CLI unit: `validateAlcBinary` (done); toolchain version-resolution +
  preview-flag selection; discovery returns the CLI-managed path.
- Container integration: `continia compile` on the WI-79397 Cloud app (with
  symbols via `deps download`) completes **sub-30 s** with analyzers loaded; a
  poisoned/absent alc fails loud, not hangs.
- Regression: confirm a fresh container (empty caches) self-provisions alc and
  compiles with no manual steps.

## Related
- [[project_alc_toolchain_redesign]] (root cause + spike results)
- [[project_continia_cli_skill_sync]], [[project_env_publish_logo_backslash]]
