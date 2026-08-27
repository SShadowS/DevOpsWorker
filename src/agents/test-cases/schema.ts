import { z } from 'zod';

// ---------------------------------------------------------------------------
// TestCasesOutput — output of the Test Cases Agent
// ---------------------------------------------------------------------------

export const TestCaseEntrySchema = z.object({
  id: z.number().describe('ADO Test Case work item ID'),
  title: z.string().describe('Descriptive test case title'),
  stepCount: z.number().describe('Number of test steps'),
  derivedFrom: z.string().describe('Which test scenario or acceptance criterion this derives from'),
});

export const TestCasesOutputSchema = z.object({
  testCases: z.array(TestCaseEntrySchema).describe('Created test case work items'),
  summary: z
    .string()
    .describe(
      'What a technical writer or solution specialist should know about this change, and what the test cases ask them to check',
    ),
  leftToAutomatedTests: z
    .array(z.string())
    .default([])
    .describe(
      'Behaviour you considered and deliberately did NOT write a test case for, because the automated tests already check it. Name the behaviour and the test that covers it. Without this, a short list of test cases and a lazy run look the same.',
    ),
});

export type TestCaseEntry = z.infer<typeof TestCaseEntrySchema>;
export type TestCasesOutput = z.infer<typeof TestCasesOutputSchema>;

// ---------------------------------------------------------------------------
// PipelineState slice — the Test-Cases agent OWNS `state.testCases`.
// Module augmentation registers the field on core's PipelineStateSlices so
// core never has to import this schema. See src/types/pipeline.types.ts.
// ---------------------------------------------------------------------------
declare module '../../types/pipeline.types.ts' {
  interface PipelineStateSlices {
    testCases?: TestCasesOutput;
  }
}
