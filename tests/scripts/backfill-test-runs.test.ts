import { describe, expect, test } from 'bun:test';
import { BACKFILL_PREDICATE, parseArgs } from '../../scripts/backfill-test-runs.ts';

describe('backfill-test-runs', () => {
  test('predicate is the agreed union', () => {
    expect(BACKFILL_PREDICATE).toBe("comment_id = 0 OR source_branch = ''");
  });

  test('dry-run is the default', () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  test('--apply opts in to writing', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
  });
});
