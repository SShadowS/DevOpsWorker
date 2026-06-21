import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { TestCaseReviewSchema, type TestCaseReview } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { azureDevOpsMcp, TOOL_SETS, MCP_TOOLS, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createTestCaseReviewerConfig(config: PipelineConfig): AgentConfig<typeof TestCaseReviewSchema> {
  return {
    name: 'test-case-reviewer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
    ],
    outputSchema: TestCaseReviewSchema,
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, ...MCP_TOOLS.zendeskReadOnly],
    disallowedTools: ['Bash'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;
      const testCases = state.testCases!;
      const repoKey = ctx.config.repoKey;
      const layout = ctx.config.layout;

      const testCaseList = testCases.testCases
        .map((tc) => `- #${tc.id} — "${tc.title}" (${tc.stepCount} steps, from: ${tc.derivedFrom})`)
        .join('\n');

      return [
        `## Task`,
        `Review the test cases created for work item #${ctx.workItemId}.`,
        `Validate coverage, step quality, and accuracy against the dev plan and implementation.`,
        ``,
        `### LSP Warm-Up (MANDATORY FIRST ACTION)`,
        `Before doing ANY other work, verify that the AL Language Server is functional:`,
        `1. Call \`ToolSearch\` with query "LSP" to load the LSP tool schema`,
        `2. Use \`Glob\` with pattern \`${repoKey}/${layout.source}/**/*.al\` to find an AL source file`,
        `3. Call \`LSP\` with operation \`documentSymbol\` on the first .al file found`,
        `4. Report: "LSP verified — [N] symbols found in [filename]" then proceed`,
        `5. If LSP fails, report the error and continue with text-based tools as fallback`,
        ``,
        `This step is non-negotiable. Skip it and your output will be rejected.`,
        `After this warm-up, use LSP for ALL subsequent AL code navigation.`,
        ``,
        `## Work Item`,
        `- **ID:** ${ctx.workItemId}`,
        `- **Title:** ${ctx.workItem.title}`,
        `- **Type:** ${ctx.workItemType}`,
        ``,
        `## Test Scenarios from Dev Plan`,
        ...devPlan.testScenarios.map((s, i) => `${i + 1}. ${s}`),
        ``,
        `## Objects Implemented`,
        ...devPlan.objects.map(o => `- ${o.action} ${o.objectType} "${o.objectName}": ${o.description}`),
        ``,
        `## Test Cases to Review`,
        testCaseList,
        ``,
        `## Files Changed`,
        `**Created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
        `**Modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
        ``,
        `## Review Criteria`,
        `1. **Coverage**: Every test scenario from the dev plan must have at least one test case. Flag missing coverage as critical.`,
        `2. **Step Quality**: Actions must be concrete and specific ("Open page X, set field Y to Z"), not vague ("Set up the document").`,
        `3. **Step Accuracy**: Steps must match the actual implementation. Read the code in the target extension repo to verify.`,
        `4. **Expected Results**: Must be observable and verifiable ("Field X displays 25.00"), not vague ("VAT is correct").`,
        `5. **Negative Cases**: Must include error/edge case test cases, not just happy paths.`,
        `6. **Titles**: Must follow "Verify [action] results in [outcome]" pattern.`,
        `7. **Duplicates**: Flag test cases that substantially overlap.`,
        ``,
        `## Instructions`,
        `1. Read each test case in ADO using \`get_work_item\` to see the full Steps XML`,
        `2. Read the implementation code in the target extension repo to verify step accuracy`,
        `3. Compare test case coverage against the dev plan test scenarios`,
        `4. Produce a TestCaseReview with your verdict`,
        ``,
        `Approve only if test cases are complete, accurate, and ready for a tester.`,
      ].join('\n');
    },
  };
}

export function testCaseReviewerStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createTestCaseReviewerConfig(config),
    canRun: (state) => state.testCases != null,
    applyOutput: (state, output: TestCaseReview) => ({
      ...state,
      testCaseReviews: [...(state.testCaseReviews ?? []), output],
    }),
  });
}
