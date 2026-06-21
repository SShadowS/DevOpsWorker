import postgres from 'postgres';

let _sql: postgres.Sql | undefined;
let _cleanup: (() => void) | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_state (
  work_item_id  INTEGER PRIMARY KEY,
  state         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_config (
  work_item_id  INTEGER PRIMARY KEY,
  config        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage_logs (
  id            SERIAL PRIMARY KEY,
  work_item_id  INTEGER NOT NULL,
  stage_name    TEXT NOT NULL,
  entry_type    TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_logs_wi_stage ON stage_logs (work_item_id, stage_name);
-- Keyset pagination of a stage's log (tail + "load older" both scan this index).
CREATE INDEX IF NOT EXISTS idx_stage_logs_wi_stage_id ON stage_logs (work_item_id, stage_name, id);

-- PR-review attribution (added in pr-reviewer token-reduction plan)
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS entity_type   TEXT NOT NULL DEFAULT 'work_item';
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS review_run_id TEXT;
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS agent_name    TEXT;
CREATE INDEX IF NOT EXISTS idx_stage_logs_run ON stage_logs (review_run_id);

CREATE TABLE IF NOT EXISTS actions (
  id            SERIAL PRIMARY KEY,
  work_item_id  INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_actions_pending ON actions (consumed_at) WHERE consumed_at IS NULL;

-- Action lifecycle columns (added in tracked-actions migration)
ALTER TABLE actions ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE actions ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS error         TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS result        JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actions_status_check') THEN
    ALTER TABLE actions ADD CONSTRAINT actions_status_check
      CHECK (status IN ('pending','running','completed','failed'));
  END IF;
END $$;
-- Backfill: any pre-existing row with consumed_at set is treated as completed
UPDATE actions SET status = 'completed', completed_at = consumed_at
  WHERE consumed_at IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_actions_status_created ON actions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_wi_created    ON actions (work_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runner_status (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            SERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events (created_at);

CREATE TABLE IF NOT EXISTS pr_reviews (
  id            SERIAL PRIMARY KEY,
  pr_id         INTEGER NOT NULL,
  repo_key      TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  title         TEXT,
  recommendation TEXT,
  findings      JSONB,
  findings_count INTEGER,
  comment_id    INTEGER,
  cost_usd      REAL,
  duration_ms   INTEGER,
  turns         INTEGER,
  tool_calls    JSONB,
  session_id    TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_created ON pr_reviews (created_at DESC);
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS review_body TEXT;
`;

/**
 * Connect to PostgreSQL and initialize the schema.
 * Returns a singleton — multiple calls return the same connection.
 * Retries connection up to 10 times with 2s backoff (for pipeline containers
 * that start before PostgreSQL is ready).
 */
export async function connectDatabase(url: string): Promise<postgres.Sql> {
  if (_sql) return _sql;

  const maxRetries = 10;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let sql: postgres.Sql | undefined;
    try {
      sql = postgres(url, {
        max: 5,
        idle_timeout: 30,
        connect_timeout: 10,
        // The schema DDL below is idempotent (CREATE/ALTER ... IF NOT EXISTS), so
        // every connect emits a flood of "already exists, skipping" NOTICEs. Drop
        // those benign ones; forward anything unexpected so real notices aren't lost.
        onnotice: (notice) => {
          // 42P07 = relation already exists, 42701 = column already exists
          if (notice.code === '42P07' || notice.code === '42701') return;
          console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
        },
      });

      // Verify connection + create schema
      await sql.unsafe(SCHEMA);

      _sql = sql;

      // Graceful shutdown
      _cleanup = () => { sql!.end({ timeout: 5 }).catch(() => {}); };
      process.on('beforeExit', _cleanup);
      process.on('SIGTERM', _cleanup);

      return sql;
    } catch (err) {
      // Clean up the failed connection pool to avoid leaks
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
      if (attempt >= maxRetries) throw err;
      console.warn(`[postgres] Connection attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error('Unreachable');
}

/** Disconnect (for tests). */
export async function disconnectDatabase(): Promise<void> {
  if (_sql) {
    if (_cleanup) {
      process.removeListener('beforeExit', _cleanup);
      process.removeListener('SIGTERM', _cleanup);
      _cleanup = undefined;
    }
    await _sql.end({ timeout: 5 });
    _sql = undefined;
  }
}
