import type postgres from 'postgres';
import type { IPRReviewStore, PRReviewRow } from '../pipeline/pr-review-store.interface.ts';

export class PgPRReviewStore implements IPRReviewStore {
  constructor(private readonly sql: postgres.Sql) {}

  async save(row: Omit<PRReviewRow, 'id'>): Promise<number> {
    const [result] = await this.sql`
      INSERT INTO pr_reviews (pr_id, repo_key, source_branch, target_branch, title, recommendation, findings, findings_count, comment_id, cost_usd, duration_ms, turns, tool_calls, session_id, error, review_body, action_id, review_run_id, sub_agents, model_usage, findings_list, inline_threads, review_path, applied_levers, image_sha, is_test, observed_cherry_pick, observed_cherry_pick_source)
      VALUES (
        ${row.prId}, ${row.repoKey}, ${row.sourceBranch}, ${row.targetBranch},
        ${row.title}, ${row.recommendation},
        ${row.findings ? this.sql.json(row.findings) : null},
        ${row.findingsCount}, ${row.commentId},
        ${row.costUsd}, ${row.durationMs}, ${row.turns},
        ${row.toolCalls ? this.sql.json(row.toolCalls) : null},
        ${row.sessionId}, ${row.error}, ${row.reviewBody}, ${row.actionId}, ${row.reviewRunId},
        ${row.subAgents ? this.sql.json(row.subAgents as unknown as postgres.JSONValue) : null},
        ${row.modelUsage ? this.sql.json(row.modelUsage as unknown as postgres.JSONValue) : null},
        ${row.findingsList ? this.sql.json(row.findingsList as unknown as postgres.JSONValue) : null},
        ${row.inlineThreads ? this.sql.json(row.inlineThreads as unknown as postgres.JSONValue) : null},
        ${row.reviewPath ?? null},
        ${row.appliedLevers ? this.sql.json(row.appliedLevers as unknown as postgres.JSONValue) : null},
        ${row.imageSha ?? null},
        ${row.isTest},
        ${row.observedCherryPick ?? null},
        ${row.observedCherryPickSource ?? null}
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
             error, review_body, created_at::text, action_id, review_run_id,
             sub_agents, model_usage, findings_list, inline_threads, review_path, applied_levers, image_sha, is_test,
             observed_cherry_pick, observed_cherry_pick_source
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
             error, review_body, created_at::text, action_id, review_run_id,
             sub_agents, model_usage, findings_list, inline_threads, review_path, applied_levers, image_sha, is_test,
             observed_cherry_pick, observed_cherry_pick_source
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
             error, review_body, created_at::text, action_id, review_run_id,
             sub_agents, model_usage, findings_list, inline_threads, review_path, applied_levers, image_sha, is_test,
             observed_cherry_pick, observed_cherry_pick_source
      FROM pr_reviews
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToPRReview(rows[0]) : null;
  }

  async findLatestByPrId(prId: number): Promise<PRReviewRow | null> {
    const rows = await this.sql`
      SELECT id, pr_id, repo_key, source_branch, target_branch, title,
             recommendation, findings, findings_count, comment_id,
             cost_usd, duration_ms, turns, tool_calls, session_id,
             error, review_body, created_at::text, action_id, review_run_id,
             sub_agents, model_usage, findings_list, inline_threads, review_path, applied_levers, image_sha, is_test,
             observed_cherry_pick, observed_cherry_pick_source
      FROM pr_reviews
      WHERE pr_id = ${prId}
        -- Excludes a sanity-path review of THIS pr_id from counting as its own
        -- "deep review" — on a release-line chain A -> B -> C, the sanity review
        -- that ported A's fix onto B is not a deep review of B itself, and
        -- without this a chain of ports mistakes each cheap review for the deep
        -- one the prompt is meant to be reporting the absence of.
        -- IS NULL matters: every row predating this feature is a full review.
        AND (review_path IS NULL OR review_path LIKE 'full:%')
      ORDER BY created_at DESC
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
    subAgents: r.sub_agents ?? null,
    modelUsage: r.model_usage ?? null,
    findingsList: r.findings_list ?? null,
    inlineThreads: r.inline_threads ?? null,
    reviewPath: r.review_path ?? null,
    appliedLevers: r.applied_levers ?? null,
    imageSha: r.image_sha ?? null,
    isTest: r.is_test ?? false,
    observedCherryPick: r.observed_cherry_pick ?? null,
    observedCherryPickSource: r.observed_cherry_pick_source ?? null,
  };
}
