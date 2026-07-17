import type postgres from 'postgres';
import type { ILogSink, LogEntry, LogPage, ReadStageLogPageOptions } from '../pipeline/log-sink.interface.ts';
import { rowToLogEntry, buildLogPage } from './pg-log-sink.ts';

/**
 * Log sink for PR reviews. Stores tool-input/transcript entries in stage_logs
 * keyed by prId (work_item_id), tagged entity_type='pull_request' plus a
 * review_run_id and the current agent_name (orchestrator or sub-agent).
 */
export class PgPrReviewLogSink implements ILogSink {
  private agentName = 'pr-reviewer';

  constructor(
    private readonly sql: postgres.Sql,
    private readonly prId: number,
    private readonly reviewRunId: string,
  ) {}

  /** Switch the agent attribution applied to subsequent writes. */
  setAgentName(name: string): void {
    this.agentName = name || 'pr-reviewer';
  }

  write(stageName: string, entryType: string, content: string): void {
    try {
      this.sql`
        INSERT INTO stage_logs
          (work_item_id, stage_name, entry_type, content, entity_type, review_run_id, agent_name)
        VALUES
          (${this.prId}, ${stageName}, ${entryType}, ${content},
           'pull_request', ${this.reviewRunId}, ${this.agentName})
      `.catch(() => {});
    } catch {
      // Swallow synchronous errors (e.g. sql is not a tagged-template function)
    }
  }

  async readStageLog(stageName: string): Promise<LogEntry[]> {
    try {
      const rows = await this.sql`
        SELECT id, stage_name, entry_type, content, created_at::text
        FROM stage_logs
        WHERE work_item_id = ${this.prId} AND stage_name = ${stageName}
          AND entity_type = 'pull_request' AND review_run_id = ${this.reviewRunId}
        ORDER BY id
      `;
      return rows.map(rowToLogEntry);
    } catch { return []; }
  }

  async readAllStages(): Promise<string[]> {
    try {
      const rows = await this.sql`
        SELECT stage_name FROM stage_logs
        WHERE work_item_id = ${this.prId}
          AND entity_type = 'pull_request' AND review_run_id = ${this.reviewRunId}
        GROUP BY stage_name ORDER BY MIN(id)
      `;
      return rows.map((r: any) => r.stage_name);
    } catch { return []; }
  }

  async readStageLogPage(
    stageName: string,
    { limit, beforeId }: ReadStageLogPageOptions,
  ): Promise<LogPage> {
    const empty: LogPage = { entries: [], hasMoreBefore: false, oldestId: null, newestId: null };
    try {
      const fetchCount = limit + 1;
      const rows = beforeId != null
        ? await this.sql`
            SELECT id, stage_name, entry_type, content, created_at::text
            FROM stage_logs
            WHERE work_item_id = ${this.prId} AND stage_name = ${stageName}
              AND entity_type = 'pull_request' AND review_run_id = ${this.reviewRunId}
              AND id < ${beforeId}
            ORDER BY id DESC
            LIMIT ${fetchCount}
          `
        : await this.sql`
            SELECT id, stage_name, entry_type, content, created_at::text
            FROM stage_logs
            WHERE work_item_id = ${this.prId} AND stage_name = ${stageName}
              AND entity_type = 'pull_request' AND review_run_id = ${this.reviewRunId}
            ORDER BY id DESC
            LIMIT ${fetchCount}
          `;
      return buildLogPage(rows.map(rowToLogEntry), limit);
    } catch {
      return empty;
    }
  }
}
