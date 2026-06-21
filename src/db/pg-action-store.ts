import type postgres from 'postgres';
import type {
  IActionStore,
  PendingReviewAction,
  ActionRecord,
  ActionStatus,
} from '../pipeline/action-store.interface.ts';
import type { PipelineAction } from '../dashboard/actions.ts';

interface ActionRow {
  id: number;
  work_item_id: number;
  type: string;
  payload: string | null;
  created_at: string;
  status: ActionStatus;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: unknown;
}

function rowToRecord(row: ActionRow): ActionRecord {
  const extra = row.payload ? JSON.parse(row.payload) as { feedback?: string; email?: string } : {};
  const record: ActionRecord = {
    id: row.id,
    workItemId: row.work_item_id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
  };
  if (extra.feedback !== undefined) record.feedback = extra.feedback;
  if (extra.email !== undefined) record.email = extra.email;
  if (row.started_at) record.startedAt = row.started_at;
  if (row.completed_at) record.completedAt = row.completed_at;
  if (row.error) record.error = row.error;
  if (row.result !== null && row.result !== undefined) record.result = row.result;
  return record;
}

export class PgActionStore implements IActionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async write(action: PipelineAction): Promise<number> {
    const payload = JSON.stringify({ feedback: action.feedback, email: action.email });
    const rows = await this.sql`
      INSERT INTO actions (work_item_id, type, payload, created_at, status)
      VALUES (${action.workItemId}, ${action.type}, ${payload}, ${action.createdAt}, 'pending')
      RETURNING id
    `;
    return (rows[0] as { id: number }).id;
  }

  async claimNextPending(workItemId: number): Promise<PipelineAction | null> {
    const rows = await this.sql`
      WITH next AS (
        SELECT id FROM actions
        WHERE work_item_id = ${workItemId} AND status = 'pending'
        ORDER BY id ASC LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE actions
         SET status = 'running',
             started_at = now()
      FROM next
      WHERE actions.id = next.id
      RETURNING actions.id, actions.work_item_id, actions.type, actions.payload, actions.created_at::text
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as { id: number; work_item_id: number; type: string; payload: string | null; created_at: string };
    const extra = row.payload ? JSON.parse(row.payload) as { feedback?: string; email?: string } : {};
    return {
      id: row.id,
      workItemId: row.work_item_id,
      type: row.type as PipelineAction['type'],
      createdAt: row.created_at,
      ...extra,
    };
  }

  async markCompleted(actionId: number, result?: unknown): Promise<void> {
    if (result === undefined) {
      await this.sql`
        UPDATE actions
           SET status = 'completed',
               completed_at = now(),
               error = NULL
         WHERE id = ${actionId}
           AND status = 'running'
      `;
    } else {
      await this.sql`
        UPDATE actions
           SET status = 'completed',
               completed_at = now(),
               result = ${this.sql.json(result as postgres.JSONValue)},
               error = NULL
         WHERE id = ${actionId}
           AND status = 'running'
      `;
    }
  }

  async markFailed(actionId: number, error: string): Promise<void> {
    await this.sql`
      UPDATE actions
         SET status = 'failed',
             completed_at = now(),
             error = ${error}
       WHERE id = ${actionId}
         AND status = 'running'
    `;
  }

  async recoverStale(thresholdMs: number): Promise<number> {
    const seconds = Math.floor(thresholdMs / 1000);
    const rows = await this.sql`
      UPDATE actions
         SET status = 'failed',
             completed_at = now(),
             error = 'timeout: action ran longer than threshold (watcher likely crashed)'
       WHERE status = 'running'
         AND started_at < now() - (${seconds} || ' seconds')::interval
      RETURNING id
    `;
    return rows.length;
  }

  async listPending(): Promise<number[]> {
    const rows = await this.sql`
      SELECT DISTINCT work_item_id FROM actions WHERE status = 'pending'
    ` as unknown as Array<{ work_item_id: number }>;
    return rows.map(r => r.work_item_id);
  }

  async listRecent(limit: number): Promise<ActionRecord[]> {
    const rows = await this.sql`
      SELECT id, work_item_id, type, payload, created_at::text, status,
             started_at::text AS started_at,
             completed_at::text AS completed_at,
             error, result
      FROM actions
      ORDER BY id DESC
      LIMIT ${limit}
    ` as unknown as ActionRow[];
    return rows.map(rowToRecord);
  }

  async listPendingReviews(): Promise<PendingReviewAction[]> {
    // PR review actions that are still queued ('pending') or being processed ('running')
    // and don't yet have a matching pr_reviews row.
    const rows = await this.sql`
      SELECT a.payload, a.status, a.created_at::text
      FROM actions a
      WHERE a.type = 'review-pr'
        AND a.status IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM pr_reviews pr WHERE pr.action_id = a.id
        )
      ORDER BY a.created_at DESC
    `;
    return rows.map((r) => {
      const row = r as { payload: string | null; status: ActionStatus; created_at: string };
      const payload = row.payload ? JSON.parse(row.payload) as { feedback?: string } : {};
      const feedback = payload.feedback ? JSON.parse(payload.feedback) as {
        prId?: number; repoKey?: string; sourceBranch?: string;
      } : {};
      return {
        prId: feedback.prId ?? 0,
        repoKey: feedback.repoKey ?? '',
        sourceBranch: (feedback.sourceBranch ?? '').replace('refs/heads/', ''),
        status: row.status === 'pending' ? 'queued' as const : 'reviewing' as const,
        createdAt: row.created_at,
      };
    });
  }
}
