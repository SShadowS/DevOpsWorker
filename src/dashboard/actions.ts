import type { PipelineState } from '../types/pipeline.types.ts';
import type { ActionType } from './types.ts';

// ---------------------------------------------------------------------------
// PipelineAction — the queue message written by the server, consumed by watch
// ---------------------------------------------------------------------------

export interface PipelineAction {
  id?: number;         // DB row id (set when loaded from store)
  workItemId: number;
  type: ActionType;
  feedback?: string;
  email?: string;      // Required for env-share
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Check whether an action is valid for the current pipeline state. */
export function validateAction(
  action: PipelineAction,
  state: PipelineState | null,
): { valid: boolean; reason?: string } {
  if (!state) {
    return { valid: false, reason: 'No pipeline state found for this work item' };
  }

  switch (action.type) {
    case 'approve-plan':
      if (state.checkpoint?.name !== 'plan-approved') {
        return { valid: false, reason: 'Pipeline is not at plan-approved checkpoint' };
      }
      return { valid: true };

    case 'rerun-plan':
      if (
        state.checkpoint?.name === 'plan-approved' ||
        state.checkpoint?.name === 'pr-published' ||
        (state.error && isPlanningStage(state.error.stage)) ||
        (state.error && isCodingStage(state.error.stage))
      ) {
        return { valid: true };
      }
      return { valid: false, reason: 'Pipeline is not at a checkpoint or failed during planning/coding' };

    case 'fix':
      if (
        state.checkpoint?.name === 'pr-published' ||
        (state.error && isCodingStage(state.error.stage))
      ) {
        return { valid: true };
      }
      return { valid: false, reason: 'Pipeline is not at PR checkpoint or failed during coding' };

    case 'continue':
      if (!state.error) {
        return { valid: false, reason: 'Pipeline has no error to retry' };
      }
      return { valid: true };

    case 'reprovision-env':
      if (!state.draftPR) {
        return { valid: false, reason: 'No pull request exists to update' };
      }
      if (state.completedAt) {
        return { valid: false, reason: 'Pipeline is already completed' };
      }
      return { valid: true };

    case 'env-start':
    case 'env-stop':
    case 'env-delete':
    case 'env-share':
      if (!state.environment) {
        return { valid: false, reason: 'No environment exists for this work item' };
      }
      return { valid: true };

    default:
      return { valid: false, reason: `Unknown action type: ${action.type}` };
  }
}

/** Compute which actions are available for a given pipeline state. */
export function getAvailableActions(state: PipelineState): ActionType[] {
  const actions: ActionType[] = [];

  // approve-plan: at plan-approved checkpoint
  if (state.checkpoint?.name === 'plan-approved') {
    actions.push('approve-plan');
  }

  // rerun-plan: at any checkpoint or failed during planning/coding
  if (
    state.checkpoint?.name === 'plan-approved' ||
    state.checkpoint?.name === 'pr-published' ||
    (state.error && isPlanningStage(state.error.stage)) ||
    (state.error && isCodingStage(state.error.stage))
  ) {
    actions.push('rerun-plan');
  }

  // fix: at PR checkpoint OR failed during coding
  if (
    state.checkpoint?.name === 'pr-published' ||
    (state.error && isCodingStage(state.error.stage))
  ) {
    actions.push('fix');
  }

  // continue: any failed or stalled pipeline
  if (state.error || isStalled(state)) {
    actions.push('continue');
  }

  // Environment actions — available whenever an environment exists
  if (state.environment) {
    actions.push('env-start', 'env-stop', 'env-delete', 'env-share');
  }

  // reprovision-env: PR exists and pipeline is not completed
  if (state.draftPR && !state.completedAt) {
    actions.push('reprovision-env');
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlanningStage(stage: string): boolean {
  return stage === 'planning' || stage === 'plan-reviewer';
}

function isCodingStage(stage: string): boolean {
  return stage === 'coding' || stage === 'code-reviewer' || stage === 'draft-pr';
}

const STALLED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function isStalled(state: PipelineState): boolean {
  if (state.completedAt || state.error || state.checkpoint) return false;
  const startedMs = new Date(state.startedAt).getTime();
  const lastStage = state.telemetry?.stages?.at(-1);
  const lastActivity = lastStage?.startedAt
    ? new Date(lastStage.startedAt).getTime() + lastStage.durationMs
    : lastStage?.timestamp
      ? new Date(lastStage.timestamp).getTime()
      : startedMs;
  return Date.now() - lastActivity > STALLED_THRESHOLD_MS;
}
