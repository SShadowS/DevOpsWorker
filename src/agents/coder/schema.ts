import { z } from 'zod';

// ---------------------------------------------------------------------------
// Changeset — output of the Coding Agent
// ---------------------------------------------------------------------------

export const FailedTestSchema = z.object({
  testName: z.string(),
  codeunitName: z.string(),
  errorMessage: z.string(),
  stackTrace: z.string().optional(),
});

export const ChangesetSchema = z.object({
  branchName: z.string(),
  branchUrl: z.string(),
  filesCreated: z.array(z.string()).describe('Relative paths of new files'),
  filesModified: z.array(z.string()).describe('Relative paths of modified files'),
  commitHash: z.string().optional(),
  commitMessage: z.string(),
  ciRunId: z.number().optional(),
  ciResult: z.enum(['passed', 'failed', 'not-run']).optional(),
  compilationErrors: z.array(z.string()).optional(),
  failedTests: z.array(FailedTestSchema).optional(),
  envPublished: z.boolean().optional().describe(
    'True ONLY if you deployed to the BC test environment and published your branch ' +
    'successfully this iteration (compiled AND published — not just compiled). ' +
    'False/undefined if publish failed or the env was unavailable. This is an APPROVAL ' +
    'CONDITION: the coding stage cannot complete until the change publishes to a real env.',
  ),
  envTestsPassed: z.boolean().optional().describe(
    'True ONLY if you ran the env tests on the BC test environment for the relevant test ' +
    'codeunits and they ALL passed this iteration. False/undefined if any test ' +
    'failed or you did not run tests. This is an APPROVAL CONDITION alongside envPublished.',
  ),
  wizardActivated: z.boolean().optional().describe(
    'True if you ran the BC setup wizard during this iteration (sets state.environment.activated). ' +
    'Set to true when you successfully drove the wizard to completion or confirmed already-complete. ' +
    'Leave undefined / false if you did not run the wizard or it failed.',
  ),
  summary: z.string().describe('Brief summary of what was implemented'),
});

export type Changeset = z.infer<typeof ChangesetSchema>;
