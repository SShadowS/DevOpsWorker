export interface LogEntry {
  id: number;
  stage_name: string;
  entry_type: string;
  content: string;
  created_at: string;
}

/** A bounded, keyset-paginated slice of a stage's log, in ascending id order. */
export interface LogPage {
  entries: LogEntry[];
  /** True if older entries exist before `oldestId`. */
  hasMoreBefore: boolean;
  /** Lowest id in `entries` (cursor for "load older"), or null when empty. */
  oldestId: number | null;
  /** Highest id in `entries`, or null when empty. */
  newestId: number | null;
}

export interface ReadStageLogPageOptions {
  /** Max entries to return (the tail). */
  limit: number;
  /** When set, return entries with id < beforeId (page backwards). */
  beforeId?: number;
}

export interface ILogSink {
  write(stageName: string, entryType: string, content: string): void;
  readStageLog(stageName: string): Promise<LogEntry[]> | LogEntry[];
  readAllStages(): Promise<string[]> | string[];
  /**
   * Bounded read: the last `limit` entries for a stage (chronological), or the
   * page immediately before `beforeId`. Prevents dumping an entire stage at once.
   */
  readStageLogPage?(
    stageName: string,
    opts: ReadStageLogPageOptions,
  ): Promise<LogPage> | LogPage;
  /** Read entries with id > afterId, across all stages. Used for live polling. */
  readNewEntries?(afterId: number, limit?: number): Promise<LogEntry[]> | LogEntry[];
  /** Highest log id for this work item (0 if none). Used to start a live poller without replaying history. */
  readLatestLogId?(): Promise<number> | number;
}
