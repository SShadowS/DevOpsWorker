import type {
  Stage,
  PipelineState,
  PipelineContext,
  RevisionLoopConfig,
  StageResult,
} from '../types/pipeline.types.ts';
import { ExternalServiceError, PipelineError, RevisionExhaustedError } from '../sdk/errors.ts';

// ---------------------------------------------------------------------------
// revisionLoop — generic review→revise loop with circuit breaker
// ---------------------------------------------------------------------------

/**
 * Creates a Stage that runs a producer→reviewer loop.
 *
 * 1. Run the producer (e.g. PlanningAgent)
 * 2. Run the reviewer (e.g. PlanReviewAgent)
 * 3. If approved → done
 * 4. If revise → loop back to producer with reviewer feedback in state
 * 5. Circuit breaker: max N attempts before returning with last state
 *
 * Both producer and reviewer must be Stages themselves (usually created
 * via agentStage()). The loop manages iteration and the circuit breaker.
 */
export function revisionLoop(config: RevisionLoopConfig): Stage {
  return {
    name: config.name,

    canRun(state: PipelineState): boolean {
      // The revision loop can run if its producer can run
      return config.producer.canRun(state);
    },

    async execute(state: PipelineState, context: PipelineContext): Promise<StageResult> {
      let currentState = state;
      const logger = context.logger;

      // A human-granted retry (/fix sets rerunMode; resuming an exhausted loop
      // sets skipResetState) refills the attempt budget. An automatic resume
      // (e.g. after a container crash) does NOT — otherwise the circuit breaker
      // resets every resume and the loop retries forever (wi 72264: $100 burned
      // on 7+ coder runs across crash-resumes).
      const grantsFreshBudget = Boolean(state.rerunMode) || state.skipResetState === true;

      if (config.resetState && !currentState.rerunMode && !currentState.skipResetState) {
        currentState = config.resetState(currentState);
      }
      currentState = { ...currentState, skipResetState: undefined };

      const priorAttempts = grantsFreshBudget
        ? 0
        : currentState.revisionAttempts?.[config.name] ?? 0;

      // Budget already spent across prior resumes — fail fast, don't burn another run.
      if (priorAttempts >= config.maxAttempts) {
        throw new RevisionExhaustedError(config.name, config.maxAttempts, currentState);
      }

      for (let attempt = priorAttempts + 1; attempt <= config.maxAttempts; attempt++) {
        // Record the attempt in state BEFORE running so a crash mid-iteration
        // still counts against the budget (reportActiveAgent persists currentState).
        currentState = {
          ...currentState,
          revisionAttempts: { ...currentState.revisionAttempts, [config.name]: attempt },
        };

        logger?.log(`Iteration ${attempt}/${config.maxAttempts} — running producer "${config.producer.name}"`);

        try {
          // Report + run producer
          await context.reportActiveAgent?.(currentState, {
            name: config.producer.name, loop: config.name, role: 'producer',
            iteration: attempt, startedAt: new Date().toISOString(),
          });
          currentState = (await config.producer.execute(currentState, context)).state;

          // Run optional post-producer hook (e.g. server-side CI verification)
          if (config.postProducer) {
            try {
              currentState = await config.postProducer(currentState, context);
            } catch (err) {
              // postProducer hooks (e.g. buildCIVerificationHook -> getBuildTimeline ->
              // adoFetch) may throw plain Errors — AzureDevOpsError is NOT a PipelineError
              // subclass. Left un-wrapped, the catch block below wouldn't recognize it as
              // a PipelineError, so `partialState` (the incremented revision-budget state)
              // would never attach and a resume would re-run an already-spent attempt.
              // Wrap any non-PipelineError escaping the hook so it does.
              throw err instanceof PipelineError
                ? err
                : new ExternalServiceError(
                    config.name,
                    'postProducer',
                    err instanceof Error ? err.message : String(err),
                  );
            }
          }

          logger?.log(`Running reviewer "${config.reviewer.name}"`);

          // Report + run reviewer (snapshot now includes producer/postProducer output)
          await context.reportActiveAgent?.(currentState, {
            name: config.reviewer.name, loop: config.name, role: 'reviewer',
            iteration: attempt, startedAt: new Date().toISOString(),
          });
          currentState = (await config.reviewer.execute(currentState, context)).state;
        } catch (err) {
          // Attach accumulated state to the error so the orchestrator can preserve
          // stage outputs (changeset, codeReviews, etc.) from previous iterations.
          // Producer/reviewer failures surface as PipelineError subclasses (runAgent
          // always throws one); the typed `partialState` field replaces the old
          // `(err as Error & { lastState }).lastState` monkey-patch.
          if (err instanceof PipelineError) {
            err.partialState = currentState;
          }
          throw err;
        }

        // Check if approved
        if (config.isApproved(currentState)) {
          logger?.log(`Reviewer approved on attempt ${attempt}`);
          // Clear the budget so a later rewind to this loop starts fresh.
          return {
            state: {
              ...currentState,
              revisionAttempts: { ...currentState.revisionAttempts, [config.name]: 0 },
            },
          };
        }

        // Not approved — loop continues (reviewer's feedback is already in state)
        logger?.log(`Revision ${attempt}/${config.maxAttempts} — reviewer requested changes`);
        console.log(
          `[${config.name}] Revision ${attempt}/${config.maxAttempts} — reviewer requested changes`,
        );
      }

      // Circuit breaker: max attempts reached — attach accumulated state so costs aren't lost
      throw new RevisionExhaustedError(config.name, config.maxAttempts, currentState);
    },
  };
}
