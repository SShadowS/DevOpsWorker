import { z } from 'zod';

// ---------------------------------------------------------------------------
// DevPlan — output of the Planning Agent
// ---------------------------------------------------------------------------

export const ALObjectChangeSchema = z.object({
  objectType: z.enum([
    'table', 'tableextension', 'page', 'pageextension',
    'codeunit', 'report', 'reportextension', 'enum',
    'enumextension', 'xmlport', 'query', 'permissionset',
    'permissionsetextension', 'profile', 'interface',
  ]),
  objectId: z.number().optional().describe('Existing object ID, or null for new objects'),
  objectName: z.string(),
  action: z.enum(['create', 'modify']),
  description: z.string().describe('What changes are needed and why'),
  filePath: z.string().describe('Expected file path relative to the target extension repo root'),
});

export const TestScenarioSchema = z.object({
  name: z.string(),
  description: z.string(),
  expectedOutcome: z.string(),
  derivedFrom: z.string().describe('Which acceptance criterion this tests'),
});

export const RiskAssessmentSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  factors: z.array(z.string()),
  mitigations: z.array(z.string()),
});

export const DevPlanSchema = z.object({
  summary: z.string().describe('High-level summary of the implementation approach'),
  objects: z.array(ALObjectChangeSchema).describe('AL objects to create or modify'),
  testScenarios: z.array(TestScenarioSchema),
  riskAssessment: RiskAssessmentSchema,
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']),
  dependencies: z.array(z.string()).describe('External dependencies or prerequisite changes'),
  notes: z.string().optional().describe('Additional notes or considerations'),
});

export type DevPlan = z.infer<typeof DevPlanSchema>;

// ---------------------------------------------------------------------------
// PipelineState slice — the Planner OWNS `state.devPlan`.
// Module augmentation registers the field on core's PipelineStateSlices so
// core never has to import this schema. See src/types/pipeline.types.ts.
// ---------------------------------------------------------------------------
declare module '../../types/pipeline.types.ts' {
  interface PipelineStateSlices {
    devPlan?: DevPlan;
  }
}
