import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { PlanReviewSchema, type PlanReview } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { azureDevOpsMcp, TOOL_SETS, TOOLS, MCP_TOOLS, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Plan Review Agent — senior reviewer challenging the dev plan
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

function createPlanReviewerConfig(config: PipelineConfig): AgentConfig<typeof PlanReviewSchema> {
  return {
    name: 'plan-reviewer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'repo-structure.md',
      'code-search.md',
      'al-investigation.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
      'tdd.md',
    ],
    outputSchema: PlanReviewSchema,
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, TOOLS.Task, ...MCP_TOOLS.zendeskReadOnly],
    disallowedTools: ['Bash'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.targetRepo,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const readiness = state.readiness!;
      const devPlan = state.devPlan!;
      const layout = ctx.config.layout;
      const priorReviews = (state.planReviews ?? []).slice(-2).map((r) => ({
        verdict: r.verdict,
        domainAnalyses: (r as { domainAnalyses?: unknown }).domainAnalyses,
      }));

      return [
        `## Task`,
        `You are the plan-reviewer orchestrator for work item #${ctx.workItemId}. Follow the orchestrator pattern in CLAUDE.md — spawn the 4 subagents in parallel and synthesize their findings.`,
        ``,
        `## Step 0 — LSP Warm-Up (MANDATORY FIRST ACTION)`,
        `Before doing ANY other work, verify that the AL Language Server is functional:`,
        `1. Call \`ToolSearch\` with query "LSP" to load the LSP tool schema`,
        `2. Use \`Glob\` with pattern \`${layout.source}/**/*.al\` to find an AL source file`,
        `3. Call \`LSP\` with operation \`documentSymbol\` on the first .al file found`,
        `4. Report: "LSP verified — [N] symbols found in [filename]" then proceed`,
        `5. If LSP fails, report the error and continue with text-based tools as fallback`,
        ``,
        `This step is non-negotiable. Skip it and your output will be rejected.`,
        `After this warm-up, use LSP for ALL subsequent AL code navigation (see .claude/rules/USE-AL-LSP-TOOLS.md).`,
        ``,
        `## Original Work Item Context`,
        `- **Title:** ${readiness.enrichedContext.title}`,
        `- **Type:** ${readiness.enrichedContext.type}`,
        `- **Acceptance Criteria:** ${readiness.enrichedContext.acceptanceCriteria}`,
        ``,
        `## Development Plan to Review`,
        `${JSON.stringify(devPlan, null, 2)}`,
        ``,
        `## Prior Review History (for circuit-breaker evaluation)`,
        priorReviews.length
          ? `${JSON.stringify(priorReviews, null, 2)}`
          : `(none — this is the first iteration; devils-advocate mode defaults to blocking)`,
        ``,
        `Proceed per the orchestrator procedure in your CLAUDE.md: circuit-breaker check, parallel subagent spawn, synthesis into PlanReview.`,
      ].join('\n');
    },
  };
}

export function planReviewerStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createPlanReviewerConfig(config),
    canRun: (state) => state.devPlan != null,
    applyOutput: (state, output: PlanReview) => ({
      ...state,
      planReviews: [...(state.planReviews ?? []), output],
    }),
  });
}
