import { join } from 'path';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { ISettingsStore } from '../config/settings-store.interface.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import { companionRegistry } from '../config/companions.ts';
import { getRepoConfig } from '../config/repos.ts';
import { getCachedManifest } from '../overlay/index.ts';
import { validateSetting } from '../config/schemas.ts';

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
/**
 * Parse `DEFAULT_EFFORT` into the SDK's reasoning-effort level.
 *
 * Shared by BOTH config builders on purpose. Their divergence is exactly how
 * `DEFAULT_MODEL` came to be honoured by one and ignored by the other, leaving a
 * documented control silently inert — see `models.default` below.
 *
 * Returns `undefined` for unset, blank, or unrecognised values, which leaves the SDK
 * default (`'high'`) in place. An unrecognised value is a no-op rather than an error:
 * a typo must not hand the SDK an invalid level mid-review.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export function parseEffort(raw: string | undefined): PipelineConfig['models']['effort'] {
  const v = (raw ?? '').trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as PipelineConfig['models']['effort'])
    : undefined;
}

/**
 * Build the models/costs block shared by `loadConfig` and `buildConfigFromRepo`.
 *
 * This used to be duplicated verbatim between the two builders, with `perAgent`
 * hardcoded in both — the reason `DEFAULT_MODEL` was honoured by one and silently
 * inert on the other (see `tests/config/model-resolution.test.ts`). There is now
 * exactly one copy, so the two builders cannot drift apart again.
 *
 * Precedence, checked independently per field: a database `settings` value wins
 * when present and passes its zod schema (`src/config/schemas.ts`); otherwise the
 * matching environment variable; otherwise the code default below. A malformed
 * stored value (wrong type, out of range, unknown enum member) is IGNORED with a
 * `console.warn` rather than thrown — this runs on every config assembly, so one
 * bad row in `settings` must not brick every pipeline run that reads it.
 */
export function buildModelsAndCosts(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown>,
): { models: PipelineConfig['models']; costs: PipelineConfig['costs'] } {
  function fromSettings<T>(key: string): T | undefined {
    if (!(key in settings)) return undefined;
    const result = validateSetting(key, settings[key]);
    if (!result.valid) {
      console.warn(`  ⚠️  Ignoring malformed "${key}" setting: ${result.errors.map(e => e.message).join('; ')}`);
      return undefined;
    }
    return result.value as T;
  }

  return {
    models: {
      // `||` not `??`: the container env forwards unset vars as '', and an empty
      // string is not nullish — `??` would hand an empty model id to the SDK.
      // This was a bare literal in one of the two builders this function
      // replaces, which made DEFAULT_MODEL inert on every path through it —
      // notably review-pr.ts, the PR reviewer — while looking wired, because the
      // variable IS in the container env allowlist and DOES arrive correctly.
      // Measured on a spawned container: process.env.DEFAULT_MODEL was
      // "claude-opus-4-8" while models.default resolved to "claude-opus-5".
      default: fromSettings<string>('models.default') ?? (env['DEFAULT_MODEL'] || 'claude-opus-5'),
      effort: fromSettings<PipelineConfig['models']['effort']>('models.effort') ?? parseEffort(env['DEFAULT_EFFORT']),
      perAgent: fromSettings<Record<string, string>>('models.perAgent') ?? {
        // planner inherits the Opus 5 default — strong planning, cheap (Sonnet) coding.
        'coder': 'claude-sonnet-5',
        'draft-pr': 'claude-sonnet-5',
        'test-cases': 'claude-sonnet-5',
        'documenter': 'claude-sonnet-5',
      },
    },

    costs: {
      maxBudgetPerAgentUsd: fromSettings<number>('costs.maxBudgetPerAgentUsd'),
      maxBudgetPerRunUsd: fromSettings<number>('costs.maxBudgetPerRunUsd'),
    },
  };
}

