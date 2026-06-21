import { connectStores } from '../db/connect-stores.ts';
import { assertPreflight } from '../pipeline/preflight.ts';
import { runPipeline } from '../pipeline/orchestrator.ts';
import { buildDefaultPipeline, buildPipeline } from '../pipeline/pipeline-definition.ts';
import { loadManifest } from '../overlay/index.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { loadConfig, buildConfigFromRepo } from './config.ts';
import { buildPipelineContext } from './context.ts';
import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import { getRepoConfig } from '../config/repos.ts';
import { formatPlanComment, formatReadinessComment, formatTelemetrySummary } from '../formatters/devops-comment.ts';
import { postWorkItemComment, addWorkItemTags, removeWorkItemTags, updateWorkItemFields } from '../sdk/azure-devops-client.ts';
import { PipelineLogger } from '../sdk/pipeline-logger.ts';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Data-driven comment hooks — maps stage name to a formatter function.
// Adding future comment hooks = one line in this map, no callback changes.
// ---------------------------------------------------------------------------

const commentFormatters: Record<string, (wid: number, state: PipelineState) => string | null> = {
  analyzer: (wid, s) => s.readiness ? formatReadinessComment(wid, s.readiness) : null,
  planning: (wid, s) => s.devPlan ? formatPlanComment(wid, s.devPlan) : null,
};

// ---------------------------------------------------------------------------
// Data-driven field updates — maps stage name to work item field changes.
// ---------------------------------------------------------------------------

const fieldUpdates: Record<string, Record<string, string>> = {
  analyzer:   { 'System.State': 'Active' },
  'draft-pr': { 'System.BoardColumn': 'In Code Review' },
};

// ---------------------------------------------------------------------------
// Config resolution — REPO_CONFIG env var (container) or --session (local)
// ---------------------------------------------------------------------------

/**
 * Resolve PipelineConfig from either REPO_CONFIG env var (container mode)
 * or --session flag (local mode).
 */
export function resolveConfig(
  sessionPath: string | undefined,
): { config: PipelineConfig; repo?: RepoConfig } {
  const repoKey = process.env['REPO_CONFIG'];

  if (repoKey) {
    const repo = getRepoConfig(repoKey);
    const config = buildConfigFromRepo(
      repo,
      process.env as Record<string, string>,
    );
    return { config, repo };
  }

  if (sessionPath) {
    return { config: loadConfig(sessionPath) };
  }

  throw new Error(
    'Either REPO_CONFIG env var (container mode) or --session flag (local mode) is required',
  );
}

// ---------------------------------------------------------------------------
// pipeline run --work-item <id> --session <path>
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<void> {
  const { workItemId, sessionPath } = parseRunArgs(args);

  console.log(`Starting pipeline for work item #${workItemId}`);
  if (sessionPath) console.log(`Session: ${sessionPath}`);

  // Build config
  const { config, repo } = resolveConfig(sessionPath);
  // Fail loud on placeholder ADO config (missing env / incomplete overlay repo).
  assertRealAdoConfig(config, 'pipeline-run');

  // Preflight checks
  console.log('\nRunning preflight checks...');
  const preflight = assertPreflight(config);
  for (const check of preflight.checks) {
    const icon = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }
  console.log('');

  // Build pipeline context (fetches work item from Azure DevOps)
  const context = await buildPipelineContext(workItemId, config);

  // Attach per-stage file logger (logDir computed here, logger created after db is open)
  const logDir = process.env['LOG_DIR']
    ?? (process.env['STATE_DIR'] ? join(resolve(process.env['STATE_DIR'], '..'), 'logs') : '.pipeline/logs');

  // Load private overlay (empty {} when none installed) and build pipeline
  config.overlay = await loadManifest();
  const stages = repo ? buildPipeline(config, repo) : buildDefaultPipeline(config);
  config.activeStages = stages.map(s => s.name);
  const { stateStore, logSink } = await connectStores();
  const logger = new PipelineLogger(logDir, workItemId, logSink(workItemId));
  context.logger = logger;
  await stateStore.saveConfig(workItemId, config);

  // Run (fresh start — discard any leftover state from previous runs)
  const finalState = await runPipeline({
    stages,
    context,
    stateStore,
    freshStart: true,
    onStageComplete: async (stage, state) => {
      console.log(`  ✅ ${stage.name} completed`);

      const format = commentFormatters[stage.name];
      const comment = format?.(workItemId, state);
      if (comment) {
        try {
          await postWorkItemComment(workItemId, comment, config);
          console.log(`  📝 Posted comment to work item`);
        } catch (err) {
          console.warn(`  ⚠️  Failed to post comment: ${err}`);
        }
      }

      // Tag work item with need-input at checkpoints
      try {
        if (state.checkpoint) {
          await addWorkItemTags(workItemId, ['need-input'], config);
          console.log(`  🏷️  Added "need-input" tag`);
        } else if (stage.name.startsWith('checkpoint:')) {
          await removeWorkItemTags(workItemId, ['need-input'], config);
          console.log(`  🏷️  Removed "need-input" tag`);
        }
      } catch (err) {
        console.warn(`  ⚠️  Failed to update need-input tag: ${err}`);
      }

      // Update work item fields (state, board column) based on stage
      const fields = fieldUpdates[stage.name];
      if (fields) {
        try {
          await updateWorkItemFields(workItemId, fields, config);
          console.log(`  📋 Updated work item fields: ${Object.keys(fields).join(', ')}`);
        } catch (err) {
          console.warn(`  ⚠️  Failed to update work item fields: ${err}`);
        }
      }
    },
  });

  // Summary
  console.log('\n' + formatTelemetrySummary(finalState.telemetry));

  if (finalState.checkpoint) {
    console.log(`\n⏸️  Pipeline paused at checkpoint: ${finalState.checkpoint.name}`);
    console.log(`   Run 'pipeline continue --work-item ${workItemId}' to check again`);
  } else if (finalState.completedAt) {
    console.log(`\n✅ Pipeline completed successfully`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseRunArgs(args: string[]): { workItemId: number; sessionPath: string | undefined } {
  let workItemId: number | undefined;
  let sessionPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--work-item' || arg === '-w') && args[i + 1]) {
      workItemId = parseInt(args[++i]!, 10);
    } else if ((arg === '--session' || arg === '-s') && args[i + 1]) {
      sessionPath = args[++i]!;
    }
  }

  if (!workItemId || isNaN(workItemId)) {
    console.error('Error: --work-item <id> is required');
    process.exit(1);
  }

  return { workItemId, sessionPath };
}
