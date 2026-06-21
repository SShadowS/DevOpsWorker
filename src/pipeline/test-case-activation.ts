import type { Stage, PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import { updateWorkItemFields, postPRComment } from '../sdk/azure-devops-client.ts';

/**
 * Non-agent stage that activates all test cases by setting their
 * System.State to "Ready". Runs after the pr-published checkpoint
 * so test cases are only made available once the PR is approved.
 */
export function testCaseActivation(): Stage {
  return {
    name: 'test-case-activation',

    canRun(state: PipelineState): boolean {
      return state.testCases != null && state.testCases.testCases.length > 0;
    },

    async execute(state: PipelineState, context: PipelineContext): Promise<PipelineState> {
      const testCases = state.testCases!;

      // Setting System.State to Ready is idempotent — safe to retry all on failure.
      // If one call fails, the orchestrator persists state and `pipeline continue`
      // re-runs the entire stage, re-setting already-Ready test cases (a no-op).
      for (const tc of testCases.testCases) {
        await updateWorkItemFields(tc.id, { 'System.State': 'Ready' }, context.config);
        console.log(`[test-case-activation] Set test case #${tc.id} to Ready`);
      }

      // Advertise /fix-test command on the PR
      const prId = state.draftPR?.id;
      if (prId) {
        const count = testCases.testCases.length;
        const comment = `**Test cases activated** — ${count} test case${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} now Ready for testing.\n\nIf test cases fail, post \`/fix-test\` on this PR to trigger an automated fix iteration.`;
        try {
          await postPRComment(prId, comment, context.config);
          console.log(`[test-case-activation] Posted /fix-test advertisement on PR #${prId}`);
        } catch (err) {
          console.log(`[test-case-activation] Warning: failed to post PR comment: ${err}`);
        }
      }

      state.testCaseActivation = { activatedAt: new Date().toISOString() };

      return state;
    },
  };
}
