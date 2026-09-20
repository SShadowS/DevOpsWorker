import { z } from 'zod';

/**
 * The sub-agent roster, and the only names a finding may be attributed to.
 *
 * A closed list rather than free text: "security agent" one run and the exact
 * name the next cannot be counted together, and attribution that cannot be
 * counted is not attribution. `AGENT_TRIGGERS` in `review-pr.ts` is typed
 * against this, so adding an agent there without adding it here fails the
 * build rather than producing findings nothing can attribute.
 */
export const PR_SUB_AGENTS = [
  'code-review-validator',
  'code-quality-assessor',
  'al-performance-analyzer',
  'al-error-pattern-analyzer',
  'al-integration-analyzer',
  'al-architecture-analyzer',
  'security-edge-case-analyzer',
] as const;

export type PrSubAgent = typeof PR_SUB_AGENTS[number];

export const PRFindingSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor', 'nitpick']),
  title: z.string().describe('Short finding title — also the basis of its identity across re-reviews, so keep it stable between runs'),
  file: z.string().optional().describe('Repo-relative path of the file the finding concerns. Omit when the finding has no single location.'),
  line: z.number().optional().describe('Line number on the RIGHT (source-branch) side of the diff. Omit unless it is a real line in a changed file.'),
  location: z.string().optional().describe('Name of the enclosing procedure, trigger, or method the finding sits in — e.g. OnAfterValidateEvent, PostDocument. Omit when the finding is not inside one.'),
  replacesText: z.string().optional().describe('The EXACT current text of the lines your fix replaces, starting at `line`, copied character for character from the file including indentation. Only supply this together with suggestedFix. If it does not match the file exactly the suggestion is silently dropped, so copy rather than retype.'),
  suggestedFix: z.string().optional().describe('The complete replacement for those lines, as whole lines with correct indentation. Offer this only for a small mechanical fix you are certain of — a wrong operator, a missing not, a typo. Omit it for anything structural. The author applies it with one click and may not re-read it.'),
  body: z.string().describe('The finding explanation in markdown, same prose as the summary comment'),
  // Deliberately NOT required, and deliberately forgiving of a bad value.
  // A validation error is not retried (`isRetryable` in run-agent.ts), so a
  // required field the orchestrator omits would throw away a finished review
  // worth several dollars at the moment it reports. `.catch([])` means a name
  // outside the roster costs this finding's attribution and nothing else.
  //
  // Absent attribution therefore shows up as an empty array rather than a
  // missing field — countable, and reported per review, which is the point:
  // `observedCherryPick` is optional and the orchestrator simply omitted it on
  // 31 of the last 100 reviews, with nothing to say so.
  foundBy: z.array(z.enum(PR_SUB_AGENTS)).default([]).catch([]).describe('Which sub-agents found this. One name for a finding from a single agent; EVERY contributing agent when you merged duplicates from several. Use the exact agent names.'),
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
