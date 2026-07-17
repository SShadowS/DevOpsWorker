import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteStateStore } from '../../src/db/sqlite-state-store.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// getWatermark() — cheap count + max(updated_at) over pipeline_state, used by
// the dashboard's SessionPoller to skip the expensive full-scan reload when
// nothing changed. Exercised here against the sqlite double.
// ---------------------------------------------------------------------------

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pipeline_state (
      work_item_id  INTEGER PRIMARY KEY,
      state         TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
  `);
  return db;
}

function freshState(): PipelineState {
  return {
    currentStage: 'analyzer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('SqliteStateStore.getWatermark', () => {
  test('returns count 0 and null maxUpdatedAt for an empty table', () => {
    const store = new SqliteStateStore(freshDb());
    expect(store.getWatermark()).toEqual({ count: 0, maxUpdatedAt: null });
  });

  test('count and maxUpdatedAt reflect the stored rows', () => {
    const db = freshDb();
    const store = new SqliteStateStore(db);
    db.query(
      'INSERT INTO pipeline_state (work_item_id, state, updated_at) VALUES (?, ?, ?)',
    ).run(1, '{}', '2024-01-01T00:00:00.000Z');
    db.query(
      'INSERT INTO pipeline_state (work_item_id, state, updated_at) VALUES (?, ?, ?)',
    ).run(2, '{}', '2024-06-01T00:00:00.000Z');

    expect(store.getWatermark()).toEqual({ count: 2, maxUpdatedAt: '2024-06-01T00:00:00.000Z' });
  });

  test('count advances on insert; maxUpdatedAt advances on update, via the real save() path', () => {
    const store = new SqliteStateStore(freshDb());

    store.save(1, freshState());
    const afterFirst = store.getWatermark();
    expect(afterFirst.count).toBe(1);
    expect(afterFirst.maxUpdatedAt).not.toBeNull();

    store.save(2, freshState());
    const afterSecond = store.getWatermark();
    expect(afterSecond.count).toBe(2);

    // Updating an existing row (INSERT OR REPLACE) must not change the count,
    // but must still advance updated_at to a value >= the prior watermark.
    store.save(1, freshState());
    const afterUpdate = store.getWatermark();
    expect(afterUpdate.count).toBe(2);
    expect(afterUpdate.maxUpdatedAt).not.toBeNull();
    expect(new Date(afterUpdate.maxUpdatedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(afterSecond.maxUpdatedAt!).getTime(),
    );
  });
});
