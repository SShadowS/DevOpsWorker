import { describe, test, expect } from 'bun:test';
import { rowToReflectionProposal, PROPOSAL_STATUSES } from '../../src/db/reflection-proposal-mapper.ts';

describe('rowToReflectionProposal', () => {
  const fullRow = {
    id: 7,
    cycle_date: new Date('2026-08-15T00:00:00Z'),
    window_days: 35,
    coverage: { total: 219, withSaid: 131, pct: 60 },
    adjudications: [{
      prId: 52663, findingKey: '48f49e4bd38e383a', severity: 'critical',
      title: 'The new "wait 10 seconds for the lock" waits 10 milliseconds',
      verdictLabel: 'reviewer-wrong', evidenceType: 'docs',
      evidence: 'MS Learn: lock timeout duration in seconds',
      humanQuote: 'No, Database.LockTimeoutDuration accepts seconds.',
    }],
    clusters: [{ key: 'A', name: 'unverified behaviour claims', occurrences: [{ prId: 52663, findingKey: '48f49e4bd38e383a' }], barStatus: 'clears', barReason: 'verified reviewer-wrong' }],
    proposed_changes: [{ target: 'core', file: 'src/agents/pr-reviewer/CLAUDE.md', unifiedDiff: '--- a\n+++ b\n', rationale: 'evidence gate', clusterKey: 'A' }],
    watch_ledger: [{ name: 'upgrade-code calibration', occurrences: 3, prs: 1 }],
    classifier_notes: ['coder-agent quote misread as team words'],
    expected_effects: [{ metric: 'cluster-A rejections', from: 3, to: 0 }],
    log_entry_draft: '### 2026-09-15 — reflection\n',
    status: 'pending',
    decided_by: null, decided_at: null,
    applied_at: null, applied_commits: null,
    cost_usd: 7.5, session_id: 'sess-1', error: null,
    created_at: new Date('2026-08-15T06:00:00Z'),
  };

  test('maps a full row', () => {
    const p = rowToReflectionProposal(fullRow);
    expect(p.id).toBe(7);
    expect(p.cycleDate).toBe('2026-08-15');
    expect(p.windowDays).toBe(35);
    expect(p.coverage).toEqual({ total: 219, withSaid: 131, pct: 60 });
    expect(p.adjudications[0]!.verdictLabel).toBe('reviewer-wrong');
    expect(p.proposedChanges[0]!.target).toBe('core');
    expect(p.status).toBe('pending');
    expect(p.createdAt).toBe('2026-08-15T06:00:00.000Z');
  });

  test('unknown status maps to null and warns once', () => {
    const p = rowToReflectionProposal({ ...fullRow, status: 'wat' });
    expect(p.status).toBeNull();
  });

  test('null JSONB columns map to null, not empty arrays', () => {
    const p = rowToReflectionProposal({ ...fullRow, watch_ledger: null, classifier_notes: null, coverage: null });
    expect(p.watchLedger).toBeNull();
    expect(p.classifierNotes).toBeNull();
    expect(p.coverage).toBeNull();
  });

  test('PROPOSAL_STATUSES lists the five states', () => {
    expect([...PROPOSAL_STATUSES].sort()).toEqual(['applied', 'approved', 'pending', 'rejected', 'superseded']);
  });
});
