import type {
  Stage,
  PipelineState,
  PipelineContext,
  PipelineDefinition,
  StageResult,
} from '../types/pipeline.types.ts';
import type { IStateStore } from './state-store.interface.ts';
import { createInitialState } from './initial-state.ts';
import { PreconditionError, PipelineError, RevisionExhaustedError, AgentExecutionError } from '../sdk/errors.ts';

// ---------------------------------------------------------------------------
// Orchestrator — runs a stage list, manages transitions, persists state
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Pipeline stage list */
  stages: PipelineDefinition;
  /** Pipeline context (work item, config) */
  context: PipelineContext;
  /** State store for persistence */
  stateStore: IStateStore;
  /** Optional callback after each stage completes */
  onStageComplete?: (stage: Stage, state: PipelineState) => Promise<void>;
  /** Optional callback when a stage throws an error (called after state persistence, before rethrow) */
  onError?: (stage: Stage, state: PipelineState, error: Error) => Promise<void>;
  /** When true, discard any existing state and start from scratch */
  freshStart?: boolean;
}

/**
 * Run the pipeline from the beginning or resume from a persisted state.
 *
 * The orchestrator:
 * 1. Loads or creates pipeline state
 * 2. Finds the current stage index
 * 3. Runs stages sequentially, persisting state after each
 * 4. Stops at checkpoints (when state.checkpoint is set)
 * 5. Stops on errors (persists error state for resume)
 * 6. Handles revision feedback (rewinds to target stage)
 */
