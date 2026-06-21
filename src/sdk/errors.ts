import type { StageTelemetry } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Pipeline error hierarchy
// ---------------------------------------------------------------------------

export class PipelineError extends Error {
  constructor(
    public readonly type: string,
    public readonly stage: string,
    message: string,
    public readonly timestamp: string = new Date().toISOString(),
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** Agent returned an error or no structured output */
export class AgentExecutionError extends PipelineError {
  /** Partial telemetry from the failed run (set by agentStage before rethrowing) */
  partialTelemetry?: StageTelemetry;

  constructor(stage: string, public readonly details: unknown) {
    const msg = typeof details === 'string'
      ? details
      : `Agent "${stage}" failed to produce a result`;
    super('agent-execution', stage, msg);
    this.name = 'AgentExecutionError';
  }
}

/** Structured output didn't match the Zod schema */
export class AgentValidationError extends PipelineError {
  constructor(stage: string, public readonly zodError: unknown) {
    super('agent-validation', stage, `Agent "${stage}" output failed schema validation`);
    this.name = 'AgentValidationError';
  }
}

/** canRun() returned false — pipeline is misconfigured */
export class PreconditionError extends PipelineError {
  constructor(stage: string, message: string) {
    super('precondition', stage, message);
    this.name = 'PreconditionError';
  }
}

/** External service failure (DevOps API, git, az CLI) */
export class ExternalServiceError extends PipelineError {
  constructor(stage: string, service: string, message: string) {
    super('external-service', stage, `${service}: ${message}`);
    this.name = 'ExternalServiceError';
  }
}

/** Cost limit exceeded mid-agent */
export class BudgetExceededError extends PipelineError {
  constructor(stage: string, spent: number, limit: number) {
    super('budget-exceeded', stage, `Budget exceeded: $${spent.toFixed(2)} > $${limit.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

/** Checkpoint exceeded timeout */
export class CheckpointTimeoutError extends PipelineError {
  constructor(stage: string, hours: number) {
    super('checkpoint-timeout', stage, `Checkpoint "${stage}" timed out after ${hours} hours`);
    this.name = 'CheckpointTimeoutError';
  }
}

/** Revision loop exhausted max attempts */
export class RevisionExhaustedError extends PipelineError {
  /** Accumulated state from all iterations (includes telemetry + stage outputs). */
  public readonly lastState?: import('../types/pipeline.types.ts').PipelineState;

  constructor(stage: string, maxAttempts: number, lastState?: import('../types/pipeline.types.ts').PipelineState) {
    super('revision-exhausted', stage, `Revision loop "${stage}" exhausted ${maxAttempts} attempts without approval`);
    this.name = 'RevisionExhaustedError';
    this.lastState = lastState;
  }
}

/** Claude API rate limit hit (MAX subscription or API quota) — should not be retried */
export class RateLimitError extends PipelineError {
  constructor(stage: string, public readonly resetInfo: string) {
    super('rate-limit', stage, `Rate limit hit during "${stage}": ${resetInfo}`);
    this.name = 'RateLimitError';
  }
}

/** Preflight check failed */
export class PreflightError extends PipelineError {
  constructor(public readonly checks: Array<{ name: string; message: string }>) {
    const summary = checks.map(c => `  - ${c.name}: ${c.message}`).join('\n');
    super('preflight', 'preflight', `Preflight checks failed:\n${summary}`);
    this.name = 'PreflightError';
  }
}

/** Transient agent failure after retry exhaustion (e.g. process crash, auth timeout) */
export class TransientAgentError extends PipelineError {
  constructor(
    stage: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(
      'transient-agent',
      stage,
      `Agent "${stage}" failed after ${attempts} attempt(s): ${lastError.message}`,
    );
    this.name = 'TransientAgentError';
  }
}
