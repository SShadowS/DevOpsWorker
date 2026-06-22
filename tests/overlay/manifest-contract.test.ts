import { describe, test, expect } from 'bun:test';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { exampleRepos } from '../../private.example/config/repos.ts';

// ---------------------------------------------------------------------------
// OverlayManifest drift guard (open-source plan T4).
//
// The public contract a consumer's `private/manifest.ts` implements must not
// drift silently from `private.example/` + docs. This file is a COMPILE-TIME
// assertion: it fails `bun run typecheck` (and so CI) if any OverlayManifest
// field is added, removed, renamed, or has its type changed — forcing the
// example skeleton and extensibility docs to be updated in lockstep. The
// runtime `expect`s are a thin liveness check so the file also runs as a test.
// ---------------------------------------------------------------------------

// Every declared field of OverlayManifest, listed once. Kept in sync with the
// interface by the two-way exhaustiveness checks below.
const MANIFEST_KEYS = [
  'repos', 'companions', 'mcpServers', 'agents', 'models', 'ado', 'pipeline', 'envProvider',
] as const;
type DeclaredKey = typeof MANIFEST_KEYS[number];

// Two-way key coverage. If OverlayManifest gains a key not in MANIFEST_KEYS,
// `Missing` is non-never and `_noMissingKeys` fails to typecheck. If MANIFEST_KEYS
// names a key the interface no longer has, `Extra` is non-never and `_noExtraKeys`
// fails. Either way: red typecheck, not a silent pass.
type Missing = Exclude<keyof OverlayManifest, DeclaredKey>;
type Extra = Exclude<DeclaredKey, keyof OverlayManifest>;
const _noMissingKeys: [Missing] extends [never] ? true : ['OverlayManifest key not covered:', Missing] = true;
const _noExtraKeys: [Extra] extends [never] ? true : ['MANIFEST_KEYS has unknown key:', Extra] = true;

// Fully-populated manifest — exercises every field's TYPE, not just key presence.
// A type change to any field (e.g. `models: Record<string, number>`) breaks here.
const fullManifest: OverlayManifest = {
  repos: exampleRepos,
  companions: {
    Example: { url: 'https://example.invalid/_git/Dep', defaultBranch: 'main', readOnly: true },
  },
  mcpServers: { example: {} },
  agents: { coder: { model: 'claude-sonnet-4-6', maxTurns: 10 } },
  models: { coder: 'claude-sonnet-4-6' }, // @deprecated — kept to verify backwards-compat type-check
  ado: {
    organization: 'your-org',
    orgUrl: 'https://dev.azure.com/your-org',
    project: 'Your Project',
    areaPath: 'Your\\Area',
    iterationPath: 'Your\\Iteration',
  },
  pipeline: (_ctx) => [],
  envProvider: ({ config: _config }) => ({
    startEnv: async (_id, _stage) => {},
    stopEnv: async (_id, _opts, _stage) => {},
    deleteEnv: async (_id, _opts, _stage) => {},
    shareEnv: async (_id, _email, _stage) => {},
    reprovision: async (_wi, state, _cfg, _store) => state,
  }),
};

describe('OverlayManifest contract (drift guard)', () => {
  test('compile-time key coverage holds (both directions)', () => {
    expect(_noMissingKeys).toBe(true);
    expect(_noExtraKeys).toBe(true);
  });

  test('a fully-populated manifest exercises every declared field', () => {
    for (const key of MANIFEST_KEYS) {
      expect(fullManifest).toHaveProperty(key);
    }
  });

  test('private.example/ provides a valid (typed) repos registry', () => {
    expect(Object.keys(exampleRepos).length).toBeGreaterThan(0);
  });
});
