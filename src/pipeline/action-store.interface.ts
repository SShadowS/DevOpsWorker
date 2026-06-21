import type { PipelineAction } from '../dashboard/actions.ts';

/**
 * Interface for pipeline action queue persistence with lifecycle tracking.
 * Implementations: PgActionStore.
 *
 * Lifecycle: pending → running → (completed | failed).
 * `claimNextPending` is the atomic transition pending → running.
 * `markCompleted` / `markFailed` are the terminal transitions.
 * `recoverStale` recovers actions stuck in `running` (e.g. watcher crash).
 */

export interface PendingReviewAction {
  prId: number;
  repoKey: string;
  sourceBranch: string;
  status: 'queued' | 'reviewing';
  createdAt: string;
}

export type ActionStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ActionRecord {
  id: number;
  workItemId: number;
  type: string;
  feedback?: string;
  email?: string;
  status: ActionStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
}

export interface IActionStore {
  /** Enqueue a new action with status='pending'. Returns the assigned actionId. */
  write(action: PipelineAction): Promise<number>;

  /** Atomically claim the oldest pending action for this work item, transitioning it to 'running'.
   *  Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent watchers won't double-claim. */
  claimNextPending(workItemId: number): Promise<PipelineAction | null>;

  /** Mark a claimed action as completed. Idempotent — no-ops if already terminal. */
  markCompleted(actionId: number, result?: unknown): Promise<void>;

  /** Mark a claimed action as failed with an error message. Idempotent. */
  markFailed(actionId: number, error: string): Promise<void>;

  /** Reset rows stuck in 'running' beyond thresholdMs back to 'failed' with a timeout error.
   *  Returns the number of rows recovered. Intended for a periodic janitor. */
  recoverStale(thresholdMs: number): Promise<number>;

  /** List work item ids that have at least one pending action. */
  listPending(): Promise<number[]>;

  /** List the most recent N actions across all work items, newest first. */
  listRecent(limit: number): Promise<ActionRecord[]>;

  /** Optional: list PR review actions in queued/reviewing state. */
  listPendingReviews?(): Promise<PendingReviewAction[]>;
}