export async function runPipeline(options: OrchestratorOptions): Promise<PipelineState> {
  const { stages, context, stateStore, onStageComplete, onError } = options;
  const workItemId = context.workItemId;

  // Load existing state or create fresh
  let state = (!options.freshStart && await stateStore.load(workItemId))
    || createInitialState(stages[0]?.name ?? 'unknown');

  // Discard any liveness marker left behind by a crashed run; it is non-durable.
  if (state.activeAgent) state = { ...state, activeAgent: undefined };

  // Find the starting stage index (default to 0 if stage name not found — e.g. corrupted state)
  let startIndex = findStageIndex(stages, state.currentStage);
  if (startIndex < 0) {
    console.warn(`[orchestrator] Stage "${state.currentStage}" not found in pipeline, starting from beginning`);
    startIndex = 0;
  }

  // Handle revision feedback: rewind to target stage
  if (state.revisionFeedback) {
    const targetIndex = findStageIndex(stages, state.revisionFeedback.targetStage);
    if (targetIndex >= 0) {
      console.log(`[orchestrator] Revision feedback detected — rewinding to "${state.revisionFeedback.targetStage}"`);
      startIndex = targetIndex;
      // Clear revision feedback (it's been consumed)
      state = { ...state, revisionFeedback: undefined };
    } else {
      console.warn(`[orchestrator] Revision target stage "${state.revisionFeedback.targetStage}" not found, ignoring rewind`);
      state = { ...state, revisionFeedback: undefined };
    }
  }

  // Run stages
  for (let i = startIndex; i < stages.length; i++) {
    const stage = stages[i]!;
    state = { ...state, currentStage: stage.name };

    // Persist state before running stage
    await stateStore.save(workItemId, state);

    // Check preconditions
    if (!stage.canRun(state)) {
      throw new PreconditionError(
        stage.name,
        `Stage "${stage.name}" preconditions not met — pipeline may be misconfigured or a previous stage failed`,
      );
    }

    console.log(`[orchestrator] Running stage: ${stage.name}`);
    context.logger?.stageStart(stage.name);

    // Per-stage context carrying a best-effort, stage-bound liveness reporter.
    const stageName = stage.name;
    let stageActive = true;
    const stageContext: PipelineContext = {
      ...context,
      reportActiveAgent: async (s, marker) => {
        if (!stageActive) return;                          // reject calls after the stage returned
        if (marker && marker.loop !== stageName) return;   // ignore markers for another stage
        try {
          await stateStore.save(workItemId, { ...s, currentStage: stageName, activeAgent: marker ?? undefined });
        } catch (err) {
          context.logger?.log(`reportActiveAgent save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };

    let result: StageResult;
    try {
      result = await stage.execute(state, stageContext);
    } catch (err) {
      context.logger?.stageError(err instanceof Error ? err : new Error(String(err)));

      // Recover accumulated state from revision loops (exhausted or mid-loop errors).
      // This preserves stage outputs (changeset, codeReviews, etc.) from successful
      // iterations even when a later iteration fails. Read from the typed error
      // fields — RevisionExhaustedError.lastState (circuit breaker) or the base
      // PipelineError.partialState (mid-loop failure) — never a monkey-patched prop.
      const lastState = (err instanceof RevisionExhaustedError)
        ? err.lastState
        : (err instanceof PipelineError)
          ? err.partialState
          : undefined;
      if (lastState) {
        state = lastState;
      }

      // Merge partial telemetry from failed agent stage (if available)
      const partialTelemetry = (err instanceof AgentExecutionError) ? err.partialTelemetry : undefined;
      if (partialTelemetry) {
        state = {
          ...state,
          telemetry: {
            totalCostUsd: state.telemetry.totalCostUsd + (partialTelemetry.costUsd ?? 0),
            totalDurationMs: state.telemetry.totalDurationMs + (partialTelemetry.durationMs ?? 0),
            stages: [...state.telemetry.stages, partialTelemetry],
          },
        };
      }

      // Persist error state for resume
      const errorState: PipelineState['error'] = {
        type: err instanceof PipelineError ? err.type : 'unknown',
        stage: stage.name,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };

      // Enrich with SDK details when available
      if (err instanceof AgentExecutionError && typeof err.details === 'object' && err.details !== null) {
        const d = err.details as Record<string, unknown>;
        if (typeof d.subtype === 'string') errorState.subtype = d.subtype;
        if (typeof d.costUsd === 'number') errorState.costUsd = d.costUsd;
        if (typeof d.durationMs === 'number') errorState.durationMs = d.durationMs;
        if (typeof d.turns === 'number') errorState.turns = d.turns;
      }

      state = { ...state, error: errorState };
      await stateStore.save(workItemId, state);

      if (onError) {
        try {
          await onError(stage, state, err instanceof Error ? err : new Error(String(err)));
        } catch { /* non-fatal */ }
      }

      throw err;
    } finally {
      stageActive = false;
    }

    // Unwrap the stage result: carry the new state forward; the optional signal
    // drives the in-loop control-flow decision below.
    state = result.state;

    // Persist state after stage
    await stateStore.save(workItemId, state);

    // Log stage completion with latest telemetry (if not already logged by runAgent)
    const latestTelemetry = state.telemetry.stages.at(-1);
    if (latestTelemetry && latestTelemetry.name === stage.name) {
      // runAgent already called stageComplete — only log if it was a non-agent stage
    } else {
      context.logger?.stageComplete();
    }

    // Callback
    if (onStageComplete) {
      await onStageComplete(stage, state);
    }

    // Act on the stage's explicit control-flow signal. The equivalent state
    // fields (state.checkpoint / state.revisionFeedback) are still set + persisted
    // above for external observers (watcher, dashboard, resume path), but the
    // orchestrator's decision comes from the typed signal, not from sniffing them.

    // If the stage signalled a pause (checkpoint waiting), stop here.
    if (result.signal?.kind === 'pause') {
      const cpName = state.checkpoint?.name ?? stage.name;
      context.logger?.log(`Checkpoint "${cpName}" — waiting for human action`);
      console.log(`[orchestrator] Checkpoint "${cpName}" — waiting for human action`);
      return state;
    }

    // If the stage signalled a rewind (revision requested), jump to the target.
    if (result.signal?.kind === 'rewind') {
      const targetStage = result.signal.targetStage;
      const targetIndex = findStageIndex(stages, targetStage);
      if (targetIndex >= 0) {
        console.log(`[orchestrator] Rewind to "${targetStage}" for revision`);
        // Clear the consumed revisionFeedback so a later resume doesn't re-trigger
        // the startup rewind on it.
        state = { ...state, revisionFeedback: undefined };
        // Reset loop counter to rewind (note: i will be incremented, so set to target - 1)
        i = targetIndex - 1;
      } else {
        console.warn(`[orchestrator] Revision target stage "${targetStage}" not found, ignoring rewind`);
        state = { ...state, revisionFeedback: undefined };
      }
    }
  }

  // Pipeline complete
  state = {
    ...state,
    completedAt: new Date().toISOString(),
  };
  await stateStore.save(workItemId, state);

  console.log('[orchestrator] Pipeline completed successfully');
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findStageIndex(stages: PipelineDefinition, name: string): number {
  return stages.findIndex(s => s.name === name);
}
