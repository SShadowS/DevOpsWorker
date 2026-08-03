import type { z } from 'zod';
import type { AgentConfig } from '../types/agent.types.ts';
import type { PipelineState, PipelineContext, Stage, StageResult } from '../types/pipeline.types.ts';
import { runAgent } from '../sdk/run-agent.ts';
import { AgentExecutionError } from '../sdk/errors.ts';

// ---------------------------------------------------------------------------
// agentStage — wraps an AgentConfig into a Stage
// ---------------------------------------------------------------------------

export interface AgentStageConfig<T extends z.ZodType> {
  agent: AgentConfig<T>;
  canRun: (state: PipelineState) => boolean;
  applyOutput: (state: PipelineState, output: z.infer<T>) => PipelineState;
}

/** Resolve the effective model for an agent, checking agent config → perAgent → default. */
export function resolveAgentModel(
  agentModel: string | undefined,
  agentName: string,
  models: { default: string; perAgent?: Record<string, string> },
): string {
  return agentModel ?? models.perAgent?.[agentName] ?? models.default;
}

/**
 * Create a pipeline Stage from an AgentConfig.
 *
 * - `canRun` validates preconditions (e.g. "does state.devPlan exist?")
 * - `applyOutput` writes the agent's structured output into PipelineState
 * - Telemetry is automatically recorded
 */
export function agentStage<T extends z.ZodType>(
  config: AgentStageConfig<T>,
): Stage {
  return {
    name: config.agent.name,
    canRun: config.canRun,

    async execute(state: PipelineState, context: PipelineContext): Promise<StageResult> {
      const startedAt = new Date().toISOString();

      // Claim log attribution. Inside a revision loop the producer and reviewer
      // share one stage name, so without this the reviewer's output is
      // indistinguishable from the coder's — the reviewer reads as having no
      // traffic when queried by its own name.
      context.logger?.setAgentName(config.agent.name);

      let result;
      try {
        result = await runAgent(config.agent, state, context);
      } catch (err) {
        // Attach partial telemetry to the error so the orchestrator can persist it
        if (err instanceof AgentExecutionError && typeof err.details === 'object' && err.details !== null) {
          const d = err.details as Record<string, unknown>;
          err.partialTelemetry = {
            name: config.agent.name,
            costUsd: typeof d.costUsd === 'number' ? d.costUsd : 0,
            durationMs: typeof d.durationMs === 'number' ? d.durationMs : 0,
            turns: typeof d.turns === 'number' ? d.turns : 0,
            model: (typeof d.model === 'string' ? d.model : undefined)
              ?? resolveAgentModel(config.agent.model, config.agent.name, context.config.models),
            startedAt,
            timestamp: new Date().toISOString(),
            toolCalls: {},
            // A failed run is the one someone actually needs the transcript for,
            // so the session id has to survive the error path too — `runAgent`
            // puts it in `details` for exactly this.
            ...(typeof d.sessionId === 'string' && d.sessionId ? { sessionId: d.sessionId } : {}),
            ...(process.env['BUILD_SHA'] ? { imageSha: process.env['BUILD_SHA'] } : {}),
            subtype: typeof d.subtype === 'string' ? d.subtype : undefined,
          };
        }
        throw err;
      }

      // Record telemetry (success path — unchanged)
      const telemetryEntry = {
        name: config.agent.name,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        turns: result.turns,
        model: result.model,
        startedAt,
        timestamp: new Date().toISOString(),
        toolCalls: result.toolCalls,
        tokens: result.tokens,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        // Omit rather than store a blank. An image built without
        // `--build-arg BUILD_SHA=<sha>` bakes `BUILD_SHA=""`, and an empty string
        // survives `??` — it would read as "recorded" to every consumer while
        // saying nothing. Absent is honest.
        ...(process.env['BUILD_SHA'] ? { imageSha: process.env['BUILD_SHA'] } : {}),
        // Omit when empty so entries for agents that dispatch nothing stay compact.
        ...(result.modelUsage && Object.keys(result.modelUsage).length > 0
          ? { modelUsage: result.modelUsage }
          : {}),
        ...(result.subAgents && Object.keys(result.subAgents).length > 0
          ? { subAgents: result.subAgents }
          : {}),
        subtype: result.subtype,
      };

      const newState = config.applyOutput(state, result.output);

      return {
        state: {
          ...newState,
          telemetry: {
            totalCostUsd: state.telemetry.totalCostUsd + result.costUsd,
            totalDurationMs: state.telemetry.totalDurationMs + result.durationMs,
            stages: [...state.telemetry.stages, telemetryEntry],
          },
        },
      };
    },
  };
}
