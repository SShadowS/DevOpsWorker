import { z } from 'zod';

export const PRFindingSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor', 'nitpick']),
  title: z.string().describe('Short finding title — also the basis of its identity across re-reviews, so keep it stable between runs'),
  file: z.string().optional().describe('Repo-relative path of the file the finding concerns. Omit when the finding has no single location.'),
  line: z.number().optional().describe('Line number on the RIGHT (source-branch) side of the diff. Omit unless it is a real line in a changed file.'),
  location: z.string().optional().describe('Name of the enclosing procedure, trigger, or method the finding sits in — e.g. OnAfterValidateEvent, PostDocument. Omit when the finding is not inside one.'),
  body: z.string().describe('The finding explanation in markdown, same prose as the summary comment'),
});

export type PRFinding = z.infer<typeof PRFindingSchema>;

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
  findingsList: z.array(PRFindingSchema).default([]).describe('Every finding as a structured record. The `findings` counters above must agree with these severities.'),
  reviewBody: z.string().describe('The full synthesized review in markdown — the same content posted as the PR comment. Always populate this, even in replay mode.'),
  observedCherryPick: z.boolean().optional().describe('True if, while reading this PR, you concluded it ports a change made earlier on another branch — a cherry-pick or backport. Answer from what you actually saw (commit trailers, the title, the description, an identical change already on another branch), not from whether the prompt told you so. Omit if you did not consider the question.'),
  // .int() is load-bearing: the column is INTEGER, and a fractional value would throw on
  // INSERT inside the save that also carries the cost, findings and telemetry — losing a
  // whole review row over one optional field.
  observedCherryPickSource: z.number().int().optional().describe('The pull request number this change was ported FROM, if you identified one. Omit unless you are confident — a wrong number is worse than none. Never guess from a version number in the title: "[Cherry-pick 25]" means the 25.x branch, not PR 25.'),
});

export type PRReviewResult = z.infer<typeof PRReviewSchema>;
