import { z } from 'zod';

export const TestCaseReviewIssueSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
  category: z.enum([
    'missing-coverage',
    'step-quality',
    'step-accuracy',
    'title-quality',
    'scope-mismatch',
    'duplicate',
    'other',
  ]),
  testCaseId: z.number().optional().describe('ADO ID of the affected test case (omit for general issues)'),
  description: z.string(),
  suggestion: z.string().describe('How to fix this issue'),
});

export const TestCaseReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
  feedback: z.string().describe('Overall review feedback'),
  issues: z.array(TestCaseReviewIssueSchema),
  strengths: z.array(z.string()).describe('What the test cases do well'),
  revisionInstructions: z.string().optional().describe('Specific instructions for revision (if verdict is revise)'),
});

export type TestCaseReview = z.infer<typeof TestCaseReviewSchema>;
