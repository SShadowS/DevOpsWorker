import type postgres from 'postgres';
import type { IPRReviewStore, PRReviewRow } from '../pipeline/pr-review-store.interface.ts';

export class PgPRReviewStore implements IPRReviewStore {
  constructor(private readonly sql: postgres.Sql) {}

  async save(row: Omit<PRReviewRow, 'id'>): Promise<number> {
    const [result] = await this.sql`
      INSERT INTO pr_reviews (pr_id, repo_key, source_branch, target_branch, title, recommendation, findings, findings_count, comment_id, cost_usd, duration_ms, turns, tool_calls, session_id, error, review_body, action_id, review_run_id)
      VALUES (
        ${row.prId}, ${row.repoKey}, ${row.sourceBranch}, ${row.targetBranch},
        ${row.title}, ${row.recommendation},
        ${row.findings ? this.sql.json(row.findings) : null},
        ${row.findingsCount}, ${row.commentId},
        ${row.costUsd}, ${row.durationMs}, ${row.turns},
        ${row.toolCalls ? this.sql.json(row.toolCalls) : null},
        ${row.sessionId}, ${row.error}, ${row.reviewBody}, ${row.actionId}, ${row.reviewRunId}
      )
      RETURNING id
    `;
    return (result as any).id;
  }

  async listRecent(limit = 50): Promise<PRReviewRow[]> {
    const rows = await this.sql`
      SELECT id, pr_id, repo_key, source_branch, target_branch, title,
             recommendation, findings, findings_count, comment_id,
             cost_usd, duration_ms, turns, tool_calls, session_id,
             error, review_body, created_at::text, action_id, review_run_id
      FROM pr_reviews
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToPRReview);
  }

  async findByActionId(actionId: number): Promise<PRReviewRow | null> {
    const rows = await this.sql`
      SELECT id, pr_id, repo_key, source_branch, target_branch, title,
             recommendation, findings, findings_count, comment_id,
             cost_usd, duration_ms, turns, tool_calls, session_id,
             error, review_body, created_at::text, action_id, review_run_id
      FROM pr_reviews
      WHERE action_id = ${actionId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows.length > 0 ? rowToPRReview(rows[0]) : null;
  }

  async findById(id: number): Promise<PRReviewRow | null> {
    const rows = await this.sql`
      SELECT id, pr_id, repo_key, source_branch, target_branch, title,
             recommendation, findings, findings_count, comment_id,
             cost_usd, duration_ms, turns, tool_calls, session_id,
             error, review_body, created_at::text, action_id, review_run_id
      FROM pr_reviews
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToPRReview(rows[0]) : null;
  }
}

export function rowToPRReview(r: any): PRReviewRow {
  return {
    id: r.id,
    prId: r.pr_id,
    repoKey: r.repo_key,
    sourceBranch: r.source_branch,
    targetBranch: r.target_branch,
    title: r.title,
    recommendation: r.recommendation,
    findings: r.findings,
    findingsCount: r.findings_count,
    commentId: r.comment_id,
    costUsd: r.cost_usd,
    durationMs: r.duration_ms,
    turns: r.turns,
    toolCalls: r.tool_calls,
    sessionId: r.session_id,
    error: r.error,
    reviewBody: r.review_body,
    createdAt: r.created_at,
    actionId: r.action_id,
    reviewRunId: r.review_run_id,
  };
}
