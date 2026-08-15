import type { ReflectionProposal } from '../db/reflection-proposal-mapper.ts';

/**
 * Store for `reflection_proposals` — the monthly reflection agent's proposed
 * prompt/config changes, gated behind human approval before anything is applied.
 *
 * Invariants:
 * - Single writer per cycle: `save` marks any prior 'pending' row for the same
 *   `cycleDate` 'superseded' before inserting the new one, so at most one row
 *   for a given cycle is ever 'pending' at a time.
 * - `decide` and `markApplied` are guarded state transitions, not unconditional
 *   writes: each checks the row's current status before mutating and returns
 *   `false` instead of throwing when the row isn't in the expected state (the
 *   dashboard turns a `false` into an HTTP 409, rather than treating every call
 *   as always succeeding).
 */
export interface IReflectionStore {
  /** Insert; marks any prior 'pending' row for the same cycle_date 'superseded' first. Returns id. */
  save(p: Omit<ReflectionProposal, 'id' | 'createdAt' | 'status' | 'decidedBy' | 'decidedAt' | 'appliedAt' | 'appliedCommits'>): Promise<number>;
  listRecent(limit?: number): Promise<ReflectionProposal[]>;
  findById(id: number): Promise<ReflectionProposal | null>;
  /** Newest non-superseded row for a cycle date, or null. The scheduler's idempotence guard. */
  findByCycle(cycleDate: string): Promise<ReflectionProposal | null>;
  /** pending → approved|rejected only; returns false when the row is not pending. */
  decide(id: number, decision: 'approved' | 'rejected', decidedBy: string): Promise<boolean>;
  /** approved → applied with commit SHAs; returns false when the row is not approved. */
  markApplied(id: number, commits: { core?: string; overlay?: string }): Promise<boolean>;
}
