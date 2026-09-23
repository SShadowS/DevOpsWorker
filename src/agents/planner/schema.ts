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
  manual: z.enum(['none', 'walkthrough', 'required']).describe(
    'Whether a person also runs this as a manual Test Case. none: automated test only (the default choice). ' +
    'walkthrough: automated, and also shown to a solution specialist so they learn what the feature does. ' +
    'required: automation cannot reach it, so only a person can check it; give manualReason.',
  ),
  manualReason: z.string().optional().describe('Why an automated test cannot check this. Required when manual is "required".'),
});

export const RiskAssessmentSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  factors: z.array(z.string()),
  mitigations: z.array(z.string()),
});

export const DeferredAcceptanceCriterionSchema = z.object({
  criterion: z.string().describe('The acceptance criterion being deferred, quoted or numbered as the work item states it'),
  reason: z.string().describe('The scope/product decision a human must make — why this cannot be settled by revising the plan'),
});

export const DevPlanSchema = z.object({
  summary: z.string().describe('High-level summary of the implementation approach'),
  objects: z.array(ALObjectChangeSchema).describe('AL objects to create or modify'),
  testScenarios: z.array(TestScenarioSchema),
  riskAssessment: RiskAssessmentSchema,
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']),
  dependencies: z.array(z.string()).describe('External dependencies or prerequisite changes'),
  // The formal exit from the include/exclude/self-authorize triple bind: an AC
  // whose inclusion is a scope decision gets deferred to the human at the
  // plan-approval checkpoint instead of being re-litigated every review round.
  // Work items 81098 and 81493 each burned planning rounds for lack of this.
  deferredAcceptanceCriteria: z.array(DeferredAcceptanceCriterionSchema).optional()
    .describe('ACs deliberately NOT implemented by this plan, pending a human scope decision at plan approval'),
  notes: z.string().optional().describe('Additional notes or considerations'),
});

export type DevPlan = z.infer<typeof DevPlanSchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;

/** One scenario as a single prompt line. */
export function formatScenario(s: TestScenario, i: number): string {
  const manual = s.manual === 'walkthrough' ? ' [manual: walkthrough]'
    : s.manual === 'required' ? ` [manual only: ${s.manualReason ?? 'no reason given'}]`
    : '';
  return `${i + 1}. **${s.name}**${manual} — ${s.description} Expected: ${s.expectedOutcome} (from ${s.derivedFrom})`;
}

/**
 * The scenarios the plan marks for a manual Test Case. `null` for a plan made before
 * scenarios carried `manual`: it marks nothing, so every scenario is a candidate and
 * the test-cases agent selects on its own.
 */
export function manualScenarios(plan: DevPlan): TestScenario[] | null {
  if (plan.testScenarios.every((s) => s.manual === undefined)) return null;
  return plan.testScenarios.filter((s) => s.manual === 'walkthrough' || s.manual === 'required');
}

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
