import { z } from 'zod';
import { PRFindingSchema } from '../pr-reviewer/schema.ts';

/**
 * The backport sanity review's structured output.
 *
 * `findingsList` reuses `PRFindingSchema` deliberately: `applyInlineFindings`
 * anchors line-level PR threads on a finding's file + line + title, so reusing
 * the full reviewer's finding shape is what makes inline comments work on this
 * path without a second implementation.
 */
export const BackportReviewSchema = z.object({
  commentId: z.number().describe('ID of the posted/updated PR comment'),
  sourcePrId: z.number().describe('The PR this change was ported from'),
  sourceReviewStatus: z.enum(['reviewed', 'not-reviewed'])
    .describe('Whether the source PR itself has a completed pipeline review'),
  sourceRecommendation: z.string().nullable()
    .describe('The source review recommendation when it exists, otherwise null'),
  mergePreviewStale: z.boolean()
    .describe('True when the target branch advanced after this PR branch was cut, so the working tree is not the real merge'),
  checkoutOk: z.boolean()
    .describe('True when the working tree was checked out to this PR branch. False makes the symbol and coverage checks unverifiable.'),
  diffFaithful: z.enum(['faithful', 'adapted', 'divergent'])
    .describe('faithful: same content as the source. adapted: differs, and the difference is a legitimate adjustment to this branch. divergent: differs in a way that looks like a mistake.'),
  symbolsResolve: z.enum(['all', 'missing', 'unverified'])
    .describe('Whether every procedure, codeunit and field the ported code references exists on this branch with a compatible signature'),
  coverageIntact: z.enum(['intact', 'gaps', 'unverified'])
    .describe('Whether the fix still covers every path on this branch that needs it, including call sites the source branch did not have'),
  recommendation: z.string().describe('approve / request changes / needs discussion'),
  findingsCount: z.number().describe('Total number of findings'),
  findings: z.object({
    critical: z.number(),
    major: z.number(),
    minor: z.number(),
    nitpick: z.number(),
  }).describe('Finding counts by severity level'),
  findingsList: z.array(PRFindingSchema).default([])
    .describe('Every finding as a structured record, same shape the full reviewer returns'),
  reviewBody: z.string().describe('The posted review markdown'),
});

export type BackportReview = z.infer<typeof BackportReviewSchema>;
