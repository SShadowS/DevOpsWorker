import { describe, test, expect } from 'bun:test';
import { ReflectionOutputSchema } from '../../src/agents/reflection/schema.ts';

const valid = {
  coverage: { total: 219, withSaid: 131, pct: 60 },
  adjudications: [{
    prId: 52663, findingKey: '48f49e4bd38e383a', severity: 'critical',
    title: 'waits 10 milliseconds', verdictLabel: 'reviewer-wrong',
    evidenceType: 'docs', evidence: 'MS Learn: in seconds', humanQuote: 'accepts seconds',
  }],
  clusters: [{ key: 'A', name: 'unverified behaviour claims',
    occurrences: [{ prId: 52663, findingKey: '48f49e4bd38e383a' }],
    barStatus: 'clears', barReason: 'verified' }],
  proposedChanges: [{ target: 'core', file: 'src/agents/pr-reviewer/CLAUDE.md',
    unifiedDiff: '--- a\n+++ b\n', rationale: 'gate', clusterKey: 'A' }],
  watchLedger: [], classifierNotes: [], expectedEffects: [{ metric: 'cluster-A rejections', from: 3, to: 0 }],
  logEntryDraft: '### entry\n',
  summary: 'One verified cluster, one gate proposed.',
};

describe('ReflectionOutputSchema', () => {
  test('accepts a valid proposal', () => {
    expect(ReflectionOutputSchema.safeParse(valid).success).toBe(true);
  });
  test('rejects more than 3 proposed changes', () => {
    const four = { ...valid, proposedChanges: Array(4).fill(valid.proposedChanges[0]) };
    expect(ReflectionOutputSchema.safeParse(four).success).toBe(false);
  });
  test('rejects an unknown verdict label', () => {
    const bad = { ...valid, adjudications: [{ ...valid.adjudications[0], verdictLabel: 'maybe' }] };
    expect(ReflectionOutputSchema.safeParse(bad).success).toBe(false);
  });
  test('empty proposedChanges is legal — a cycle may ship nothing', () => {
    expect(ReflectionOutputSchema.safeParse({ ...valid, proposedChanges: [] }).success).toBe(true);
  });
});
