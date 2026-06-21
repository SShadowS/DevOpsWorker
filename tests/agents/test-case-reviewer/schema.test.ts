import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { TestCaseReviewSchema, TestCaseReviewIssueSchema } from '../../../src/agents/test-case-reviewer/schema.ts';

describe('TestCaseReviewIssueSchema', () => {
  test('accepts a valid issue', () => {
    const issue = {
      severity: 'major' as const,
      category: 'missing-coverage' as const,
      testCaseId: 100,
      description: 'Missing negative test for invalid customer',
      suggestion: 'Add a test case for posting with blocked customer',
    };
    expect(TestCaseReviewIssueSchema.parse(issue)).toEqual(issue);
  });

  test('rejects invalid severity', () => {
    expect(() => TestCaseReviewIssueSchema.parse({
      severity: 'unknown', category: 'missing-coverage',
      description: 'x', suggestion: 'y',
    })).toThrow();
  });

  test('accepts issue without testCaseId (general coverage issue)', () => {
    const issue = {
      severity: 'critical',
      category: 'missing-coverage',
      description: 'No error scenario test cases',
      suggestion: 'Add negative test cases',
    };
    const parsed = TestCaseReviewIssueSchema.parse(issue);
    expect(parsed.testCaseId).toBeUndefined();
  });
});

describe('TestCaseReviewSchema', () => {
  test('accepts approve verdict with no issues', () => {
    const review = {
      verdict: 'approve' as const,
      feedback: 'Test cases comprehensively cover all scenarios',
      issues: [] as Array<z.infer<typeof TestCaseReviewIssueSchema>>,
      strengths: ['Good coverage of edge cases'],
    };
    expect(TestCaseReviewSchema.parse(review)).toEqual(review);
  });

  test('accepts revise verdict with issues and revision instructions', () => {
    const review = {
      verdict: 'revise' as const,
      feedback: 'Missing negative test cases',
      issues: [{
        severity: 'critical' as const, category: 'missing-coverage' as const,
        description: 'No error test', suggestion: 'Add error tests',
      }],
      strengths: ['Good step detail'],
      revisionInstructions: 'Add test cases for error scenarios',
    };
    expect(TestCaseReviewSchema.parse(review)).toEqual(review);
  });

  test('rejects missing verdict', () => {
    expect(() => TestCaseReviewSchema.parse({
      feedback: 'ok', issues: [], strengths: [],
    })).toThrow();
  });

  test('rejects missing feedback', () => {
    expect(() => TestCaseReviewSchema.parse({
      verdict: 'approve', issues: [], strengths: [],
    })).toThrow();
  });
});
