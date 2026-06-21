import { z } from 'zod';

// ---------------------------------------------------------------------------
// ProposedRules — output of the Rule Learner Agent
// ---------------------------------------------------------------------------

export const ProposedRuleSchema = z.object({
  title: z.string().describe('Short descriptive name for the rule'),
  categories: z.array(z.string()).describe('Category tags for routing to subagents (e.g. page-design, page-security)'),
  rationale: z.string().describe('Why this pattern matters — the business or technical impact'),
  badExample: z.string().describe('AL code showing the anti-pattern'),
  goodExample: z.string().describe('AL code showing the correct approach'),
  confidence: z.enum(['high', 'medium']).describe('How generalizable this pattern is'),
  sourceComment: z.string().describe('Original review comment text that inspired this rule'),
});

export const ContradictionSchema = z.object({
  existingRule: z.string().describe('Title of the existing rule that is contradicted'),
  comment: z.string().describe('The review comment that contradicts the rule'),
  explanation: z.string().describe('How the comment contradicts the existing rule'),
});

export const ProposedRulesSchema = z.object({
  proposedRules: z.array(ProposedRuleSchema).describe('New rules to add (medium or high confidence only)'),
  contradictions: z.array(ContradictionSchema).describe('Comments that contradict existing rules'),
  alreadyCovered: z.array(z.string()).describe('Comment excerpts already covered by existing rules'),
  summary: z.string().describe('Brief summary of the analysis'),
});

export type ProposedRules = z.infer<typeof ProposedRulesSchema>;
export type ProposedRule = z.infer<typeof ProposedRuleSchema>;
