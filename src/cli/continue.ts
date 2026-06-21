import { connectStores } from '../db/connect-stores.ts';
import { runPipeline } from '../pipeline/orchestrator.ts';
import { buildDefaultPipeline } from '../pipeline/pipeline-definition.ts';
import { loadManifest } from '../overlay/index.ts';
import { loadConfigFromState } from './config.ts';
import { buildPipelineContext } from './context.ts';
import { formatTelemetrySummary } from '../formatters/devops-comment.ts';
import { removeWorkItemTags, addWorkItemTags, postWorkItemComment, updateWorkItemFields } from '../sdk/azure-devops-client.ts';
import { formatPlanComment, formatReadinessComment } from '../formatters/devops-comment.ts';
import type { PipelineState } from '../types/pipeline.types.ts';
import { PipelineLogger } from '../sdk/pipeline-logger.ts';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// pipeline continue --work-item <id>
// ---------------------------------------------------------------------------

export async function cont(args: string[]): Promise<void> {
  const workItemId = parseWorkItemArg(args);

  console.log(`Continuing pipeline for work item #${workItemId}`);

  // Load existing state
  const { stateStore, logSink } = await connectStores();
  // Use same log path logic as run.ts — write to Docker volume when STATE_DIR is set
  const logDir = process.env['LOG_DIR']
    ?? (process.env['STATE_DIR'] ? join(resolve(process.env['STATE_DIR'], '..'), 'logs') : '.pipeline/logs');
  const existingState = await stateStore.load(workItemId);

  if (!existingState) {
    console.error(`No pipeline state found for work item #${workItemId}`);
    console.error(`Run 'pipeline run --work-item ${workItemId} --session <path>' first`);
    process.exit(1);
  }

  console.log(`  Current stage: ${existingState.currentStage}`);

  if (existingState.checkpoint) {
    console.log(`  At checkpoint: ${existingState.checkpoint.name}`);
    console.log(`  Entered: ${existingState.checkpoint.enteredAt}`);
    console.log(`  Last polled: ${existingState.checkpoint.lastPolledAt ?? 'never'}`);
  }

  if (existingState.error) {
    console.log(`  ⚠️  Previous error at stage "${existingState.error.stage}": ${existingState.error.message}`);
    if (existingState.error.type === 'revision-exhausted') {
      existingState.skipResetState = true;
    }
    // Clear error for retry
    existingState.error = undefined;
  }

  // Load config from persisted file
  const config = await loadConfigFromState(stateStore, workItemId);

  // Remove need-input tag (safety net — even if checkpoint-resolution removal failed)
  try {
    await removeWorkItemTags(workItemId, ['need-input'], config);
  } catch (err) {
    console.warn(`  ⚠️  Failed to remove need-input tag: ${err}`);
  }

  // Build pipeline context (fetches work item from Azure DevOps)
  const context = await buildPipelineContext(workItemId, config);

  // Attach per-stage file logger
  const logger = new PipelineLogger(logDir, workItemId, logSink(workItemId));
  context.logger = logger;

  // Data-driven hooks (same as run.ts — duplicated here for simplicity)
  const commentFormatters: Record<string, (wid: number, s: PipelineState) => string | null> = {
    analyzer: (wid, s) => s.readiness ? formatReadinessComment(wid, s.readiness) : null,
    planning: (wid, s) => s.devPlan ? formatPlanComment(wid, s.devPlan) : null,
  };
  const fieldUpdates: Record<string, Record<string, string>> = {
    analyzer:   { 'System.State': 'Active' },
    'draft-pr': { 'System.BoardColumn': 'In Code Review' },
  };

  // Load private overlay (empty {} when none installed) and build pipeline
  config.overlay = await loadManifest();
  const stages = buildDefaultPipeline(config);
  const finalState = await runPipeline({
    stages,
    context,
    stateStore,
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
    console.log(`\n⏸️  Still waiting at checkpoint: ${finalState.checkpoint.name}`);
  } else if (finalState.completedAt) {
    console.log(`\n✅ Pipeline completed successfully`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseWorkItemArg(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--work-item' || args[i] === '-w') && args[i + 1]) {
      const id = parseInt(args[++i]!, 10);
      if (!isNaN(id)) return id;
    }
  }
  console.error('Error: --work-item <id> is required');
  process.exit(1);
}
