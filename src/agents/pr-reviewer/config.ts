import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentConfig, AgentResult } from '../../types/agent.types.ts';
import type { PipelineConfig, PipelineState, PipelineContext } from '../../types/pipeline.types.ts';
import { PRReviewSchema } from './schema.ts';
import type { PRReviewResult } from './schema.ts';
import { azureDevOpsMcp, resolveAlLspPlugin, TOOLS } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { runAgent } from '../../sdk/run-agent.ts';
import { createInitialState } from '../../pipeline/initial-state.ts';
import { AgentExecutionError } from '../../sdk/errors.ts';
import type { PipelineLogger } from '../../sdk/pipeline-logger.ts';

const MCP_ADD_COMMENT_TOOL = 'mcp__azureDevOps__add_pull_request_comment';
const MCP_UPDATE_COMMENT_TOOL = 'mcp__azureDevOps__update_pull_request_comment';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export interface PRReviewParams {
  prId: number;
  repoKey: string;
  repoUrl: string;
  repositoryId: string;
  project: string;
  sourceBranch: string;
  targetBranch: string;
  prUrl?: string;
  prTitle?: string;
  prDescription?: string;
  noPost?: boolean;
}

export interface CherryPickInfo {
  isCherryPick: boolean;
  originalPrId?: number;
}

/**
 * Detect whether a PR is a cherry-pick based on title and description.
 * Azure DevOps cherry-pick PRs have titles starting with "Cherry-pick ".
 * Original PR ID is extracted from the description (e.g., "!456" or PR URL).
 */
export function detectCherryPick(pr: { title: string; description?: string }): CherryPickInfo {
  const lower = pr.title.toLowerCase();
  const titleMatch = lower.startsWith('cherry-pick ') || lower.startsWith('cherry-pick:');

  // Also detect from description: "Cherry picked from" or "Cherry-picked from commit"
  const descLower = pr.description?.toLowerCase() ?? '';
  const descMatch = /cherry[- ]picked? from/.test(descLower);

  const isCherryPick = titleMatch || descMatch;
  if (!isCherryPick) return { isCherryPick: false };

  let originalPrId: number | undefined;
  if (pr.description) {
    // Match "/pullrequest/456" (URL, most reliable) or "!456" (Azure DevOps PR reference)
    const prUrlMatch = pr.description.match(/\/pullrequest\/(\d+)/);
    const prRefMatch = pr.description.match(/!(\d+)/);
    const match = prUrlMatch || prRefMatch;
    if (match) {
      originalPrId = parseInt(match[1]!, 10);
    }
  }

  return { isCherryPick, originalPrId };
}

function calleeGuide(mechanism: string): string {
  if (mechanism === 'lsp') {
    return [
      `## Resolving Called Procedures (AL LSP)`,
      `Before flagging anything that depends on what a CALLED procedure does — a`,
      `transaction/commit boundary, whether an error is swallowed, an IsHandled`,
      `bail-out — resolve the callee first:`,
      `- Jump to a called proc's definition → \`LSP goToDefinition\``,
      `- What a proc calls → \`LSP outgoingCalls\`  |  who calls it → \`LSP incomingCalls\``,
      `- A symbol's type/signature → \`LSP hover\``,
      `Pass this instruction to every analysis sub-agent.`,
    ].join('\n');
  }
  if (mechanism === 'treesitter') {
    return [
      `## Resolving Called Procedures (al-symbol)`,
      `The repo is cloned at the cwd. Before flagging anything that depends on what`,
      `a CALLED procedure does — a transaction/commit boundary, a swallowed error,`,
      `an IsHandled bail-out — read the callee with the al-symbol helper via Bash:`,
      `| When you need to… | Run |`,
      `|---|---|`,
      `| see what a called proc actually does | \`bun /app/scripts/al-symbol.ts def <Name>\` |`,
      `| what a proc calls | \`bun /app/scripts/al-symbol.ts callees <file.al> <Proc>\` |`,
      `| who calls a proc | \`bun /app/scripts/al-symbol.ts callers <Name>\` |`,
      `Resolution is syntactic; if it prints multiple candidates, Read each to`,
      `disambiguate. Pass this instruction to every analysis sub-agent.`,
    ].join('\n');
  }
  return ''; // none — baseline, no guide
}

