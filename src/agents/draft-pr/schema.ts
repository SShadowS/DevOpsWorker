import { z } from 'zod';

// ---------------------------------------------------------------------------
// DraftPullRequest — output of the Draft PR Agent
// ---------------------------------------------------------------------------

export const DraftPullRequestSchema = z.object({
  id: z.number().describe('Azure DevOps PR ID'),
  url: z.string().describe('URL to the PR in Azure DevOps'),
  isDraft: z.boolean().describe('Should always be true when created'),
  sourceBranch: z.string(),
  targetBranch: z.string().describe('Always "master"'),
  title: z.string(),
  description: z.string().describe('PR description markdown'),
  linkedWorkItemId: z.number(),
});

export type DraftPullRequest = z.infer<typeof DraftPullRequestSchema>;
