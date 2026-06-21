import { describe, test, expect, afterEach } from 'bun:test';
import { openDatabase } from '../../src/db/database.ts';
import { SqliteLogSink } from '../../src/db/sqlite-log-sink.ts';
import { PipelineLogger } from '../../src/sdk/pipeline-logger.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('PipelineLogger with SqliteLogSink', () => {
  test('stageStart writes header to SQLite', () => {
    const dir = setup();
    const db = openDatabase(dir);
    const sink = new SqliteLogSink(db, 100);
    const logger = new PipelineLogger(join(dir, 'logs'), 100, sink);

    logger.stageStart('analyzer');

    const entries = sink.readStageLog('analyzer');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.entry_type).toBe('header');
    expect(entries[0]!.content).toContain('analyzer');
    db.close();
  });

  test('log() writes to SQLite', () => {
    const dir = setup();
    const db = openDatabase(dir);
    const sink = new SqliteLogSink(db, 100);
    const logger = new PipelineLogger(join(dir, 'logs'), 100, sink);

    logger.stageStart('coder');
    logger.log('Turn 1');

    const entries = sink.readStageLog('coder');
    const logEntries = entries.filter(e => e.entry_type === 'log');
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]!.content).toContain('Turn 1');
    db.close();
  });

  test('logJson() writes json entry to SQLite', () => {
    const dir = setup();
    const db = openDatabase(dir);
    const sink = new SqliteLogSink(db, 100);
    const logger = new PipelineLogger(join(dir, 'logs'), 100, sink);

    logger.stageStart('coder');
    logger.logJson('CONFIG', { model: 'sonnet' });

    const entries = sink.readStageLog('coder');
    const jsonEntries = entries.filter(e => e.entry_type === 'json');
    expect(jsonEntries).toHaveLength(1);
    expect(jsonEntries[0]!.content).toContain('sonnet');
    db.close();
  });

  test('stageError() writes error entry to SQLite', () => {
    const dir = setup();
    const db = openDatabase(dir);
    const sink = new SqliteLogSink(db, 100);
    const logger = new PipelineLogger(join(dir, 'logs'), 100, sink);

    logger.stageStart('coder');
    logger.stageError(new Error('boom'));

    const entries = sink.readStageLog('coder');
    const errorEntries = entries.filter(e => e.entry_type === 'error');
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0]!.content).toContain('boom');
    db.close();
  });

  test('works without sink (backwards compatible)', () => {
    const dir = setup();
    const logger = new PipelineLogger(join(dir, 'logs'), 100);

    // Should not throw
    logger.stageStart('analyzer');
    logger.log('hello');
    logger.logJson('test', { x: 1 });
    logger.stageError(new Error('test'));
    logger.stageComplete({ costUsd: 1.5 });
  });
});