export function createPRReviewConfig(config: PipelineConfig, params: PRReviewParams): AgentConfig<typeof PRReviewSchema> {
  const mechanism = (process.env['CALLEE_MECHANISM'] ?? 'none').toLowerCase();
  const lspTools = mechanism === 'lsp' ? [TOOLS.LSP] : [];
  const lspPlugins = mechanism === 'lsp'
    ? ([resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[])
    : [];

  return {
    name: 'pr-reviewer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: ['dependencies-folder.md'],
    outputSchema: PRReviewSchema,
    allowedTools: [
      'Agent',
      'Bash',
      'Read',
      'Grep',
      'Glob',
      'mcp__azureDevOps__list_pull_requests',
      'mcp__azureDevOps__get_pull_request_changes',
      'mcp__azureDevOps__get_pull_request_comments',
      'mcp__azureDevOps__get_file_content',
      'mcp__azureDevOps__add_pull_request_comment',
      'mcp__azureDevOps__update_pull_request_comment',
      'mcp__azureDevOps__list_commits',
      ...lspTools,
    ],
    plugins: lspPlugins,
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    // Inside the container, the session root has the cloned repo + companions
    cwd: config.paths.sessionRoot,
    maxTurns: 100,
    maxRetries: 1, // No retries — agent posts PR comments as side effects that aren't idempotent

    buildPrompt(_state: PipelineState, _ctx: PipelineContext): string {
      const cherryPick = params.prTitle
        ? detectCherryPick({ title: params.prTitle, description: params.prDescription })
        : { isCherryPick: false } as CherryPickInfo;

      const lines = [
        `## Task`,
        `Review Pull Request #${params.prId} in the ${config.azureDevOps.repositoryName} repository.`,
        ``,
        `## PR Details`,
        `- **PR ID:** ${params.prId}`,
        `- **Repository:** ${config.azureDevOps.repositoryName} (ID: ${config.azureDevOps.repositoryId})`,
        `- **Project:** ${config.azureDevOps.project}`,
        `- **Source branch:** ${params.sourceBranch}`,
        `- **Target branch:** ${params.targetBranch}`,
        params.prUrl ? `- **URL:** ${params.prUrl}` : '',
        ``,
        `The repository is cloned locally at the current working directory.`,
        `Use local file tools (Read, Grep, Glob, Bash) for code analysis alongside the MCP tools for PR metadata.`,
        ``,
        `Follow the instructions in your CLAUDE.md to:`,
        `1. Post an in-progress comment`,
        `2. Fetch PR diff and changed files`,
        `3. Fetch full source code for each changed file`,
        `4. Dispatch the 7 analysis agents in parallel`,
        `5. Synthesize findings`,
        `6. Update the PR comment with the full review`,
      ];

      lines.push(
        params.noPost
          ? `\n## REPLAY MODE\nThis is a measurement replay. Do ALL analysis but DO NOT post or update any PR comment. Skip the Phase 1 and Phase 6 comment calls. Still return the structured PRReviewResult with commentId set to 0.`
          : '',
      );

      const guide = calleeGuide(mechanism);
      if (guide) lines.push('', guide);

      if (cherryPick.isCherryPick) {
        lines.push(
          ``,
          `## Cherry-Pick Detected`,
          `This PR has been identified as a cherry-pick.`,
          cherryPick.originalPrId
            ? `Original PR: #${cherryPick.originalPrId}`
            : `Original PR: could not be determined from description — use commit messages to find the source.`,
          ``,
          `**Follow the Cherry-Pick Verification workflow in CLAUDE.md Phase 2.**`,
        );
      }

      return lines.filter(Boolean).join('\n');
    },
  };
}

/**
 * Run the PR review agent.
 * Expects to be called from within a container where the repo is already cloned
 * (session root has the main repo + companions set up by the Docker entrypoint).
 */
export async function runPRReview(
  params: PRReviewParams,
  config: PipelineConfig,
  logger?: PipelineLogger,
): Promise<AgentResult<PRReviewResult>> {
  const context: PipelineContext = {
    workItemId: 0,
    workItem: {
      id: 0,
      title: `PR #${params.prId} Review`,
      type: 'Task',
      state: 'Active',
      areaPath: config.azureDevOps.areaPath,
      iterationPath: config.azureDevOps.iterationPath,
      fields: {},
    },
    workItemType: 'Bug',
    config,
    logger,
  };

  const state = createInitialState('pr-reviewer');
  const agentConfig = createPRReviewConfig(config, params);
  const result = await runAgent(agentConfig, state, context);

  const addCalls = result.toolCalls[MCP_ADD_COMMENT_TOOL] ?? 0;
  const updateCalls = result.toolCalls[MCP_UPDATE_COMMENT_TOOL] ?? 0;
  if (!params.noPost && addCalls + updateCalls === 0) {
    throw new AgentExecutionError('pr-reviewer', {
      reason: 'no-mcp-comment-call',
      message: `pr-reviewer produced structured output but never called ${MCP_ADD_COMMENT_TOOL} or ${MCP_UPDATE_COMMENT_TOOL}. The review was not posted to the PR via the supported channel. Comment may contain unexpanded shell placeholders posted via Bash.`,
      toolCalls: result.toolCalls,
      sessionId: result.sessionId,
    });
  }

  return result;
}
