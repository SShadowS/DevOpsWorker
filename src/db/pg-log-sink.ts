import type postgres from 'postgres';
import type {
  ILogSink,
  LogEntry,
  LogPage,
  ReadStageLogPageOptions,
} from '../pipeline/log-sink.interface.ts';

export class PgLogSink implements ILogSink {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly workItemId: number,
  ) {}

  write(stageName: string, entryType: string, content: string): void {
    // Fire-and-forget — logging must never crash the pipeline
    try {
      this.sql`
        INSERT INTO stage_logs (work_item_id, stage_name, entry_type, content)
        VALUES (${this.workItemId}, ${stageName}, ${entryType}, ${content})
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
        WHERE work_item_id = ${this.workItemId} AND stage_name = ${stageName} AND entity_type = 'work_item'
        ORDER BY id
      `;
      return rows.map(rowToLogEntry);
    } catch {
      return [];
    }
  }

  async readStageLogPage(
    stageName: string,
    { limit, beforeId }: ReadStageLogPageOptions,
  ): Promise<LogPage> {
    const empty: LogPage = { entries: [], hasMoreBefore: false, oldestId: null, newestId: null };
    try {
      // Fetch one extra row to detect whether older entries remain.
      const fetchCount = limit + 1;
      const rows = beforeId != null
        ? await this.sql`
            SELECT id, stage_name, entry_type, content, created_at::text
            FROM stage_logs
            WHERE work_item_id = ${this.workItemId} AND stage_name = ${stageName} AND entity_type = 'work_item'
              AND id < ${beforeId}
            ORDER BY id DESC
            LIMIT ${fetchCount}
          `
        : await this.sql`
            SELECT id, stage_name, entry_type, content, created_at::text
            FROM stage_logs
            WHERE work_item_id = ${this.workItemId} AND stage_name = ${stageName} AND entity_type = 'work_item'
            ORDER BY id DESC
            LIMIT ${fetchCount}
          `;
      return buildLogPage(rows.map(rowToLogEntry), limit);
    } catch {
      return empty;
    }
  }

  async readAllStages(): Promise<string[]> {
    try {
      const rows = await this.sql`
        SELECT stage_name FROM stage_logs
        WHERE work_item_id = ${this.workItemId} AND entity_type = 'work_item'
        GROUP BY stage_name ORDER BY MIN(id)
      `;
      return rows.map((r: any) => r.stage_name);
    } catch {
      return [];
    }
  }

  async readNewEntries(afterId: number, limit = 500): Promise<LogEntry[]> {
    try {
      const rows = await this.sql`
        SELECT id, stage_name, entry_type, content, created_at::text
        FROM stage_logs
        WHERE work_item_id = ${this.workItemId} AND entity_type = 'work_item' AND id > ${afterId}
        ORDER BY id
        LIMIT ${limit}
      `;
      return rows.map(rowToLogEntry);
    } catch {
      return [];
    }
  }

  async readLatestLogId(): Promise<number> {
    try {
      const rows = await this.sql`
        SELECT COALESCE(MAX(id), 0) AS max_id
        FROM stage_logs
        WHERE work_item_id = ${this.workItemId} AND entity_type = 'work_item'
      `;
      return Number((rows[0] as { max_id: number } | undefined)?.max_id ?? 0);
    } catch {
      return 0;
    }
  }
}

/** Map a raw (snake_case) stage_logs row to the camelCase LogEntry DTO. Shared by the PG, SQLite, and PR-review log sinks. */
export function rowToLogEntry(r: any): LogEntry {
  return {
    id: r.id,
    stageName: r.stage_name,
    entryType: r.entry_type,
    content: r.content,
    createdAt: r.created_at,
  };
}

/**
 * Turn a DESC-ordered batch (newest first, fetched with limit+1) into an
 * ascending LogPage. Shared by the PG and SQLite sinks.
 */
export function buildLogPage(descRows: LogEntry[], limit: number): LogPage {
  const hasMoreBefore = descRows.length > limit;
  const kept = hasMoreBefore ? descRows.slice(0, limit) : descRows;
  const asc = kept.slice().reverse(); // newest-first → chronological
  return {
    entries: asc,
    hasMoreBefore,
    oldestId: asc.length > 0 ? asc[0]!.id : null,
    newestId: asc.length > 0 ? asc[asc.length - 1]!.id : null,
  };
}
