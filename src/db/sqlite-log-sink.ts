import type { Database } from 'bun:sqlite';
import type {
  ILogSink,
  LogEntry,
  LogPage,
  ReadStageLogPageOptions,
} from '../pipeline/log-sink.interface.ts';
import { buildLogPage } from './pg-log-sink.ts';

export type { LogEntry };

/**
 * Write-only sink that persists pipeline log entries to SQLite.
 * All writes are no-throw — logging must never crash the pipeline.
 */
export class SqliteLogSink implements ILogSink {
  constructor(
    private readonly db: Database,
    private readonly workItemId: number,
  ) {}

  write(stageName: string, entryType: string, content: string): void {
    try {
      this.db.query(
        'INSERT INTO stage_logs (work_item_id, stage_name, entry_type, content, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(this.workItemId, stageName, entryType, content, new Date().toISOString());
    } catch {
      // Silently swallow — logging must never crash the pipeline
    }
  }

  /** Read all log entries for a given stage (for dashboard/debugging). */
  readStageLog(stageName: string): LogEntry[] {
    try {
      return this.db.query(
        'SELECT id, stage_name, entry_type, content, created_at FROM stage_logs WHERE work_item_id = ? AND stage_name = ? ORDER BY id',
      ).all(this.workItemId, stageName) as LogEntry[];
    } catch {
      return [];
    }
  }

  /** Bounded tail / backwards page of a stage's log (chronological order). */
  readStageLogPage(stageName: string, { limit, beforeId }: ReadStageLogPageOptions): LogPage {
    const empty: LogPage = { entries: [], hasMoreBefore: false, oldestId: null, newestId: null };
    try {
      const fetchCount = limit + 1;
      const descRows = (beforeId != null
        ? this.db.query(
            'SELECT id, stage_name, entry_type, content, created_at FROM stage_logs WHERE work_item_id = ? AND stage_name = ? AND id < ? ORDER BY id DESC LIMIT ?',
          ).all(this.workItemId, stageName, beforeId, fetchCount)
        : this.db.query(
            'SELECT id, stage_name, entry_type, content, created_at FROM stage_logs WHERE work_item_id = ? AND stage_name = ? ORDER BY id DESC LIMIT ?',
          ).all(this.workItemId, stageName, fetchCount)) as LogEntry[];
      return buildLogPage(descRows, limit);
    } catch {
      return empty;
    }
  }

  /** Return distinct stage names for this work item, in insertion order. */
  readAllStages(): string[] {
    try {
      const rows = this.db.query(
        'SELECT stage_name FROM stage_logs WHERE work_item_id = ? GROUP BY stage_name ORDER BY MIN(id)',
      ).all(this.workItemId) as { stage_name: string }[];
      return rows.map(r => r.stage_name);
    } catch {
      return [];
    }
  }
}
