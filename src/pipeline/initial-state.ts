import type { PipelineState } from '../types/pipeline.types.ts';

/** Create a fresh pipeline state for a new run. */
export function createInitialState(startingStage: string): PipelineState {
  return {
    currentStage: startingStage,
    telemetry: {
      totalCostUsd: 0,
      totalDurationMs: 0,
      stages: [],
    },
    startedAt: new Date().toISOString(),
  };
}
