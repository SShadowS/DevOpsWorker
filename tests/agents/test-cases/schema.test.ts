import { describe, test, expect } from 'bun:test';
import { TestCaseEntrySchema, TestCasesOutputSchema } from '../../../src/agents/test-cases/schema.ts';

describe('TestCaseEntrySchema', () => {
  test('accepts a valid test case entry', () => {
    const entry = {
      id: 12345,
      title: 'Verify posting a sales credit memo calculates correct VAT',
      stepCount: 5,
      derivedFrom: 'Test scenario: VAT calculation on credit memos',
    };
    expect(TestCaseEntrySchema.parse(entry)).toEqual(entry);
  });

  test('rejects missing id', () => {
    const entry = {
      title: 'Some test',
      stepCount: 3,
      derivedFrom: 'AC-1',
    };
    expect(() => TestCaseEntrySchema.parse(entry)).toThrow();
  });

  test('rejects non-numeric id', () => {
    const entry = {
      id: 'abc',
      title: 'Some test',
      stepCount: 3,
      derivedFrom: 'AC-1',
    };
    expect(() => TestCaseEntrySchema.parse(entry)).toThrow();
  });
});

describe('TestCasesOutputSchema', () => {
  test('accepts valid output with multiple test cases', () => {
    const output = {
      testCases: [
        { id: 100, title: 'Verify happy path', stepCount: 4, derivedFrom: 'Scenario 1' },
        { id: 101, title: 'Verify error handling', stepCount: 3, derivedFrom: 'Scenario 2' },
      ],
      summary: 'Created 2 test cases covering happy path and error scenarios',
    };
    expect(TestCasesOutputSchema.parse(output)).toEqual(output);
  });

  test('accepts empty test cases array', () => {
    const output = {
      testCases: [],
      summary: 'No test cases needed',
    };
    expect(TestCasesOutputSchema.parse(output)).toEqual(output);
  });

  test('rejects missing summary', () => {
    const output = {
      testCases: [{ id: 100, title: 'Test', stepCount: 1, derivedFrom: 'AC-1' }],
    };
    expect(() => TestCasesOutputSchema.parse(output)).toThrow();
  });

  test('rejects missing testCases array', () => {
    const output = {
      summary: 'Some summary',
    };
    expect(() => TestCasesOutputSchema.parse(output)).toThrow();
  });
});
