// scripts/pr-review-eval/judge.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Grade, PooledFinding } from './pool.ts';

/**
 * The grade offered to the judge, and the invariant this module exists to
 * uphold: "unverifiable" must be a REAL, reachable answer, not a comment.
 *
 * Every one of the existing dataset's `mustNotRaise` anchors is a finding
 * whose falseness lives OUTSIDE the diff — a callee committing several
 * frames down, an `OnValidate` cascade, `Codeunit.Run`-with-TableNo
 * auto-commit semantics. A judge graded from the diff alone and forced to
 * choose only among real-bug/nit/false-positive has no honest answer for
 * those; it is coerced into guessing "real-bug", and the guess reads back as
 * confident data. Offering "unverifiable" explicitly — and telling the model
 * it is the CORRECT answer in that situation, not a cop-out — is what keeps
 * the scoring honest instead of merely looking decisive.
 */
export const POOL_JUDGE_SYSTEM_PROMPT = `You grade one code-review finding against the PR diff it refers to.

Answer with exactly one grade:
- "real-bug": a defect that would cause incorrect behaviour, data loss, a security exposure, or a real performance problem in production.
- "nit": accurate but cosmetic — naming, formatting, style, a micro-optimisation with no measurable effect.
- "false-positive": the finding is wrong. The code does not do what it claims, or the concern is already handled elsewhere (for example a callee that already commits, or a guard further up the call chain).
- "unverifiable": the diff alone cannot settle the claim — for example the claim depends on a callee's body, an event subscriber, or a caller several frames away that is not present in this diff. This is the CORRECT answer whenever you cannot see enough to be sure. Do not guess "real-bug" or "false-positive" to avoid answering "unverifiable" — a wrong guess is worse than an honest "unverifiable".

Judge only this finding, and only from the diff given below. Do not consider who raised it, how many reviewers raised it, or assume behaviour of code that is not shown in the diff.`;

const JudgeResponseSchema = z.object({
  grade: z.enum(['real-bug', 'nit', 'false-positive', 'unverifiable']),
  why: z.string().describe('One sentence explaining the grade.'),
});

/** The subset of a pooled finding the judge needs to identify and locate the claim. */
export type JudgeInput = Pick<PooledFinding, 'title' | 'file' | 'location' | 'line'>;

/**
 * Build the judge's user prompt. Split out from `judgePooledFinding` so the
 * formatting — in particular the `location`/`line` fallback display — is
 * testable without a live SDK call.
 *
 * `evidence` is the PR's DIFF, fetched ONCE per PR by the caller and reused
 * for every finding on that PR (see `fetchPRDiff` / `diffCommits` in
 * `src/sdk/ado/pull-requests.ts` and `src/sdk/git-diff.ts` — that mechanism
 * already exists in the core; this module does not re-fetch it), NOT the
 * full file at the finding's location. Grading against full file bodies
 * would need a clone plus per-file retrieval this eval has no use for
 * otherwise. The diff is what every arm's reviewers were themselves given as
 * the primary artefact, so grading from it judges the same evidence the
 * reviewers had — at the cost that a finding whose truth depends on a callee
 * outside the diff cannot be settled, which is exactly why "unverifiable"
 * exists as a real answer above.
 */
export function buildJudgePrompt(finding: JudgeInput, evidence: string): string {
  const locationText = finding.location
    ? finding.location
    : finding.line != null
      ? `line ${finding.line}`
      : '(no location given)';

  return [
    '## Finding',
    `File: ${finding.file || '(no file given)'}`,
    `Location: ${locationText}`,
    `Claim: ${finding.title}`,
    '',
    '## PR diff',
    evidence,
  ].join('\n');
}

/**
 * JSON Schema for the judge's structured output, derived from
 * `JudgeResponseSchema`. `$schema` is stripped before being handed to the
 * SDK's `outputFormat` — same reason `run-agent.ts` strips it: the SDK
 * rejects a schema carrying that key (see the Zod 4 upgrade notes).
 */
function judgeOutputSchema(): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(JudgeResponseSchema) as Record<string, unknown>;
  return rest;
}

/**
 * Grade one pooled finding against the PR diff it refers to.
 *
 * Structured output (`outputFormat: json_schema`), not text-scraping for a
 * `{...}` substring — the grade this function returns feeds a scoring
 * decision on an experiment that costs real money to rerun, so a
 * mis-extracted brace pair failing silently is not an acceptable risk here.
 *
 * `maxTurns: 1` and `allowedTools: []`: this is a single graded judgement
 * from the evidence already in the prompt, not an agentic task — the judge
 * has nothing to read that was not already handed to it.
 *
 * Throws if the query stream ends without ever producing a successful,
 * schema-valid result (no silent "assume real-bug" fallback).
 */
export async function judgePooledFinding(
  finding: JudgeInput,
  evidence: string,
): Promise<{ grade: Grade; why: string }> {
  const prompt = buildJudgePrompt(finding, evidence);

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: POOL_JUDGE_SYSTEM_PROMPT,
      outputFormat: { type: 'json_schema', schema: judgeOutputSchema() },
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === 'result' && message.subtype === 'success' && message.structured_output != null) {
      return JudgeResponseSchema.parse(message.structured_output);
    }
  }

  const where = finding.location || (finding.line != null ? `line ${finding.line}` : '(unlocated)');
  throw new Error(`judgePooledFinding: no graded result for ${finding.file}::${where}`);
}
