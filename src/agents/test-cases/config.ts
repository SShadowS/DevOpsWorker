import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig, McpServerConfig } from '../../types/agent.types.ts';
import { TestCasesOutputSchema, type TestCasesOutput } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { buildHumanFeedbackSection } from '../../pipeline/human-feedback.ts';
import { azureDevOpsMcp, TOOL_SETS, MCP_TOOLS, resolveAlLspPlugin, bcMcp, BC_MCP_TOOLS } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Test Cases Agent — creates ADO Test Case work items with structured steps
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createTestCasesConfig(config: PipelineConfig): AgentConfig<typeof TestCasesOutputSchema> {
  return {
    name: 'test-cases',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'ado-reference-syntax.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
    ],
    outputSchema: TestCasesOutputSchema,
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, ...MCP_TOOLS.zendeskReadOnly, ...BC_MCP_TOOLS],
    // Produces test cases as structured output, never as files.
    //
    // `Bash` is deliberately NOT denied, unlike its sibling test-case-reviewer:
    // this agent's recorded runs made 15 Bash calls and every one was read-only
    // navigation (`grep`, `find`, `git log`). Denying it would remove a capability
    // that is demonstrably in use, to no benefit the mutating denials don't give.
    // `REPL`: a potential bypass of the mutation denials, sandbox unestablished,
    // zero recorded usage — denied because it is free, not because it is proven.
    disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'REPL'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: (state: PipelineState) => {
      const servers: Record<string, McpServerConfig> = {
        azureDevOps: azureDevOpsMcp(config),
      };
      if (state.environment) {
        const bc = bcMcp(state.environment);
        if (bc) servers['business-central'] = bc;
      }
      return servers;
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;

      // If test cases already exist, switch to revision mode
      if (state.testCases) {
        const existingIds = state.testCases.testCases
          .map((tc) => `#${tc.id} — ${tc.title}`)
          .join('\n');

        const lastReview = state.testCaseReviews?.at(-1);
        // A `/fix` that lands here is a human answering THIS loop, and the loop's
        // resetState has already cleared the reviews — so "no review" no longer
        // implies the code was patched. Saying it did would send the agent looking
        // for code changes nobody made.
        const revisionSource = lastReview
          ? `The test case reviewer requested changes.`
          : state.humanFeedback
            ? `A human answered the test case reviewer — their reply is below.`
            : `The implementation was patched after a /fix request.`;
        const revisionInstructions = lastReview && 'revisionInstructions' in lastReview && lastReview.revisionInstructions
          ? `\n\n## Reviewer Feedback\n${lastReview.revisionInstructions}`
          : '';

        return [
          `## Task`,
          `Review and revise the existing test cases for work item #${ctx.workItemId}.`,
          revisionSource,
          // Ahead of the reviewer's own instructions: where both are present the
          // human's decision is what settles the disagreement.
          ...buildHumanFeedbackSection(state),
          ``,
          `## Existing Test Cases (as last reported — may be INCOMPLETE)`,
          existingIds,
          ``,
          // The list above is only what the previous round REPORTED, and a round that
          // consolidates or replaces cases under-reports by construction — one run left
          // 20 superseded cases linked in ADO while reporting 5. The ADO links are the
          // ground truth; reconcile against them, not against this list.
          `Before changing anything, call \`get_work_item\` for #${ctx.workItemId} with relations`,
          `and list every linked Test Case ("Tested By"). That set is the real current suite.`,
          `Reconcile it against the plan's scenarios: UPDATE cases that need changes, CREATE`,
          `only what is genuinely missing, and for every case the revised suite supersedes,`,
          `set its state to "Closed" and remove its link from #${ctx.workItemId}`,
          `(\`manage_work_item_link\` with operation "remove"). A superseded case left linked`,
          `becomes a duplicate QA has to puzzle over.`,
          ``,
          `## Files Changed`,
          `**Created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
          `**Modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
          revisionInstructions,
          ``,
          `## Instructions`,
          `1. Read the code changes to understand the current implementation`,
          `2. Address the reviewer's feedback by updating, adding, or removing test cases as needed`,
          `3. Use \`update_work_item\` to modify existing test cases`,
          `4. Use \`create_work_item\` only if new test cases are needed`,
          `5. Do NOT create duplicate test cases`,
        ].join('\n');
      }

      return [
        `## Task`,
        `Create manual Test Case work items in Azure DevOps for work item #${ctx.workItemId}.`,
        ...buildHumanFeedbackSection(state),
        ``,
        `## Work Item`,
        `- **ID:** ${ctx.workItemId}`,
        `- **Title:** ${ctx.workItem.title}`,
        `- **Type:** ${ctx.workItemType}`,
        `- **Area Path:** ${config.azureDevOps.areaPath}`,
        `- **Iteration Path:** ${config.azureDevOps.iterationPath}`,
        ``,
        `## Test Scenarios from Dev Plan`,
        ...devPlan.testScenarios.map((s, i) => `${i + 1}. ${s}`),
        ``,
        `## Objects Implemented`,
        ...devPlan.objects.map(o => `- ${o.action} ${o.objectType} "${o.objectName}": ${o.description}`),
        ``,
        `## Files Changed`,
        `**Created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
        `**Modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
        ``,
        `## Instructions`,
        `1. Read the code in the target extension repo to understand the implementation details`,
        `2. For each test scenario, create a Test Case work item using MCP \`create_work_item\`:`,
        `   - \`workItemType\`: "Test Case"`,
        `   - \`title\`: Descriptive name — "Verify [action] results in [outcome]"`,
        `   - Set \`areaPath\`: ${config.azureDevOps.areaPath}`,
        `   - Set \`iterationPath\`: ${config.azureDevOps.iterationPath}`,
        `   - Set \`Microsoft.VSTS.TCM.Steps\` in additionalFields with Steps XML`,
        `3. Link each test case to parent work item #${ctx.workItemId} using \`manage_work_item_link\`:`,
        `   - Relation type: \`Microsoft.VSTS.Common.TestedBy-Forward\``,
        `   - This creates a "Tested By" link from the parent to the test case`,
        `4. Include both positive (happy path) and negative (error/edge) test cases`,
        `5. Report the created test case IDs, titles, step counts, and which scenario each derives from`,
      ].join('\n');
    },
  };
}

export function testCasesStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createTestCasesConfig(config),
    canRun: (state) => state.changeset != null,
    applyOutput: (state, output: TestCasesOutput) => ({
      ...state,
      testCases: output,
    }),
  });
}
