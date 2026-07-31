import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { WorkItemUpdateSchema, type WorkItemUpdate } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { azureDevOpsMcp, TOOL_SETS, MCP_TOOLS } from '../../sdk/mcp-configs.ts';

// ---------------------------------------------------------------------------
// Documentation Agent — updates DevOps work item with a complete record
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createDocumenterConfig(config: PipelineConfig): AgentConfig<typeof WorkItemUpdateSchema> {
  return {
    name: 'documenter',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'ado-reference-syntax.md',
      'work-item-fields.md',
      'dependencies-folder.md',
    ],
    outputSchema: WorkItemUpdateSchema,
    allowedTools: [...TOOL_SETS.fsReadOnly, ...MCP_TOOLS.zendeskReadOnly],
    // Summarises a finished work item into a structured update — it reads and
    // reports, nothing else. `Bash` is denied too: across its recorded runs the
    // documenter issued no tool calls at all, so nothing depends on a shell.
    // `REPL`: a potential bypass of the mutation denials, sandbox unestablished,
    // zero recorded usage — denied because it is free, not because it is proven.
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'REPL'],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;

      return [
        `## Task`,
        `Update work item #${ctx.workItemId} with documentation of the completed implementation.`,
        ``,
        `## Work Item`,
        `- **ID:** ${ctx.workItemId}`,
        `- **Title:** ${ctx.workItem.title}`,
        `- **Type:** ${ctx.workItemType}`,
        ``,
        `## What Was Implemented`,
        `**Plan summary:** ${devPlan.summary}`,
        ``,
        `**Files changed:**`,
        `- Created: ${changeset.filesCreated.join(', ') || '(none)'}`,
        `- Modified: ${changeset.filesModified.join(', ') || '(none)'}`,
        ``,
        `**Objects modified:**`,
        ...devPlan.objects.map(o => `- ${o.action} ${o.objectType} "${o.objectName}": ${o.description}`),
        ``,
        `## Required Fields`,
        `- \`Area Path\`: ${config.azureDevOps.areaPath}`,
        `- \`Iteration Path\`: ${config.azureDevOps.iterationPath}`,
        `- \`Custom.ReleaseNotes\`: Customer-facing (action word + benefit, NOT technical)`,
        ``,
        `## Instructions`,
        `1. Write release notes from the customer's perspective (e.g. "Fixed issue where..." not "Updated codeunit...")`,
        `2. Write an HTML description using the project's template sections: Error Details, Root Cause, Solution, Impact`,
        `3. Prepare field updates for Area Path, Iteration Path, and ReleaseNotes`,
        `4. Write a summary comment for the work item`,
        `5. Use \`update_work_item\` via MCP to apply the field updates`,
      ].join('\n');
    },
  };
}

export function documenterStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createDocumenterConfig(config),
    canRun: (state) => state.draftPR != null,
    applyOutput: (state, output: WorkItemUpdate) => ({
      ...state,
      workItemUpdate: output,
    }),
  });
}
