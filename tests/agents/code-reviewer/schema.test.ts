import { describe, test, expect } from 'bun:test';
import { CodeReviewSchema, DomainAnalysisSchema } from '../../../src/agents/code-reviewer/schema.ts';

describe('CodeReview schema', () => {
  test('DomainAnalysisSchema accepts devils-advocate domain', () => {
    const result = DomainAnalysisSchema.safeParse({
      domain: 'devils-advocate',
      overallRating: 'no high-confidence objections',
      findingCount: 0,
      highSeverityCount: 0,
    });
    expect(result.success).toBe(true);
  });

  test('CodeReviewSchema accepts domainAnalyses with devils-advocate entry', () => {
    const result = CodeReviewSchema.safeParse({
      verdict: 'approve',
      feedback: 'ok',
      issues: [],
      strengths: [],
      implementsPlannedChanges: true,
      domainAnalyses: [
        { domain: 'correctness', overallRating: 'correct', findingCount: 0, highSeverityCount: 0 },
        { domain: 'devils-advocate', overallRating: 'no objections', findingCount: 0, highSeverityCount: 0 },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('DomainAnalysisSchema still accepts existing domains', () => {
    for (const domain of ['correctness', 'architecture', 'performance', 'error-handling', 'integration', 'security', 'quality']) {
      const result = DomainAnalysisSchema.safeParse({
        domain,
        overallRating: 'ok',
        findingCount: 0,
        highSeverityCount: 0,
      });
      expect(result.success).toBe(true);
    }
  });
});
