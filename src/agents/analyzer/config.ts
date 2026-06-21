import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { ReadinessReportSchema, type ReadinessReport } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { PipelineError } from '../../sdk/errors.ts';
import { azureDevOpsMcp, TOOL_SETS, MCP_TOOLS, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Analyzer Agent — Gatekeeper that evaluates work item readiness
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createAnalyzerConfig(config: PipelineConfig): AgentConfig<typeof ReadinessReportSchema> {
  return {
    name: 'analyzer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'repo-structure.md',
      'code-search.md',
      'al-investigation.md',
      'work-item-fields.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
    ],
    outputSchema: ReadinessReportSchema,
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, ...MCP_TOOLS.zendeskReadOnly, ...MCP_TOOLS.pipelinesReadOnly],
    disallowedTools: ['Bash'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const repoKey = ctx.config.repoKey;
      const layout = ctx.config.layout;

      return [
        `## Task`,
        `Analyze work item #${ctx.workItemId} for readiness to proceed through the development pipeline.`,
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
        `- **ID:** ${ctx.workItem.id}`,
        `- **Title:** ${ctx.workItem.title}`,
        `- **Type:** ${ctx.workItem.type}`,
        `- **State:** ${ctx.workItem.state}`,
        `- **Description:** ${ctx.workItem.description ?? '(none)'}`,
        `- **Acceptance Criteria:** ${ctx.workItem.acceptanceCriteria ?? '(none)'}`,
        `- **Tags:** ${ctx.workItem.tags?.join(', ') ?? '(none)'}`,
        ``,
        `## Instructions`,
        `1. Read the work item details above carefully`,
        `2. If the description references a pipeline build URL (buildId=NNN), fetch that build's logs using pipeline_timeline + get_pipeline_log to understand the actual compiler warnings or errors`,
        `3. Search the codebase for relevant context (use local tools, not DevOps code search)`,
        `4. Check for linked/related work items via Azure DevOps MCP`,
        `5. Attempt to resolve any gaps yourself before flagging them`,
        `6. Produce a ReadinessReport with your verdict and enriched context`,
      ].join('\n');
    },
  };
}

export function analyzerStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createAnalyzerConfig(config),
    canRun: () => true, // Analyzer is always the first stage
    applyOutput: (state, output: ReadinessReport) => {
      const unresolvedGaps = output.gaps
        .filter(g => !g.resolvedByAgent && g.severity !== 'nice-to-have');

      // Safety net: if the agent says "proceed" but listed unresolved
      // blocking/needs-clarification gaps, treat it as needs-input.
      if (output.verdict === 'needs-input' || unresolvedGaps.length > 0) {
        const formatted = unresolvedGaps
          .map(g => `- **${g.field}**: ${g.question}`)
          .join('\n');
        const message = formatted
          ? `Analyzer needs human input before proceeding:\n\n${formatted}`
          : 'Analyzer flagged needs-input but no specific gaps were listed.';
        throw new PipelineError('needs-input', 'analyzer', message);
      }
      return {
        ...state,
        readiness: output,
      };
    },
  });
}
