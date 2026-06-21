import { connectStores } from '../db/connect-stores.ts';
import { formatTelemetrySummary } from '../formatters/devops-comment.ts';
import type { PipelineStatus } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// pipeline status --work-item <id>
// ---------------------------------------------------------------------------

export async function status(args: string[]): Promise<void> {
  const workItemId = parseWorkItemArg(args);
  const { stateStore } = await connectStores();
  const state = await stateStore.load(workItemId);

  if (!state) {
    console.log(`No pipeline state found for work item #${workItemId}`);
    return;
  }

  // Determine status
  let pipelineStatus: PipelineStatus;
  if (state.completedAt) {
    pipelineStatus = 'completed';
  } else if (state.error) {
    pipelineStatus = 'failed';
  } else if (state.checkpoint) {
    pipelineStatus = 'checkpoint-waiting';
  } else {
    pipelineStatus = 'running';
  }

  const statusIcon: Record<PipelineStatus, string> = {
    'not-started': '⏹️',
    'running': '▶️',
    'checkpoint-waiting': '⏸️',
    'failed': '❌',
    'stalled': '⚠️',
    'completed': '✅',
  };

  console.log(`Pipeline Status — Work Item #${workItemId}`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Status:        ${statusIcon[pipelineStatus]} ${pipelineStatus}`);
  console.log(`Current stage: ${state.currentStage}`);
  console.log(`Started:       ${state.startedAt}`);

  if (state.completedAt) {
    console.log(`Completed:     ${state.completedAt}`);
  }

  if (state.checkpoint) {
    console.log(`\nCheckpoint: ${state.checkpoint.name}`);
    console.log(`  Entered:     ${state.checkpoint.enteredAt}`);
    console.log(`  Last polled: ${state.checkpoint.lastPolledAt ?? 'never'}`);
  }

  if (state.error) {
    console.log(`\nError at stage "${state.error.stage}":`);
    console.log(`  ${state.error.message}`);
  }

  // Stage progression
  console.log(`\nStage Results:`);
  if (state.readiness) console.log(`  ✅ analyzer`);
  if (state.devPlan) console.log(`  ✅ planner`);
  if (state.planReviews?.length) console.log(`  ✅ plan-reviewer (${state.planReviews.length} review(s))`);
  if (state.changeset) console.log(`  ✅ coder`);
  if (state.codeReviews?.length) console.log(`  ✅ code-reviewer (${state.codeReviews.length} review(s))`);
  if (state.draftPR) console.log(`  ✅ draft-pr`);
  if (state.workItemUpdate) console.log(`  ✅ documenter`);

  // Telemetry
  if (state.telemetry?.stages?.length > 0) {
    console.log(`\n${formatTelemetrySummary(state.telemetry)}`);
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
