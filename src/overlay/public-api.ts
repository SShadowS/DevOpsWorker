// ---------------------------------------------------------------------------
// Overlay Public API
//
// THE stable surface a private overlay (and `private.example/`) may depend on.
// Overlays must import ONLY from this module — never reach into other `src/`
// internals. Everything re-exported here is part of the versioned contract:
// changing or removing an export is a breaking change to overlays (and is
// guarded by tests/overlay/public-api-contract.test.ts). Anything NOT exported
// here is a core internal and may change without notice.
//
// Consumers: `import type { OverlayManifest } from '<core>/src/overlay/public-api.ts'`
// (when the overlay lives at `<core>/private/`, that is `../../src/overlay/public-api.ts`).
// ---------------------------------------------------------------------------

// --- The overlay contract (what a manifest implements) ---------------------
export type {
  OverlayManifest,
  PipelineBuildContext,
  AdoDefaults,
} from './types.ts';
export type { PipelineEdit } from './stage-edit.ts';

// --- Core domain types an overlay's stages / providers operate on ----------
export type {
  Stage,
  PipelineState,
  PipelineContext,
  PipelineConfig,
  WorkItem,
} from '../types/pipeline.types.ts';
export type { AgentConfig, McpServerConfig } from '../types/agent.types.ts';
export type { RepoConfig, RepoRegistry } from '../config/repo-config.ts';
export type { CompanionDef } from '../config/companions.ts';
export type { IStateStore } from '../pipeline/state-store.interface.ts';

// --- Environment provider seam (BC test-environment backend) ---------------
export type { EnvProvider, EnvProviderFactory } from '../sdk/env-provider.ts';

// --- Registry API (register/lookup repos + companions) ---------------------
export { registerRepos, findRepoByRepoKey } from '../config/repos.ts';
export { registerCompanions } from '../config/companions.ts';

// --- Stage + agent construction --------------------------------------------
export { agentStage } from '../pipeline/stage.ts';
export { runAgent } from '../sdk/run-agent.ts';

// --- MCP server + tool-set helpers (for overlay-contributed agent stages) --
export { azureDevOpsMcp, TOOL_SETS, BC_MCP_TOOLS } from '../sdk/mcp-configs.ts';

// --- Azure DevOps REST helpers an overlay stage may need -------------------
export { fetchWorkItem } from '../sdk/azure-devops-client.ts';

// --- Error hierarchy (overlays throw/extend these) -------------------------
export { PipelineError, ExternalServiceError } from '../sdk/errors.ts';
