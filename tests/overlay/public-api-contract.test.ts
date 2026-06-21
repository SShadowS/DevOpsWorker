import { describe, test, expect } from 'bun:test';
import * as api from '../../src/overlay/public-api.ts';

// ---------------------------------------------------------------------------
// Overlay public-API drift guard (open-source plan T8).
//
// src/overlay/public-api.ts is THE stable surface overlays import. This test
// pins that surface two ways:
//   1. Compile-time: the `import type` block below names every exported TYPE.
//      Remove or rename one → red `bun run typecheck` (CI).
//   2. Runtime: the exact set of exported VALUES is asserted. Add or remove a
//      value export without updating EXPECTED_VALUE_EXPORTS → red test.
// Either way a contract change is deliberate (update this file) rather than a
// silent break of every downstream overlay.
// ---------------------------------------------------------------------------

// (1) Type surface — importing these asserts they still exist & are exported as
// types. Unused on purpose; presence is the assertion.
import type {
  OverlayManifest,
  PipelineBuildContext,
  AdoDefaults,
  PipelineEdit,
  Stage,
  PipelineState,
  PipelineContext,
  PipelineConfig,
  WorkItem,
  AgentConfig,
  McpServerConfig,
  RepoConfig,
  RepoRegistry,
  CompanionDef,
  IStateStore,
  EnvProvider,
  EnvProviderFactory,
} from '../../src/overlay/public-api.ts';
// The `import type` block above IS the compile-time assertion: if any of these
// is removed or renamed in the barrel, this import fails to resolve (TS2305) and
// `bun run typecheck` goes red. No further usage needed.

// (2) Value surface — the exact set of runtime exports overlays may use.
const EXPECTED_VALUE_EXPORTS = [
  'registerRepos',
  'findRepoByRepoKey',
  'registerCompanions',
  'agentStage',
  'runAgent',
  'azureDevOpsMcp',
  'fetchWorkItem',
  'TOOL_SETS',
  'BC_MCP_TOOLS',
  'PipelineError',
  'ExternalServiceError',
] as const;

describe('overlay public-API contract (drift guard)', () => {
  test('exports every expected value symbol', () => {
    const bag = api as Record<string, unknown>;
    for (const name of EXPECTED_VALUE_EXPORTS) {
      expect(bag[name], `missing public-API export: ${name}`).toBeDefined();
    }
  });

  test('exports EXACTLY the expected value surface (no silent add/remove)', () => {
    const actual = Object.keys(api).sort();
    const expected = [...EXPECTED_VALUE_EXPORTS].sort();
    expect(actual).toEqual(expected);
  });
});
