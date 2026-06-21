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
  summary: z.string().describe('Summary of test coverage created'),
});

export type TestCaseEntry = z.infer<typeof TestCaseEntrySchema>;
export type TestCasesOutput = z.infer<typeof TestCasesOutputSchema>;
