import { z } from 'zod';

export const PRReviewSchema = z.object({
  commentId: z.number().describe('ID of the posted/updated PR comment'),
  findingsCount: z.number().describe('Total number of findings'),
  recommendation: z.string().describe('Overall recommendation (approve / request changes / needs discussion)'),
  findings: z.object({
    critical: z.number(),
    major: z.number(),
    minor: z.number(),
    nitpick: z.number(),
  }).describe('Finding counts by severity level'),
  reviewBody: z.string().describe('The full synthesized review in markdown — the same content posted as the PR comment. Always populate this, even in replay mode.'),
});

export type PRReviewResult = z.infer<typeof PRReviewSchema>;
