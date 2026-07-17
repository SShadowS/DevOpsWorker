import { describe, test, expect, afterEach } from 'bun:test';
import type { z } from 'zod';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { exampleRepos } from '../../private.example/config/repos.ts';
import { resolveAgentMcpServers } from '../../src/sdk/run-agent.ts';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import { loadConfig } from '../../src/cli/config.ts';
import { loadManifest, resetManifestCache } from '../../src/overlay/loader.ts';

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
  'repos', 'companions', 'mcpServers', 'agents', 'ado', 'pipeline', 'envProvider',
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

// ---------------------------------------------------------------------------
// EFFECT guards (not just shape). Each test below drives a manifest field
// through its REAL resolution path (no mocks) and asserts the resolved output
// changed as a result. If a future change deletes the wiring for a field —
// e.g. `resolveAgentMcpServers` (the runAgent call site) stops reading
// `manifest.mcpServers`, or `loadConfig` stops consulting `getCachedManifest()`
// — the corresponding test here fails, even though the field would still
// type-check fine in `fullManifest` above.
//
// These are deliberately thin: the full precedence/validation/error-message
// behavior of the underlying pure helpers (`mergeMcpServers`, `resolveMcpServers`)
// is already covered by tests/sdk/run-agent-mcpservers.test.ts (Task 2) and
// tests/cli/config.test.ts (Task 3). This file only proves the contract-level
// linkage — that a populated manifest field actually reaches the real
// `runAgent` wiring, not merely that the pure helper it eventually calls works
// in isolation.
// ---------------------------------------------------------------------------

describe('extension points: advertised fields have EFFECT (drift guard)', () => {
  test('a populated manifest.mcpServers entry actually reaches the merged MCP map', () => {
    // Drives resolveAgentMcpServers — the exact composition runAgent calls at
    // its mcpServers call site (src/sdk/run-agent.ts) — not just the pure
    // mergeMcpServers helper. If that call site ever stops passing
    // manifest.mcpServers through (the regression this guard exists to catch),
    // `custom` disappears from the result and this test fails.
    const fakeConfig = {
      name: 'fake-agent',
      mcpServers: { foo: { command: 'echo', type: 'stdio' as const } },
    } as unknown as AgentConfig<z.ZodType>;
    const fakeState = {} as unknown as PipelineState;
    const manifest: OverlayManifest = {
      mcpServers: { custom: { command: 'custom-server' } },
    };

    const merged = resolveAgentMcpServers(fakeConfig, fakeState, manifest);

    // The agent's own server survives (ADD semantics)...
    expect(merged).toHaveProperty('foo');
    // ...and the manifest-declared server was folded in by the real call site.
    expect(merged).toHaveProperty('custom');
    expect(merged.custom).toEqual({ command: 'custom-server' });
  });

  describe('a populated manifest.ado field reaches loadConfig() output', () => {
    let dir: string | undefined;
    const savedOrgEnv = process.env['AZURE_DEVOPS_ORG'];

    afterEach(() => {
      resetManifestCache();
      if (savedOrgEnv === undefined) delete process.env['AZURE_DEVOPS_ORG'];
      else process.env['AZURE_DEVOPS_ORG'] = savedOrgEnv;
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    });

    test('flows through the real loadManifest -> getCachedManifest -> loadConfig path', async () => {
      // No env var in the way — the manifest value must be what wins.
      delete process.env['AZURE_DEVOPS_ORG'];

      dir = mkdtempSync(join(tmpdir(), 'manifest-contract-ado-test-'));
      writeFileSync(
        join(dir, 'manifest.ts'),
        `export default { ado: { organization: 'contract-guard-org' } };`,
      );

      await loadManifest({ dir, force: true });
      const config = loadConfig('/tmp/session');

      // Would fail if `loadConfig` stopped reading `getCachedManifest()?.ado`,
      // or if the manifest were no longer wired into `resolveAdoField`.
      expect(config.azureDevOps.organization).toBe('contract-guard-org');
    });
  });
});
