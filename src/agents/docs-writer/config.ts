import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { DocsWriterOutputSchema, type DocsWriterOutput } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { TOOL_SETS, MCP_TOOLS, azureDevOpsMcp } from '../../sdk/mcp-configs.ts';

// ---------------------------------------------------------------------------
// Docs Writer Agent — drafts documentation pages for the docs site
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createDocsWriterConfig(config: PipelineConfig): AgentConfig<typeof DocsWriterOutputSchema> {
  return {
    name: 'docs-writer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'doc-writing-style.md',
    ],
    outputSchema: DocsWriterOutputSchema,
    allowedTools: [...TOOL_SETS.fsReadWrite, ...MCP_TOOLS.workItemRead],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;
      const releaseNotes = state.workItemUpdate?.releaseNotes ?? '(not available)';

      // Local path to the existing docs-site repo to survey. Proprietary +
      // machine-specific, so it comes from the DOCS_REPO_PATH env var (set per
      // deployment / in the private overlay's env). Unset → the "survey existing
      // docs" instruction is omitted.
      const docsRepoPath = process.env['DOCS_REPO_PATH'];

      return [
        `## Task`,
        `Decide whether the completed implementation warrants documentation changes on the product's documentation site. If yes, draft the pages.`,
        ``,
        `## Work Item`,
        `- **ID:** ${ctx.workItemId}`,
        `- **Title:** ${ctx.workItem.title}`,
        `- **Type:** ${ctx.workItemType}`,
        ``,
        `## What Was Implemented`,
        `**Plan summary:** ${devPlan.summary}`,
        ``,
        `**Release notes:** ${releaseNotes}`,
        ``,
        `**Files changed:**`,
        `- Created: ${changeset.filesCreated.join(', ') || '(none)'}`,
        `- Modified: ${changeset.filesModified.join(', ') || '(none)'}`,
        ``,
        `**Objects modified:**`,
        ...devPlan.objects.map(o => `- ${o.action} ${o.objectType} "${o.objectName}": ${o.description}`),
        ``,
        ...(docsRepoPath
          ? [
              `## Docs Repo`,
              `The existing documentation lives at: \`${docsRepoPath}\``,
              `Read files from this path to understand existing docs structure and find related pages.`,
              ``,
            ]
          : []),
        `## Output Directory`,
        `Write draft files to: \`docs-drafts/\` (relative to your cwd).`,
        `Mirror the docs repo directory structure inside docs-drafts/.`,
        `Use placeholder IDs (DO-DRAFT-1, DO-DRAFT-2, etc.) for new pages — the technical writer assigns real IDs.`,
        ``,
        `## Decision Guidelines`,
        `- **Bug fix with no user-visible behavior change** → likely NO docs needed`,
        `- **Bug fix that changes documented behavior** → UPDATE existing page`,
        `- **New UI page, field, or action** → CREATE new page or UPDATE existing`,
        `- **New feature or capability** → CREATE new page + update overview`,
        `- **Internal refactoring only** → NO docs needed`,
        `- **Changed setup steps** → UPDATE the relevant setup page`,
        ``,
        `When in doubt, lean toward creating a draft — it's easier for the writer to discard than to discover a missing page later.`,
      ].join('\n');
    },
  };
}

export function docsWriterStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createDocsWriterConfig(config),
    canRun: (state) => state.workItemUpdate != null,
    applyOutput: (state, output: DocsWriterOutput) => ({
      ...state,
      docsWriterDrafts: output,
    }),
  });
}
