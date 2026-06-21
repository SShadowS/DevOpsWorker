import { z } from 'zod';

// ---------------------------------------------------------------------------
// WorkItemUpdate — output of the Documentation Agent
// ---------------------------------------------------------------------------

export const FieldUpdateSchema = z.object({
  fieldPath: z.string().describe('DevOps field path (e.g. "Custom.ReleaseNotes")'),
  value: z.string(),
});

export const WorkItemUpdateSchema = z.object({
  releaseNotes: z.string().describe('Customer-facing release notes (action word + benefit)'),
  description: z.string().describe("HTML-formatted description using the project's template"),
  fieldUpdates: z.array(FieldUpdateSchema).describe('Additional field updates'),
  summaryComment: z.string().describe('Markdown comment to post on the work item'),
  changesSummary: z.string().describe('Technical summary of changes made'),
  decisionsAndTradeoffs: z.array(z.string()).describe('Key decisions and trade-offs from the process'),
});

export type WorkItemUpdate = z.infer<typeof WorkItemUpdateSchema>;
