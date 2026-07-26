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
 * Has the issue count stopped falling?
 *
 * True once `counts` holds at least `window` entries and none of the last
 * `window` improved on the one before it. A loop whose findings plateau is not
 * converging; iterating further spends money to re-confirm that.
 *
 * Strictly "no decrease" — equal counts across rounds count as a plateau, since
 * a reviewer returning the same number of findings round after round is the
 * exact shape of the observed non-convergence.
 *
 * Exported for tests; pure.
 */
export function hasPlateaued(counts: number[], window: number): boolean {
  if (window < 2 || counts.length < window) return false;
  const recent = counts.slice(-window);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! < recent[i - 1]!) return false;
  }
  return true;
}

/**
 * Findings that appear in more than one round — the ones iteration is failing to
 * resolve, and therefore the ones worth putting in front of a human.
 *
 * Matched on the finding's own text. Crude, but a reviewer restating the same
 * objection tends to restate it verbatim, and a false negative here only costs
 * a less specific escalation comment.
 *
 * Exported for tests; pure.
 */
export function recurringFindings(rounds: string[][]): string[] {
  const seen = new Map<string, number>();
  for (const round of rounds) {
    for (const text of new Set(round)) {
      seen.set(text, (seen.get(text) ?? 0) + 1);
    }
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([text]) => text);
}

/**
 * Creates a Stage that runs a producer→reviewer loop.
 *
 * 1. Run the producer (e.g. PlanningAgent)
 * 2. Run the reviewer (e.g. PlanReviewAgent)
 * 3. If approved → done
 * 4. If the issue count has plateaued → **escalate**: pause and ask a human
 * 5. If revise → loop back to producer with reviewer feedback in state
 * 6. Circuit breaker: max N attempts before returning with last state
 *
 * Step 4 is the third outcome. Without it the only exits are approval and budget
 * exhaustion, so a loop that cannot converge spends its entire budget proving it
 * — the coding loop on WI 63396 ran 8 rounds for $146 and produced no merge.
 *
 * Both producer and reviewer must be Stages themselves (usually created
 * via agentStage()). The loop manages iteration, escalation, and the breaker.
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

      // Re-entering after a convergence escalation: the human has answered (their
      // reply is in state as revisionFeedback/humanFeedback). Clear the marker or
      // the loop pauses again before running anything, and reset this loop's issue
      // history — the answer is a new starting condition, and carrying the old
      // plateau forward would re-escalate on the very next round.
      if (currentState.convergenceEscalation?.loop === config.name) {
        logger?.log(`Resuming "${config.name}" after convergence escalation — issue history reset`);
        currentState = {
          ...currentState,
          convergenceEscalation: undefined,
          revisionIssueCounts: { ...currentState.revisionIssueCounts, [config.name]: [] },
        };
      }

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

        // The loop's own bookkeeping is not an agent's output; agentStage
        // re-claims attribution when the producer/reviewer actually runs.
        logger?.setAgentName('');
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

          logger?.setAgentName('');
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
          logger?.setAgentName('');
          logger?.log(`Reviewer approved on attempt ${attempt}`);
          // Clear the budget so a later rewind to this loop starts fresh.
          return {
            state: {
              ...currentState,
              revisionAttempts: { ...currentState.revisionAttempts, [config.name]: 0 },
            },
          };
        }

        // Not approved. Before spending another round, ask whether the rounds so
        // far are actually converging.
        if (config.convergence && config.countIssues) {
          const count = config.countIssues(currentState);
          if (count !== undefined) {
            const counts = [...(currentState.revisionIssueCounts?.[config.name] ?? []), count];
            currentState = {
              ...currentState,
              revisionIssueCounts: { ...currentState.revisionIssueCounts, [config.name]: counts },
            };

            if (hasPlateaued(counts, config.convergence.window)) {
              const now = new Date().toISOString();
              logger?.setAgentName('');
              logger?.log(
                `Convergence: issue count has not fallen across ${config.convergence.window} rounds ` +
                  `(${counts.join(' → ')}) — escalating to a human instead of burning the remaining budget`,
              );
              return {
                state: {
                  ...currentState,
                  checkpoint: { name: `convergence:${config.name}`, enteredAt: now },
                  convergenceEscalation: {
                    loop: config.name,
                    issueCounts: counts,
                    recurringFindings: recurringFindings(config.collectFindingTexts?.(currentState) ?? []),
                    question: config.convergence.question,
                    escalatedAt: now,
                  },
                },
                // Same pause the stage-boundary checkpoints emit: the orchestrator
                // persists and exits, the watcher sees the human's reply, and
                // `pipeline continue` re-enters at the stored attempt count.
                signal: { kind: 'pause' },
              };
            }
          }
        }

        // loop continues (reviewer's feedback is already in state)
        logger?.setAgentName('');
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
