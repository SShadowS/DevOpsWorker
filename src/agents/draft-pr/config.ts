import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { DraftPullRequestSchema, type DraftPullRequest } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { azureDevOpsMcp } from '../../sdk/mcp-configs.ts';
import { buildPipelineRunUrl, postPRComment } from '../../sdk/azure-devops-client.ts';

// ---------------------------------------------------------------------------
// Draft PR Agent — creates a draft pull request in Azure DevOps
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export function createDraftPRConfig(config: PipelineConfig): AgentConfig<typeof DraftPullRequestSchema> {
  return {
    name: 'draft-pr',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'branch-naming.md',
      'dependencies-folder.md',
    ],
    outputSchema: DraftPullRequestSchema,
    // Needs DevOps write access for PR creation, plus Bash for git read
    allowedTools: ['Bash', 'Read', 'mcp__azureDevOps__create_pull_request', 'mcp__azureDevOps__update_pull_request', 'mcp__azureDevOps__list_pull_requests'],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.targetRepo,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;

      // If PR already exists, switch to update mode
      if (state.draftPR) {
        const parts = [
          `## Task`,
          `Update the existing draft pull request for work item #${ctx.workItemId}.`,
          `The source branch has new commits from a fix.`,
          ``,
          `## Existing PR`,
          `- **PR ID:** ${state.draftPR.id}`,
          `- **URL:** ${state.draftPR.url}`,
          `- **Source branch:** ${changeset.branchName}`,
          `- **Target branch:** master`,
          ``,
          `## Dev Plan Summary`,
          `${devPlan.summary}`,
          ``,
          `## Files Changed`,
          `**Created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
          `**Modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
          ``,
          `## Instructions`,
          `1. The branch already has the new commits pushed — the PR diff updates automatically`,
          `2. Review the current PR description and update it if the fix changes the summary`,
          `3. Use the Azure DevOps MCP \`update_pull_request\` tool to update the description if needed`,
          `4. Do NOT create a new PR`,
          `5. Report the updated PR details`,
        ];

        return parts.join('\n');
      }

      const parts = [
        `## Task`,
        `Create a draft pull request in Azure DevOps for work item #${ctx.workItemId}.`,
        ``,
        `## Details`,
        `- **Repository:** ${config.azureDevOps.repositoryName} (ID: ${config.azureDevOps.repositoryId})`,
        `- **Source branch:** ${changeset.branchName}`,
        `- **Target branch:** master`,
        `- **Work item ID:** ${ctx.workItemId}`,
        `- **Work item title:** ${ctx.workItem.title}`,
        ``,
        `## Dev Plan Summary`,
        `${devPlan.summary}`,
        ``,
        `## Files Changed`,
        `**Created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
        `**Modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
        ``,
        `## CI Status`,
        changeset.ciRunId
          ? `${changeset.ciResult ?? 'not-run'} — [View Pipeline Run](${buildPipelineRunUrl(config, changeset.ciRunId)})`
          : `${changeset.ciResult ?? 'not-run'}`,
        ``,
        `## Instructions`,
        `1. Use the Azure DevOps MCP \`create_pull_request\` tool to create the PR`,
        `2. Set isDraft to true`,
        `3. PR title: derive from work item title (concise, under 70 chars)`,
        `4. PR description: include dev plan summary, files changed, CI status`,
        `5. Link the work item to the PR using \`update_pull_request\``,
        `6. Report the created PR details`,
      ];

      if (state.environment) {
        parts.push(
          ``,
          `## Test Environment`,
          `A BC test environment was used for validation:`,
          `- **URL:** ${state.environment.url}`,
          `- **Environment ID:** ${state.environment.envId}`,
          ``,
          `Include a "Test Environment" section in the PR description with the URL`,
          `so reviewers can access the environment to manually verify the changes.`,
        );
      }

      return parts.join('\n');
    },
  };
}

export function draftPRStage(config: PipelineConfig): Stage {
  const inner = agentStage({
    agent: createDraftPRConfig(config),
    canRun: (state) => state.changeset != null,
    applyOutput: (state, output: DraftPullRequest) => ({
      ...state,
      draftPR: output,
    }),
  });

  return {
    name: inner.name,
    canRun: inner.canRun,
    async execute(state: PipelineState, context: PipelineContext): Promise<PipelineState> {
      const newState = await inner.execute(state, context);

      // Post CI pipeline link as a PR comment
      const ciRunId = state.changeset?.ciRunId;
      if (newState.draftPR && ciRunId) {
        const ciUrl = buildPipelineRunUrl(config, ciRunId);
        const ciResult = state.changeset?.ciResult ?? 'not-run';
        const icon = ciResult === 'passed' ? '\u2705' : ciResult === 'failed' ? '\u274C' : '\u23F8\uFE0F';
        const comment = `${icon} **CI Pipeline:** [${ciResult} \u2014 Run #${ciRunId}](${ciUrl})`;
        try {
          await postPRComment(newState.draftPR.id, comment, config);
        } catch (err) {
          console.warn(`[draft-pr] Failed to post CI comment to PR #${newState.draftPR.id}:`, err);
        }
      }

      return newState;
    },
  };
}
