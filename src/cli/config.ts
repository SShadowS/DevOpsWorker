import { join } from 'path';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import { companionRegistry } from '../config/companions.ts';
import { getCachedManifest } from '../overlay/index.ts';

// ---------------------------------------------------------------------------
// Config loading — constructs PipelineConfig from env + CLI flags
// ---------------------------------------------------------------------------

/**
 * Resolve an ADO config field with precedence: env var → overlay manifest's
 * `ado` defaults → generic fallback, via nullish coalescing. Only `undefined`
 * counts as "unset" — an env var or manifest value explicitly set to `''` is
 * treated as a real value and wins, matching the plain `??` semantics used by
 * sibling fields (`repositoryId`/`repositoryName`) elsewhere in this file.
 *
 * Pure by design — this is the unit-test seam for the resolution order,
 * independent of where the env value and manifest value come from.
 */
export function resolveAdoField(
  envValue: string | undefined,
  manifestValue: string | undefined,
  fallback: string,
): string {
  return envValue ?? manifestValue ?? fallback;
}

/**
 * Build PipelineConfig from a session path and environment variables.
 */
export function loadConfig(sessionPath: string): PipelineConfig {
  const pat = process.env['AZURE_DEVOPS_PAT'] ?? '';
  // `getCachedManifest()` is sync and may be `null` if `loadManifest()` hasn't
  // resolved yet (cold cache) — that's fine, `resolveAdoField` just falls
  // through to the generic default below.
  const manifestAdo = getCachedManifest()?.ado;
  const org = resolveAdoField(process.env['AZURE_DEVOPS_ORG'], manifestAdo?.organization, 'your-org');

  return {
    azureDevOps: {
      organization: org,
      orgUrl: resolveAdoField(process.env['AZURE_DEVOPS_ORG_URL'], manifestAdo?.orgUrl, `https://dev.azure.com/${org}`),
      project: resolveAdoField(process.env['AZURE_DEVOPS_PROJECT'], manifestAdo?.project, 'Your Project'),
      repositoryId: process.env['AZURE_DEVOPS_REPO_ID'] ?? '00000000-0000-0000-0000-000000000000',
      repositoryName: process.env['AZURE_DEVOPS_REPO_NAME'] ?? 'Your Repository',
      ciPipelineId: parseInt(process.env['AZURE_DEVOPS_CI_PIPELINE'] ?? '0', 10),
      cdPipelineId: parseInt(process.env['AZURE_DEVOPS_CD_PIPELINE'] ?? '0', 10),
      areaPath: resolveAdoField(process.env['AZURE_DEVOPS_AREA_PATH'], manifestAdo?.areaPath, 'Your Area'),
      iterationPath: resolveAdoField(process.env['AZURE_DEVOPS_ITERATION'], manifestAdo?.iterationPath, 'Your Area'),
      pat,
    },

    paths: {
      sessionRoot: sessionPath,
      targetRepo: join(sessionPath, 'TargetRepo'),
      stateDir: '.pipeline/state',
    },

    checkpoints: {
      planApproval: {
        tag: 'plan-approved',
        rerunCommand: '/rerun-plan',
        timeoutHours: 168,
      },
      prPublished: {
        fixCommand: '/fix',
        timeoutHours: 168,
      },
      pollIntervalMinutes: 60,
    },

    revisionLoops: {
      maxAttempts: 5,
    },

    models: {
      default: 'claude-opus-4-8',
      perAgent: {
        // planner inherits the Opus 4.8 default — strong planning, cheap (Sonnet) coding.
        'coder': 'claude-sonnet-4-6',
        'draft-pr': 'claude-sonnet-4-6',
        'test-cases': 'claude-sonnet-4-6',
        'documenter': 'claude-sonnet-4-6',
      },
    },

    costs: {
      maxBudgetPerAgentUsd: undefined,
      maxBudgetPerRunUsd: undefined,
    },

    environment: {
      profileId: process.env['ENV_PROFILE_ID'],
      appPaths: (process.env['ENV_APP_PATHS'] ?? 'App/Cloud,App/Test').split(','),
      envCli: process.env['ENV_CLI'] ?? (process.platform === 'win32' ? '.tools/env-cli.exe' : '.tools/env-cli'),
    },

    repoKey: 'TargetRepo',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

/**
 * Build a PipelineConfig from a RepoConfig, a target repo path, and env vars.
 * This replaces the old loadConfig() for containerized runs.
 */
export function buildConfigFromRepo(
  repo: RepoConfig,
  env: Record<string, string | undefined>,
): PipelineConfig {
  const pat = env['AZURE_DEVOPS_PAT'];
  if (!pat) throw new Error('AZURE_DEVOPS_PAT is required');

  // Repo registration wins when present (it's the most specific source); below
  // that, the same env var → manifest.ado → generic default fallback as loadConfig.
  const manifestAdo = getCachedManifest()?.ado;
  const org = repo.azureDevOps.organization
    ?? resolveAdoField(env['AZURE_DEVOPS_ORG'], manifestAdo?.organization, 'your-org');
  const sessionRoot = env['SESSION_ROOT'] ?? '/workspace/session';

  // Build default appPaths from companions (exclude BC — external reference)
  const companionAppPaths = Object.entries(repo.companions)
    .filter(([k]) => k !== repo.repoKey)
    .filter(([k]) => k !== 'BC')
    .map(([k]) => `${k}/Cloud`);

  const defaultAppPaths = [
    ...companionAppPaths,
    `${repo.repoKey}/${repo.layout.appRoot}`,
    `${repo.repoKey}/${repo.layout.testAppRoot}`,
  ];

  return {
    azureDevOps: {
      organization: org,
      orgUrl: repo.azureDevOps.orgUrl ?? `https://dev.azure.com/${org}`,
      project: repo.azureDevOps.project,
      repositoryId: repo.azureDevOps.repositoryId,
      repositoryName: repo.azureDevOps.repositoryName,
      ciPipelineId: repo.azureDevOps.ciPipelineId ?? 0,
      cdPipelineId: repo.azureDevOps.cdPipelineId ?? 0,
      areaPath: repo.azureDevOps.areaPath,
      iterationPath: repo.azureDevOps.iterationPath ?? repo.azureDevOps.areaPath,
      pat,
    },

    paths: {
      sessionRoot,
      targetRepo: `${sessionRoot}/${repo.repoKey}`,
      stateDir: env['STATE_DIR'] ?? '.pipeline/state',
    },

    checkpoints: {
      planApproval: {
        tag: 'plan-approved',
        rerunCommand: '/rerun-plan',
        timeoutHours: 168,
      },
      prPublished: {
        fixCommand: '/fix',
        timeoutHours: 168,
      },
      pollIntervalMinutes: 60,
    },

    revisionLoops: {
      maxAttempts: 5,
    },

    models: {
      default: env['DEFAULT_MODEL'] ?? 'claude-opus-4-8',
      perAgent: {
        // planner inherits the Opus 4.8 default — strong planning, cheap (Sonnet) coding.
        'coder': 'claude-sonnet-4-6',
        'draft-pr': 'claude-sonnet-4-6',
        'test-cases': 'claude-sonnet-4-6',
        'documenter': 'claude-sonnet-4-6',
      },
    },

    costs: {
      maxBudgetPerAgentUsd: undefined,
      maxBudgetPerRunUsd: undefined,
    },

    environment: repo.envProvision
      ? {
          profileId: repo.envProvision.profileId,
          appPaths: (env['ENV_APP_PATHS'] ?? '').split(',').filter(Boolean).length > 0
            ? (env['ENV_APP_PATHS'] ?? '').split(',').filter(Boolean)
            : defaultAppPaths,
          envCli: env['ENV_CLI'] ?? (process.platform === 'win32' ? '.tools/env-cli.exe' : '.tools/env-cli'),
        }
      : undefined,

    repoKey: repo.repoKey,
    layout: repo.layout,
    companions: repo.companions,
  };
}

/**
 * Load a persisted PipelineConfig from the state directory.
 * Falls back to default config if not found.
 * Overrides the PAT from env if AZURE_DEVOPS_PAT is set.
 */
export async function loadConfigFromState(stateStore: IStateStore, workItemId: number): Promise<PipelineConfig> {
  const persisted = await stateStore.loadConfig(workItemId);

  if (!persisted) {
    console.warn('  ⚠️  No persisted config found, using defaults');
    return loadConfig(process.env['PIPELINE_SESSION'] ?? '.');
  }

  // Override PAT from env if set (avoids storing secrets on disk being the only source)
  const envPat = process.env['AZURE_DEVOPS_PAT'];
  if (envPat) {
    persisted.azureDevOps.pat = envPat;
  }

  return persisted;
}
