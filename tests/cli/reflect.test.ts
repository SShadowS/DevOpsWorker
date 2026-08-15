import { describe, test, expect } from 'bun:test';
import { parseReflectArgs, buildLearningSetBlock } from '../../src/cli/reflect.ts';

describe('parseReflectArgs', () => {
  test('defaults', () => {
    expect(parseReflectArgs([])).toEqual({ windowDays: 35, dryRun: false, noNotify: false, cycleDate: undefined });
  });
  test('flags', () => {
    expect(parseReflectArgs(['--window-days', '14', '--dry-run', '--no-notify', '--cycle-date', '2026-09-15']))
      .toEqual({ windowDays: 14, dryRun: true, noNotify: true, cycleDate: '2026-09-15' });
  });
});

describe('buildLearningSetBlock', () => {
  test('carries quote, label and body for a row, and says when a body is missing', () => {
    const rows = [{ prId: 52663, findingKey: 'k1', severity: 'critical', title: 'T', file: 'F',
      said: 'rejected-wrong', saidQuote: 'accepts seconds', saidEvidence: 'pr-discussion' }];
    const block = buildLearningSetBlock(rows as never, new Map([['k1', 'the finding body']]));
    expect(block).toContain('accepts seconds');
    expect(block).toContain('the finding body');
    const noBody = buildLearningSetBlock(rows as never, new Map());
    expect(noBody).toContain('(finding body not recovered');
  });

  test('prepends the coverage summary when given, omits it when not', () => {
    const rows = [{ prId: 52663, findingKey: 'k1', severity: 'critical', title: 'T', file: 'F',
      said: 'rejected-wrong', saidQuote: 'accepts seconds', saidEvidence: 'pr-discussion' }];

    const withCoverage = buildLearningSetBlock(rows as never, new Map(), { total: 42, withSaid: 18, pct: 42.9 });
    expect(withCoverage).toContain('42 critical+major finding(s)');
    expect(withCoverage).toContain('18');
    expect(withCoverage).toContain('42.9%');

    const withoutCoverage = buildLearningSetBlock(rows as never, new Map());
    expect(withoutCoverage).not.toContain('critical+major finding(s)');
  });
});
