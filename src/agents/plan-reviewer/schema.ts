import { z } from 'zod';

// ---------------------------------------------------------------------------
// PlanReview — output of the Plan Review Agent
// ---------------------------------------------------------------------------

export const PlanReviewIssueSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
  category: z.enum([
    'missing-acceptance-criteria',
    'scope-creep',
    'architectural-concern',
    'anti-pattern',
    'missing-edge-case',
    'non-idiomatic',
    'risk-underestimate',
    'other',
  ]),
  description: z.string(),
  suggestion: z.string().describe('How to address this issue'),
  relatedObject: z.string().optional().describe('Which AL object this relates to'),
});

export const PlanDomainAnalysisSchema = z.object({
  domain: z.enum([
    'requirements',
    'feasibility',
    'scope-creep',
    'devils-advocate',
  ]),
  overallRating: z.string().describe('Domain-specific overall rating from the subagent'),
  findingCount: z.number().describe('Total findings in this domain'),
  highSeverityCount: z.number().describe('Number of high-severity findings'),
});

export const PlanReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  feedback: z.string().describe('Overall feedback on the plan'),
  issues: z.array(PlanReviewIssueSchema),
  strengths: z.array(z.string()).describe('What the plan does well'),
  revisionInstructions: z.string().optional().describe('Specific instructions for revision (if verdict is revise)'),
  domainAnalyses: z.array(PlanDomainAnalysisSchema).optional().describe('Per-domain analysis summaries from specialized subagents'),
});

export type PlanReview = z.infer<typeof PlanReviewSchema>;
export type PlanDomainAnalysis = z.infer<typeof PlanDomainAnalysisSchema>;
