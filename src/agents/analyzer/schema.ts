import { z } from 'zod';

// ---------------------------------------------------------------------------
// ReadinessReport — output of the Analyzer Agent
// ---------------------------------------------------------------------------

export const GapSchema = z.object({
  field: z.string().describe('What is missing or unclear'),
  severity: z.enum(['blocking', 'needs-clarification', 'nice-to-have']),
  question: z.string().describe('Question to ask the human to resolve this gap'),
  resolvedByAgent: z.boolean().describe('Whether the agent was able to resolve this gap itself'),
  resolution: z.string().optional().describe('How the agent resolved the gap (if it did)'),
});

export const EnrichedContextSchema = z.object({
  title: z.string(),
  type: z.enum(['Bug', 'User Story']),
  description: z.string(),
  acceptanceCriteria: z.string(),
  targetArea: z.string().describe('Which area of the codebase this affects'),
  relatedWorkItems: z.array(z.object({
    id: z.number(),
    title: z.string(),
    relationship: z.string(),
  })).describe('Linked or related work items discovered'),
  codebaseInsights: z.array(z.string()).describe('Key findings from codebase search'),
});

export const ReadinessReportSchema = z.object({
  verdict: z.enum(['proceed', 'needs-input', 'reject']),
  enrichedContext: EnrichedContextSchema,
  gaps: z.array(GapSchema),
  summary: z.string().describe('Brief summary of the readiness assessment'),
});

export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

// ---------------------------------------------------------------------------
// PipelineState slice — the Analyzer OWNS `state.readiness`.
// Module augmentation registers the field on core's PipelineStateSlices so
// core never has to import this schema. See src/types/pipeline.types.ts.
// ---------------------------------------------------------------------------
declare module '../../types/pipeline.types.ts' {
  interface PipelineStateSlices {
    readiness?: ReadinessReport;
  }
}
