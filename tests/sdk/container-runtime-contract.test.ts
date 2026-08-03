import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getContainerEnv } from '../../src/cli/watch/container-dispatcher.ts';

// ---------------------------------------------------------------------------
// The container runtime contract.
//
// Code in `scripts/` runs INSIDE a spawned container, where the only environment
// is what `getContainerEnv()` forwards plus what the image bakes. A script that
// reads an env var nobody sets does not fail loudly — it silently takes its
// default and behaves as if configured.
//
// That is not hypothetical. `await-pipeline.ts` read `ADO_ORG_URL` / `ADO_PROJECT`,
// names that exist nowhere in this repo, the overlay, `.env` or the Dockerfile, so
// every invocation fell through to the placeholder `https://dev.azure.com/your-org`
// and got a route-level 404 that read as "build not found". Measured across the log
// table: 11 work items, 83 occurrences, 2026-03-20 to 2026-08-02 — every
// containerized coder run since March had no working CI wait, and nothing failed
// visibly enough to notice.
//
// Both guards below are about REACHABILITY, not correctness: a name that resolves
// and a path that exists. Neither can tell you the value is right.
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Env names baked into the image itself — available without being forwarded. */
const IMAGE_BAKED = new Set(
  (readFileSync(join(repoRoot, 'Dockerfile'), 'utf8').match(/^ENV\s+([A-Z_][A-Z0-9_]*)/gm) ?? [])
    .map((m) => m.replace(/^ENV\s+/, '')),
);

/**
 * Names a script may read WITHOUT the container forwarding them, each for a
 * stated reason. Anything else must be forwarded, or it silently takes a default.
 * Keep this list short and justified — it is the escape hatch that let the
 * original bug through.
 */
const EXEMPT: Record<string, string> = {
  // Set by the runtime itself, not by us.
  HOME: 'set by the OS/shell in every container',
  PATH: 'set by the OS/shell in every container',
  PWD: 'set by the OS/shell in every container',
  // Host-side tooling only — these scripts are not run inside spawned containers.
  npm_config_user_agent: 'bun/npm runtime detail, host-side only',
  PROBE_MODEL: 'probe-lsp-diagnostics.ts — dev tooling, run by hand on the host',
  PROBE_MAX_TURNS: 'probe-lsp-diagnostics.ts — dev tooling, run by hand on the host',
  TEST_MODEL: 'test-lsp-availability.ts / test-warmup-simulation.ts — dev harness, explicit -e when containerized',
  TEST_MAX_TURNS: 'test-lsp-availability.ts / test-warmup-simulation.ts — dev harness, explicit -e when containerized',
  // Deliberate ALIASES, read only as a fallback after the forwarded
  // AZURE_DEVOPS_* names. They are expected to be unset; `resolveOrgUrl` and
  // `assertOrgConfigured` handle that loudly rather than silently. Reading these
  // as the ONLY source is the bug this file exists to prevent.
  ADO_ORG_URL: 'legacy alias for AZURE_DEVOPS_ORG_URL — fallback only, absence is handled',
  ADO_PROJECT: 'legacy alias for AZURE_DEVOPS_PROJECT — fallback only, absence is handled',
};

function scriptFiles(): string[] {
  const dir = join(repoRoot, 'scripts');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Every environment read in a source file.
 *
 * Matches `process.env.NAME`, `process.env['NAME']`, AND a bare `env.NAME` on an
 * injected `NodeJS.ProcessEnv` parameter. That third form is not pedantry: the fix
 * for the original bug refactored the read into `resolveOrgUrl(env = process.env)`,
 * which made it invisible to a `process.env`-only sweep — this guard went green
 * while the new name still was not forwarded and production stayed broken.
 * Uppercase-only, since env names are uppercase by convention and matching any
 * `.foo` property access would drown the result.
 */
function envReads(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/process\.env\[['"]([^'"]+)['"]\]/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]!);
  return [...names];
}

describe('container runtime contract — env vars', () => {
  test('getContainerEnv is the forwarding allowlist and is non-empty', () => {
    // Guards the guard: if this ever returns {} the sweep below passes vacuously.
    expect(Object.keys(getContainerEnv()).length).toBeGreaterThan(5);
  });

  test('every env var a script reads is forwarded to containers, baked, or exempt', () => {
    const forwarded = new Set(Object.keys(getContainerEnv()));
    const offenders: string[] = [];

    for (const file of scriptFiles()) {
      for (const name of envReads(readFileSync(file, 'utf8'))) {
        if (forwarded.has(name) || IMAGE_BAKED.has(name) || name in EXEMPT) continue;
        offenders.push(`${file.replace(repoRoot, '')}: ${name}`);
      }
    }

    // A script reading an unforwarded name does not crash — it takes its default
    // and reports a confidently wrong result. Add the name to the allowlist in
    // `getContainerEnv()`, or justify it in EXEMPT above.
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Script paths quoted to agents.
//
// An agent's cwd inside a container is the SESSION root, which has no `scripts/`
// directory — the scripts live at `/app/scripts/`. A relative `bun scripts/x.ts`
// therefore dies with `Module not found`, which is what happened to every
// await-pipeline invocation. The ci-waiter's own prompt already used the absolute
// path while the rules and the script's own resume hint printed a relative one,
// so the waiter was handed a command it was told to re-run verbatim and could not.
// ---------------------------------------------------------------------------

/** Files whose text is handed to an agent and may quote a runnable command. */
function agentFacingFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(md|ts)$/.test(e.name)) out.push(full);
    }
  };
  walk(join(repoRoot, 'src', 'agents'));
  // The script's own resume hint is agent-facing too: the ci-waiter is told to
  // re-run exactly what it prints.
  out.push(join(repoRoot, 'scripts', 'await-pipeline.ts'));
  return out;
}

describe('container runtime contract — script paths quoted to agents', () => {
  test('no agent-facing text tells an agent to run a RELATIVE scripts/ path', () => {
    const offenders: string[] = [];
    // `bun scripts/foo.ts` — relative, resolves against the session root, dies.
    // `bun run scripts/foo.ts` is the same defect wearing a subcommand, and the
    // first version of this guard missed it: the file's own usage header used that
    // form and passed. Absolute `/app/scripts/foo.ts` is correct and not matched.
    const relative = /bun\s+(?:run\s+)?scripts\/[\w.-]+\.ts/g;

    for (const file of agentFacingFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const hit of src.match(relative) ?? []) {
        offenders.push(`${file.replace(repoRoot, '')}: ${hit}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every /app/scripts path quoted to an agent exists in the repo', () => {
    // Absolute is necessary but not sufficient — the file has to be there, or the
    // agent gets `Module not found` from a path that merely looks right.
    const shipped = new Set(scriptFiles().map((f) => f.replace(repoRoot, '').replace(/\\/g, '/')));
    const offenders: string[] = [];

    for (const file of agentFacingFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\/app\/(scripts\/[\w.-]+\.ts)/g)) {
        if (!shipped.has(m[1]!)) offenders.push(`${file.replace(repoRoot, '')}: /app/${m[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
