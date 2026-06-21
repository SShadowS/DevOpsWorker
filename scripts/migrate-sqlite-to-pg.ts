#!/usr/bin/env bun
/**
 * One-time migration from SQLite to PostgreSQL.
 * Usage: DATABASE_URL=postgres://... bun scripts/migrate-sqlite-to-pg.ts --sqlite .pipeline/state/pipeline.db
 */
import { parseArgs } from 'util';
import { Database } from 'bun:sqlite';
import { connectDatabase, disconnectDatabase } from '../src/db/postgres.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { sqlite: { type: 'string' } },
  strict: true,
});

const sqlitePath = values.sqlite;
const pgUrl = process.env['DATABASE_URL'];
if (!sqlitePath || !pgUrl) {
  console.error('Usage: DATABASE_URL=postgres://... bun scripts/migrate-sqlite-to-pg.ts --sqlite <path>');
  process.exit(1);
}

const lite = new Database(sqlitePath, { readonly: true });
const pg = await connectDatabase(pgUrl);

// Migrate each table
const tables = [
  {
    name: 'pipeline_state',
    query: 'SELECT work_item_id, state, updated_at FROM pipeline_state',
    insert: (row: any) => pg`
      INSERT INTO pipeline_state (work_item_id, state, updated_at)
      VALUES (${row.work_item_id}, ${pg.json(JSON.parse(row.state))}, ${row.updated_at}::timestamptz)
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'pipeline_config',
    query: 'SELECT work_item_id, config, updated_at FROM pipeline_config',
    insert: (row: any) => pg`
      INSERT INTO pipeline_config (work_item_id, config, updated_at)
      VALUES (${row.work_item_id}, ${pg.json(JSON.parse(row.config))}, ${row.updated_at}::timestamptz)
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'actions',
    query: 'SELECT work_item_id, type, payload, created_at, consumed_at FROM actions',
    insert: (row: any) => pg`
      INSERT INTO actions (work_item_id, type, payload, created_at, consumed_at)
      VALUES (${row.work_item_id}, ${row.type}, ${row.payload}, ${row.created_at}, ${row.consumed_at ?? null})`,
  },
  {
    name: 'runner_status',
    query: 'SELECT key, value, updated_at FROM runner_status',
    insert: (row: any) => pg`
      INSERT INTO runner_status (key, value, updated_at)
      VALUES (${row.key}, ${pg.json(JSON.parse(row.value))}, ${row.updated_at}::timestamptz)
      ON CONFLICT DO NOTHING`,
  },
  {
    name: 'webhook_events',
    query: 'SELECT event_type, payload, processed, error, created_at FROM webhook_events',
    insert: (row: any) => pg`
      INSERT INTO webhook_events (event_type, payload, processed, error, created_at)
      VALUES (${row.event_type}, ${pg.json(JSON.parse(row.payload))}, ${row.processed === 1}, ${row.error}, ${row.created_at}::timestamptz)`,
  },
  {
    name: 'stage_logs',
    query: 'SELECT work_item_id, stage_name, entry_type, content, created_at FROM stage_logs',
    insert: (row: any) => pg`
      INSERT INTO stage_logs (work_item_id, stage_name, entry_type, content, created_at)
      VALUES (${row.work_item_id}, ${row.stage_name}, ${row.entry_type}, ${row.content}, ${row.created_at}::timestamptz)`,
  },
];

for (const table of tables) {
  try {
    const rows = lite.query(table.query).all();
    let migrated = 0, failed = 0;
    for (const row of rows) {
      try {
        await table.insert(row);
        migrated++;
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`  Error in ${table.name}: ${(err as Error).message}`);
      }
    }
    console.log(`${table.name}: ${migrated} migrated, ${failed} failed (of ${rows.length})`);
  } catch (err) {
    console.error(`${table.name}: FAILED — ${(err as Error).message}`);
  }
}

lite.close();
await disconnectDatabase();
console.log('\nMigration complete.');
process.exit(0);
