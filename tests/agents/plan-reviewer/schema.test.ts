import { describe, test, expect } from 'bun:test';
import { PlanReviewSchema, PlanDomainAnalysisSchema } from '../../../src/agents/plan-reviewer/schema.ts';

describe('PlanReview schema', () => {
  test('PlanDomainAnalysisSchema accepts all four subagent domains', () => {
    for (const domain of ['requirements', 'feasibility', 'scope-creep', 'devils-advocate']) {
      const result = PlanDomainAnalysisSchema.safeParse({
        domain,
        overallRating: 'ok',
        findingCount: 0,
        highSeverityCount: 0,
      });
      expect(result.success).toBe(true);
    }
  });

  test('PlanReviewSchema accepts optional domainAnalyses field', () => {
    const result = PlanReviewSchema.safeParse({
      verdict: 'approve',
      feedback: 'ok',
      issues: [],
      strengths: [],
      domainAnalyses: [
        { domain: 'requirements', overallRating: 'covered', findingCount: 0, highSeverityCount: 0 },
        { domain: 'devils-advocate', overallRating: 'no objections', findingCount: 0, highSeverityCount: 0 },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('PlanReviewSchema still valid without domainAnalyses (backward compat)', () => {
    const result = PlanReviewSchema.safeParse({
      verdict: 'approve',
      feedback: 'ok',
      issues: [],
      strengths: [],
    });
    expect(result.success).toBe(true);
  });
});
