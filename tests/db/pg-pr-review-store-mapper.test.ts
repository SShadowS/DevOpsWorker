import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rowToPRReview } from '../../src/db/pg-pr-review-store.ts';
import type { PRFinding } from '../../src/agents/pr-reviewer/schema.ts';

describe('rowToPRReview', () => {
  test('maps review_run_id to reviewRunId', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
    });
    expect(row.reviewRunId).toBe('pr42-abc');
  });

  test('maps findings_list to findingsList', () => {
    const findingsList: PRFinding[] = [
      { severity: 'critical', title: 'Missing guard', file: 'App/Foo.Codeunit.al', line: 42, location: 'PostDocument', body: 'Explanation.' },
    ];
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'request changes', findings: null, findings_count: 1,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      findings_list: findingsList,
    });
    expect(row.findingsList).toEqual(findingsList);
  });

  test('maps a null findings_list to null (not attempted / no findings)', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      findings_list: null,
    });
    expect(row.findingsList).toBeNull();
  });

  test('maps inline_threads to inlineThreads', () => {
    const inlineThreads = { created: 2, updated: 1, stale: 0, failed: 0 };
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'request changes', findings: null, findings_count: 1,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      inline_threads: inlineThreads,
    });
    expect(row.inlineThreads).toEqual(inlineThreads);
  });

  test('maps a null inline_threads to null — distinct from an all-zero measured result', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      inline_threads: null,
    });
    expect(row.inlineThreads).toBeNull();
  });
});

describe('PgPRReviewStore.save — INSERT column/placeholder parity', () => {
  // A hand-maintained parameterised INSERT only fails at runtime, against the
  // live database, if the column list and the `${}` placeholder count drift —
  // no mapper test would catch that. Read the source and count both sides.
  const src = readFileSync(fileURLToPath(new URL('../../src/db/pg-pr-review-store.ts', import.meta.url)), 'utf-8');

  test('names both new columns', () => {
    expect(src).toContain('findings_list');
    expect(src).toContain('inline_threads');
  });

  test('column count matches placeholder count in the INSERT', () => {
    const columnMatch = src.match(/INSERT INTO pr_reviews \(([^)]*)\)/);
    expect(columnMatch).not.toBeNull();
    const columns = columnMatch![1]!.split(',').map((c) => c.trim()).filter(Boolean);

    const valuesMatch = src.match(/VALUES \(([\s\S]*?)\n\s*\)\s*\n\s*RETURNING id/);
    expect(valuesMatch).not.toBeNull();
    const placeholderCount = (valuesMatch![1]!.match(/\$\{/g) ?? []).length;

    expect(columns).toContain('findings_list');
    expect(columns).toContain('inline_threads');
    expect(placeholderCount).toBe(columns.length);
  });
});
