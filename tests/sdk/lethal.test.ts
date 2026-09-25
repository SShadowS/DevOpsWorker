import { describe, test, expect } from 'bun:test';
import { buildTestGapLeads, changedLines, renderTestGapBlock, TEST_GAP_MARKER, type LethalFiles } from '../../src/sdk/lethal.ts';
import { maybeBuildTestGapBlock } from '../../src/cli/review-pr.ts';

// Shapes follow LethAL's published schemas (report v2, explain v4). Field names
// only: LethAL's prose is explicitly not a contract.
const patch = [
  'diff --git a/App/src/Mgt.Codeunit.al b/App/src/Mgt.Codeunit.al',
  '--- a/App/src/Mgt.Codeunit.al',
  '+++ b/App/src/Mgt.Codeunit.al',
  '@@ -10,3 +10,4 @@ codeunit 50100 Mgt',
  '     procedure Guard()',
  '-        old();',
  '+        CheckA();',
  '+        CheckB();',
  '     end;',
].join('\n');
const changed = changedLines([{ path: 'App/src/Mgt.Codeunit.al', patch }]);

function survivor(code: string, line: number, over: Record<string, unknown> = {}) {
  return {
    mutantCode: code, file: 'src\\Mgt.Codeunit.al', line, codeunitName: 'Mgt', procedureName: 'Guard',
    operatorName: 'lethal.empty-block', originalText: 'CheckA();', mutatedText: '',
    attribution: 'exact', executionProven: true, coveringTests: ['Mgt Tests.GuardErrors'], ...over,
  };
}

function files(over: Partial<LethalFiles['report']> = {}, survivors = [survivor('M1', 11)], exitCode?: number): LethalFiles {
  return {
    explain: { explainSchemaVersion: 4, survivors },
    report: {
      schemaVersion: 2,
      baselineGreen: true,
      mutants: [{ mutantCode: 'M9', file: 'src\\Mgt.Codeunit.al', line: 12, procedureName: 'Guard', verdict: 'no-coverage' }],
      likelyEquivalentSurvivors: { byRisk: [{ risk: 'value-rewrite', mutants: ['M1'] }] },
      ...over,
    },
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

describe('changedLines', () => {
  test('counts right-side lines of added lines only', () => {
    expect([...changed.get('App/src/Mgt.Codeunit.al')!]).toEqual([11, 12]);
  });
});

describe('buildTestGapLeads', () => {
  test('keeps execution-proven survivors on changed lines, matched by path suffix', () => {
    const leads = buildTestGapLeads(files(), changed);
    expect(leads.usable).toBe(true);
    if (!leads.usable) return;
    expect(leads.procedures).toHaveLength(1);
    expect(leads.procedures[0]!.file).toBe('App/src/Mgt.Codeunit.al');
    expect(leads.procedures[0]!.survivors[0]!.equivalenceRisk).toBe('value-rewrite');
    expect(leads.noCoverage).toEqual([{ file: 'App/src/Mgt.Codeunit.al', procedure: 'Guard', lines: [12] }]);
  });

  test('drops survivors on unchanged lines, and ones not proven executed by an exact test', () => {
    const leads = buildTestGapLeads(files({}, [
      survivor('M2', 40),
      survivor('M3', 11, { executionProven: false }),
      survivor('M4', 11, { attribution: 'object' }),
    ]), changed);
    expect(leads.usable && leads.procedures).toEqual([]);
  });

  test('LethAL exit 3 or 4, a red baseline, or an unknown schema means no leads', () => {
    expect(buildTestGapLeads(files({}, undefined, 3), changed)).toEqual({ usable: false, reason: 'lethal exited 3' });
    expect(buildTestGapLeads(files({}, undefined, 4), changed).usable).toBe(false);
    expect(buildTestGapLeads(files({ baselineGreen: false }), changed).usable).toBe(false);
    expect(buildTestGapLeads(files({ schemaVersion: 3 }), changed).usable).toBe(false);
  });
});

describe('renderTestGapBlock', () => {
  test('names the procedure, the covering test and the agent to dispatch', () => {
    const block = renderTestGapBlock(buildTestGapLeads(files(), changed));
    expect(block.startsWith(TEST_GAP_MARKER)).toBe(true);
    expect(block).toContain('### App/src/Mgt.Codeunit.al — Guard (1 survived)');
    expect(block).toContain('Mgt Tests.GuardErrors');
    expect(block).toContain('[often equivalent: value-rewrite]');
    expect(block).toContain('`test-gap-analyzer`');
    expect(block).toContain('### Not executed by any test');
  });

  test('is empty when there is nothing to hand over', () => {
    expect(renderTestGapBlock({ usable: false, reason: 'x' })).toBe('');
    expect(renderTestGapBlock({ usable: true, procedures: [], noCoverage: [] })).toBe('');
  });
});

describe('maybeBuildTestGapBlock', () => {
  test('does nothing, and calls nothing, unless PR_REVIEW_LETHAL=1', async () => {
    const saved = process.env['PR_REVIEW_LETHAL'];
    delete process.env['PR_REVIEW_LETHAL'];
    try {
      expect(await maybeBuildTestGapBlock(1, undefined, '/nowhere', {} as never)).toBe('');
    } finally {
      if (saved !== undefined) process.env['PR_REVIEW_LETHAL'] = saved;
    }
  });
});
