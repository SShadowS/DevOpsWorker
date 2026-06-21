import { z } from 'zod';

// ---------------------------------------------------------------------------
// CodeReview — output of the Code Review Agent
// ---------------------------------------------------------------------------

export const InlineCommentSchema = z.object({
  filePath: z.string(),
  line: z.number().optional(),
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
  category: z.enum([
    'naming-convention',
    'error-handling',
    'permissions',
    'performance',
    'security',
    'best-practice',
    'missing-implementation',
    'logic-error',
    'other',
  ]),
  comment: z.string(),
  suggestion: z.string().optional().describe('Suggested fix or improvement'),
});

export const DomainAnalysisSchema = z.object({
  domain: z.enum([
    'correctness',
    'architecture',
    'performance',
    'error-handling',
    'integration',
    'security',
    'quality',
    'devils-advocate',
  ]),
  overallRating: z.string().describe('Domain-specific overall rating from the subagent'),
  findingCount: z.number().describe('Total findings in this domain'),
  highSeverityCount: z.number().describe('Number of high-severity findings'),
});

export const CodeReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  feedback: z.string().describe('Overall code review feedback'),
  issues: z.array(InlineCommentSchema),
  strengths: z.array(z.string()).describe('What the code does well'),
  implementsPlannedChanges: z.boolean().describe('Whether the code matches the dev plan'),
  revisionInstructions: z.string().optional().describe('Specific instructions for the coder (if verdict is revise)'),
  domainAnalyses: z.array(DomainAnalysisSchema).optional().describe('Per-domain analysis summaries from specialized subagents'),
});

export type CodeReview = z.infer<typeof CodeReviewSchema>;
