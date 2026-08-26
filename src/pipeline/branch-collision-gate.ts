import type { PipelineConfig, PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import { PipelineError } from '../sdk/errors.ts';
import { detectBranchCollision, type GitRunner } from './branch-collision.ts';

/**
 * Coding-loop gate: refuse to start when the remote branch situation would make
 * the run fail later, or silently do the wrong thing.
 *
 * Runs once before the loop's first attempt (see `preLoop`), so blocking a
 * resume costs no revision budget — otherwise a human retrying while they free
 * a branch name would exhaust the loop that is waiting for them.
 *
 * The error type is `needs-input` rather than a generic failure on purpose. The
 * watcher's standard error comment tells the human to add the `continue` tag,
 * and for THIS error that advice is a trap: continuing re-runs the same check
 * against the same remote and fails identically. `needs-input` carries the
 * collision's own message, which names the branch and the ways out.
 */
export function buildBranchCollisionGate(config: PipelineConfig, run?: GitRunner) {
  return async (state: PipelineState, context: PipelineContext): Promise<PipelineState> => {
    const collision = detectBranchCollision(
      state,
      context.workItemId,
      config.paths.targetRepo,
      (message) => context.logger?.log(message),
      run,
    );

    if (!collision) return state;

    context.logger?.log(`[branch-check] ${collision.kind}: ${collision.branch}`);
    throw new PipelineError('needs-input', 'coding', collision.message);
  };
}
