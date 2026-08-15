import type postgres from 'postgres';
import type { IReflectionStore } from '../pipeline/reflection-store.interface.ts';
import { rowToReflectionProposal, type ReflectionProposal } from './reflection-proposal-mapper.ts';

type SaveInput = Parameters<IReflectionStore['save']>[0];

export class PgReflectionStore implements IReflectionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async save(p: SaveInput): Promise<number> {
    return this.sql.begin(async (tx) => {
      // Single writer per cycle: supersede any still-pending row for this
      // cycle_date before inserting the new one, inside the same transaction
      // so the two never race against a concurrent save for the same cycle.
      await tx`
        UPDATE reflection_proposals
        SET status = 'superseded'
        WHERE cycle_date = ${p.cycleDate} AND status = 'pending'
      `;
      const [result] = await tx`
        INSERT INTO reflection_proposals (
          cycle_date, window_days, coverage, adjudications, clusters, proposed_changes,
          watch_ledger, classifier_notes, expected_effects, log_entry_draft,
          cost_usd, session_id, error
        )
        VALUES (
          ${p.cycleDate}, ${p.windowDays},
          ${p.coverage === null ? null : tx.json(p.coverage as unknown as postgres.JSONValue)},
          ${tx.json(p.adjudications as unknown as postgres.JSONValue)},
          ${tx.json(p.clusters as unknown as postgres.JSONValue)},
          ${tx.json(p.proposedChanges as unknown as postgres.JSONValue)},
          ${p.watchLedger === null ? null : tx.json(p.watchLedger as unknown as postgres.JSONValue)},
          ${p.classifierNotes === null ? null : tx.json(p.classifierNotes as unknown as postgres.JSONValue)},
          ${p.expectedEffects === null ? null : tx.json(p.expectedEffects as unknown as postgres.JSONValue)},
          ${p.logEntryDraft},
          ${p.costUsd}, ${p.sessionId}, ${p.error}
        )
        RETURNING id
      `;
      return (result as any).id;
    });
  }

  async listRecent(limit = 20): Promise<ReflectionProposal[]> {
    const rows = await this.sql`
      SELECT id, cycle_date, window_days, coverage, adjudications, clusters, proposed_changes,
             watch_ledger, classifier_notes, expected_effects, log_entry_draft, status,
             decided_by, decided_at, applied_at, applied_commits, cost_usd, session_id, error,
             created_at
      FROM reflection_proposals
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToReflectionProposal);
  }

  async findById(id: number): Promise<ReflectionProposal | null> {
    const rows = await this.sql`
      SELECT id, cycle_date, window_days, coverage, adjudications, clusters, proposed_changes,
             watch_ledger, classifier_notes, expected_effects, log_entry_draft, status,
             decided_by, decided_at, applied_at, applied_commits, cost_usd, session_id, error,
             created_at
      FROM reflection_proposals
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToReflectionProposal(rows[0]!) : null;
  }

  async findByCycle(cycleDate: string): Promise<ReflectionProposal | null> {
    const rows = await this.sql`
      SELECT id, cycle_date, window_days, coverage, adjudications, clusters, proposed_changes,
             watch_ledger, classifier_notes, expected_effects, log_entry_draft, status,
             decided_by, decided_at, applied_at, applied_commits, cost_usd, session_id, error,
             created_at
      FROM reflection_proposals
      WHERE cycle_date = ${cycleDate} AND status != 'superseded'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows.length > 0 ? rowToReflectionProposal(rows[0]!) : null;
  }

  async decide(id: number, decision: 'approved' | 'rejected', decidedBy: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE reflection_proposals
      SET status = ${decision}, decided_by = ${decidedBy}, decided_at = now()
      WHERE id = ${id} AND status = 'pending'
    `;
    return result.count === 1;
  }

  async markApplied(id: number, commits: { core?: string; overlay?: string }): Promise<boolean> {
    const result = await this.sql`
      UPDATE reflection_proposals
      SET status = 'applied',
          applied_commits = ${this.sql.json(commits as unknown as postgres.JSONValue)},
          applied_at = now()
      WHERE id = ${id} AND status = 'approved'
    `;
    return result.count === 1;
  }
}