export function loadConfig(sessionPath: string, settings: Record<string, unknown> = {}): PipelineConfig {
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
      maxAttempts: Number(process.env['REVISION_MAX_ATTEMPTS']) || 5,
    },

    ...buildModelsAndCosts(process.env, settings),

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
  settings: Record<string, unknown> = {},
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
      // Overridable so a run can be capped without a code change — useful when
      // measuring a loop's early behaviour without paying for the full budget.
      maxAttempts: Number(env['REVISION_MAX_ATTEMPTS']) || 5,
    },

    ...buildModelsAndCosts(env, settings),

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
 * Fetch every stored setting, tolerating a database outage. An operator's saved
 * settings must not be REQUIRED for a pipeline to run: on a missing store or a
 * failed read, this returns `{}` so config assembly falls back to environment
 * variables and code defaults, exactly as it did before settings existed.
 */
async function readAllSettingsSafely(store: ISettingsStore | undefined): Promise<Record<string, unknown>> {
  if (!store) return {};
  try {
    return await store.getAll();
  } catch (err) {
    console.warn(`  ⚠️  Failed to read settings from the database, using environment/code defaults: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * Build the config this deployment would produce right now, using the same
 * resolution order as the start-fresh path in `run.ts`: the repo registry when
 * `REPO_CONFIG` is set (container mode), generic defaults otherwise (local mode).
 *
 * Resolving via `loadConfig()` alone was wrong for containers: it yields
 * placeholder ADO coordinates (`your-org` / `Your Project`), so a resumed run with
 * no persisted config looked its work item up in an organisation that does not
 * exist and died on a 404.
 *
 * `settingsStore` is optional so this stays usable without a database connection
 * (e.g. the polling config built at watcher startup); when omitted, settings
 * default to `{}` and the result is identical to before settings existed.
 */
async function buildCurrentConfig(settingsStore?: ISettingsStore): Promise<PipelineConfig> {
  const settings = await readAllSettingsSafely(settingsStore);
  const repoKey = process.env['REPO_CONFIG'];
  if (repoKey) {
    return buildConfigFromRepo(getRepoConfig(repoKey), process.env as Record<string, string>, settings);
  }
  return loadConfig(process.env['PIPELINE_SESSION'] ?? '.', settings);
}

/**
 * Load a persisted PipelineConfig for a resumed work item.
 *
 * Two kinds of setting live in PipelineConfig, and they need opposite treatment:
 *
 * - **Run-scoped identity** — repo coordinates, paths, layout, companions. These
 *   must stay exactly as captured when the item first started; a run that changed
 *   target repo or session path halfway would be incoherent. This is why config is
 *   persisted at all.
 * - **Operational policy** — models, revision budgets, cost caps, checkpoint
 *   settings. These belong to the *deployment*, not to the run, and must be taken
 *   fresh every time.
 *
 * Returning the persisted config wholesale froze the second kind too. A work item
 * resumed after a deployment silently ran the policy captured at its first start:
 * observed in production when a run resumed a day after a model bump still reported
 * the previous models, with no error and nothing in the logs to indicate why.
 *
 * Falls back to defaults when nothing is persisted. Overrides the PAT from env so
 * the stored copy is never the only source of a secret.
 *
 * `settingsStore` is optional and forwarded to `buildCurrentConfig` unchanged —
 * omitting it (as existing callers that predate the settings table do) reproduces
 * exactly the environment/code-default behaviour from before this parameter existed.
 */
export async function loadConfigFromState(
  stateStore: IStateStore,
  workItemId: number,
  settingsStore?: ISettingsStore,
): Promise<PipelineConfig> {
  const persisted = await stateStore.loadConfig(workItemId);
  const current = await buildCurrentConfig(settingsStore);

  if (!persisted) {
    console.warn('  ⚠️  No persisted config found, rebuilding from the repo registry');
    return current;
  }

  // Override PAT from env if set (avoids storing secrets on disk being the only source)
  const envPat = process.env['AZURE_DEVOPS_PAT'];
  if (envPat) {
    persisted.azureDevOps.pat = envPat;
  }

  return {
    ...persisted,
    models: current.models,
    revisionLoops: current.revisionLoops,
    costs: current.costs,
    checkpoints: current.checkpoints,
  };
}
