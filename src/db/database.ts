import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_state (
  work_item_id  INTEGER PRIMARY KEY,
  state         TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_config (
  work_item_id  INTEGER PRIMARY KEY,
  config        TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id  INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT,
  created_at    TEXT NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_pending ON actions (consumed_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS runner_status (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  processed   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events (created_at);

CREATE TABLE IF NOT EXISTS stage_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id  INTEGER NOT NULL,
  stage_name    TEXT NOT NULL,
  entry_type    TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_logs_wi_stage ON stage_logs (work_item_id, stage_name);
`;

/**
 * Open (or create) the pipeline SQLite database.
 * Enables WAL mode and sets busy timeout for multi-process access.
 */
export function openDatabase(stateDir: string): Database {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const dbPath = join(stateDir, 'pipeline.db');
  const db = new Database(dbPath);
  // Use DELETE journal mode (not WAL) because containers bind-mount the state
  // directory and WAL files don't work reliably across mount boundaries.
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(SCHEMA);
  return db;
}
