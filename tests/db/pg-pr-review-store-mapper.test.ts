import { describe, test, expect } from 'bun:test';
import { rowToPRReview } from '../../src/db/pg-pr-review-store.ts';

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
});
