import { describe, test, expect } from 'bun:test';
import { PRFindingSchema } from '../../../src/agents/pr-reviewer/schema.ts';

describe('PRFindingSchema suggested fixes', () => {
  const base = { severity: 'major' as const, title: 'Wrong operator', body: 'text' };

  test('accepts a finding carrying both suggestion fields', () => {
    const parsed = PRFindingSchema.parse({
      ...base,
      file: 'App/X.al',
      line: 12,
      replacesText: '    if A < B then',
      suggestedFix: '    if A <= B then',
    });
    expect(parsed.suggestedFix).toBe('    if A <= B then');
    expect(parsed.replacesText).toBe('    if A < B then');
  });

  test('still accepts a finding with neither field', () => {
    const parsed = PRFindingSchema.parse({ ...base, file: 'App/X.al', line: 12 });
    expect(parsed.suggestedFix).toBeUndefined();
    expect(parsed.replacesText).toBeUndefined();
  });

  test('accepts one field without the other — the posting gate decides, not the schema', () => {
    expect(() =>
      PRFindingSchema.parse({ ...base, file: 'App/X.al', line: 12, suggestedFix: 'x' }),
    ).not.toThrow();
  });

  test('preserves indentation and newlines verbatim', () => {
    const parsed = PRFindingSchema.parse({
      ...base,
      file: 'App/X.al',
      line: 7,
      replacesText: '        A: Boolean;\n        B: Integer;',
      suggestedFix: '        A: Boolean;\n        B: Decimal;',
    });
    expect(parsed.replacesText).toBe('        A: Boolean;\n        B: Integer;');
  });
});
