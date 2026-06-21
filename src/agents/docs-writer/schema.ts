import { z } from 'zod';

// ---------------------------------------------------------------------------
// DocsWriterOutput — output of the Docs Writer Agent
// ---------------------------------------------------------------------------

export const DocsDraftSchema = z.object({
  filePath: z.string().describe('Relative path mirroring docs repo structure (e.g. "Business functionality/Email/New feature.md")'),
  action: z.enum(['create', 'update']).describe('Whether this is a new page or an update to an existing one'),
  existingPageId: z.string().optional().describe('DO-NNN if updating an existing page'),
  title: z.string().describe('Page title'),
  summary: z.string().describe('Brief description of what this draft covers'),
});

export const DocsWriterOutputSchema = z.object({
  drafts: z.array(DocsDraftSchema).describe('Files created in docs-drafts/'),
  analysisNotes: z.string().describe('What docs changes are needed and why'),
  existingPagesReviewed: z.array(z.string()).describe('Pages examined for relevance (by title or ID)'),
  noDocsNeeded: z.boolean().describe('True if the change does not warrant documentation updates'),
  rationale: z.string().describe('Why docs were or were not created'),
});

export type DocsDraft = z.infer<typeof DocsDraftSchema>;
export type DocsWriterOutput = z.infer<typeof DocsWriterOutputSchema>;
