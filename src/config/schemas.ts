import { z } from 'zod';
import type { RepoConfig } from './repo-config.ts';
import type { CompanionDef } from './companions.ts';

// ---------------------------------------------------------------------------
// Repo config
// ---------------------------------------------------------------------------
//
// The `z.ZodType<RepoConfig>` (and `z.ZodType<CompanionDef>` below) annotations
// are load-bearing: they make a field added to the source type without a
// matching field added here a COMPILE ERROR, instead of a value the admin API
// would silently drop. Keep every field here mirroring `RepoConfig` one for
// one — same optionality, same nesting.

const azureDevOpsSchema = z.object({
  organization: z.string().optional().describe('Azure DevOps organization name override'),
  orgUrl: z.string().optional().describe('Full Azure DevOps organization URL override'),
  project: z.string().min(1).describe('Azure DevOps project name'),
  repositoryId: z.string().min(1).describe('Azure DevOps repository GUID'),
  repositoryName: z.string().min(1).describe('Azure DevOps repository name'),
  ciPipelineId: z.number().optional().describe('CI pipeline id to trigger after the coder pushes'),
  cdPipelineId: z.number().optional().describe('CD pipeline id, if this repo has a separate deployment pipeline'),
  areaPath: z.string().min(1).describe('Work item area path this repo watches'),
  iterationPath: z.string().optional().describe('Work item iteration path override; defaults to areaPath when omitted'),
}).strict();

const wizardSchema = z.object({
  instructions: z.string().min(1).describe('Per-app wizard instructions for the bc-activation stage'),
}).strict();

const envProvisionSchema = z.object({
  profileId: z.string().optional().describe('Operator override: pin a specific environment profile GUID, skipping the portal lookup'),
  bcVersion: z.string().optional().describe("Operator override: pin a specific BC version (e.g. '28.0.0.0')"),
  region: z.string().optional().describe("Regional profile to pick (e.g. 'GB', 'DE'); defaults to 'GB'"),
  bcUser: z.string().optional().describe('Override for credential selection'),
  wizard: wizardSchema.optional().describe('Per-app wizard instructions; presence enables the bc-activation stage'),
}).strict();

const docsWriterSchema = z.object({
  docsRepoUrl: z.string().min(1).describe('Git URL of the docs repository the documenter agent writes to'),
}).strict();

const companionOverrideSchema = z.object({
  branch: z.string().optional().describe('Branch override for this companion; defaults to the registry entry'),
  readOnly: z.boolean().optional().describe('Whether the agent may branch or modify this companion; defaults to the registry entry'),
}).strict();

const layoutSchema = z.object({
  appRoot: z.string().min(1).describe("App root for deployment — directory containing app.json (e.g. 'Cloud')"),
  source: z.string().min(1).describe("Path to production AL source (e.g. 'Cloud/Al')"),
  testAppRoot: z.string().min(1).describe("App root for the test extension (e.g. 'Test')"),
  test: z.string().min(1).describe("Path to test AL source (e.g. 'Test/Src')"),
}).strict();

export const repoConfigSchema: z.ZodType<RepoConfig> = z.object({
  active: z.boolean().optional().describe('Whether this repo is ready for pipeline processing; inactive repos are ignored by the watcher'),
  autoReview: z.boolean().optional().describe('Auto-review PRs on creation; omitted/true reviews every new PR'),
  reviewDrafts: z.boolean().optional().describe('Auto-review draft PRs; omitted/false skips drafts on creation'),
  url: z.string().min(1).describe('Git clone URL'),
  branch: z.string().min(1).describe("Branch to work from (e.g. 'master', 'main')"),
  azureDevOps: azureDevOpsSchema.describe('Azure DevOps settings for this repo'),
  envProvision: envProvisionSchema.optional().describe('BC environment provisioning; presence enables the env-provision stage'),
  testCases: z.boolean().optional().describe('Presence enables the test-cases and test-case-activation stages'),
  docsWriter: docsWriterSchema.optional().describe('Presence enables the docs writer stage'),
  repoKey: z.string().min(1).describe('Key into the companion registry — also the directory name under the session root'),
  companions: z.record(z.string(), companionOverrideSchema).describe('Companion repos — keys are companion registry entries, values are optional overrides'),
  layout: layoutSchema.describe('Directory layout within the target repo'),
}).strict();

// ---------------------------------------------------------------------------
// Companion config
// ---------------------------------------------------------------------------

export const companionConfigSchema: z.ZodType<CompanionDef> = z.object({
  url: z.string().min(1).describe('HTTPS clone URL (PAT-compatible for Azure DevOps, plain for GitHub)'),
  defaultBranch: z.string().min(1).describe('Default branch'),
  readOnly: z.boolean().optional().describe('If true, this companion is never branched or modified by the agent'),
  symlinkOnly: z.boolean().optional().describe('If true, staged into the session as a symlink to the cache rather than a real local clone'),
}).strict();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
//
// Deployment policy an operator can change without a code edit. Each key maps
// to one row in the `settings` table. Mirrors the values `parseEffort` in
// `src/cli/config.ts` currently accepts — keep the two lists in sync.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const agentMaxTurnsSchema = z.number().int().min(1)
  .describe('Maximum turns the named agent stage may take before its run is stopped');

/** Matches a per-agent settings key, e.g. `agents.coder.maxTurns`. */
const AGENT_MAX_TURNS_KEY = /^agents\.[^.]+\.maxTurns$/;

export const settingsSchemas: Record<string, z.ZodTypeAny> = {
  'models.default': z.string().min(1)
    .describe('Default model id used when no per-agent override applies'),
  'models.perAgent': z.record(z.string().min(1), z.string().min(1))
    .describe('Agent name to model id override, for agents that should not use the default model'),
  'models.effort': z.enum(EFFORT_LEVELS)
    .describe('Reasoning effort level passed to the SDK; unset leaves the SDK default in place'),
  'costs.maxBudgetPerAgentUsd': z.number().positive()
    .describe('Maximum USD a single agent stage may spend before its run is stopped'),
  'costs.maxBudgetPerRunUsd': z.number().positive()
    .describe('Maximum total USD a pipeline run may spend before it is stopped'),
  'runner.maxConcurrency': z.number().int().min(1)
    .describe('Maximum number of pipeline runs the watcher may run at the same time'),
};

/** Resolves the schema for a settings key, including the per-agent `agents.<name>.maxTurns` family. */
function resolveSettingSchema(key: string): z.ZodTypeAny | undefined {
  if (key in settingsSchemas) return settingsSchemas[key];
  if (AGENT_MAX_TURNS_KEY.test(key)) return agentMaxTurnsSchema;
  return undefined;
}

export type SettingValidationResult =
  | { valid: true; value: unknown }
  | { valid: false; errors: Array<{ path: string; message: string }> };

/**
 * Validate a settings value against the schema for its key.
 *
 * Returns a discriminated result rather than throwing: the admin API (Task 10)
 * needs per-field messages to return a 400 that names the bad field, not an
 * exception to catch and re-wrap.
 */
export function validateSetting(key: string, value: unknown): SettingValidationResult {
  const schema = resolveSettingSchema(key);
  if (!schema) {
    return { valid: false, errors: [{ path: key, message: `Unknown settings key: "${key}"` }] };
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return { valid: true, value: result.data };
  }

  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : key,
      message: issue.message,
    })),
  };
}
