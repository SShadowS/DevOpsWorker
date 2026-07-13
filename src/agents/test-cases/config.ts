import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig, McpServerConfig } from '../../types/agent.types.ts';
import { TestCasesOutputSchema, type TestCasesOutput } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
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
        const revisionSource = lastReview
          ? `The test case reviewer requested changes.`
          : `The implementation was patched after a /fix request.`;
        const revisionInstructions = lastReview && 'revisionInstructions' in lastReview && lastReview.revisionInstructions
          ? `\n\n## Reviewer Feedback\n${lastReview.revisionInstructions}`
          : '';

        return [
          `## Task`,
          `Review and revise the existing test cases for work item #${ctx.workItemId}.`,
          revisionSource,
          ``,
          `## Existing Test Cases`,
          existingIds,
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
