import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext } from '../../types/pipeline.types.ts';
import type { AgentConfig, AgentResult } from '../../types/agent.types.ts';
import { BackportReviewSchema, type BackportReview } from './schema.ts';
import { azureDevOpsMcp, TOOL_SETS, TOOLS, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import { runAgent } from '../../sdk/run-agent.ts';
import { createInitialState } from '../../pipeline/initial-state.ts';
import { AgentExecutionError } from '../../sdk/errors.ts';
import type { PipelineLogger } from '../../sdk/pipeline-logger.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Backport Sanity Reviewer — the cheap path for a cherry-picked PR
// ---------------------------------------------------------------------------

const MCP_ADD_COMMENT_TOOL = 'mcp__azureDevOps__add_pull_request_comment';
const MCP_UPDATE_COMMENT_TOOL = 'mcp__azureDevOps__update_pull_request_comment';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export interface BackportReviewParams {
  prId: number;
  sourcePrId: number;
  repoKey: string;
  /** This PR's own branch, full ref form (`refs/heads/...`). */
  sourceBranch: string;
  targetBranch: string;
  /** Pre-computed by `compareDiffs`/`renderDiffComparison` — evidence, not a task. */
  diffComparison: string;
  sourceReviewStatus: 'reviewed' | 'not-reviewed';
  sourceRecommendation: string | null;
  mergePreviewStale: boolean;
  checkoutOk: boolean;
  noPost: boolean;
  /**
   * Markdown table of the `file` + `title` pairs that already carry an inline
   * thread on this PR (built by `buildPriorFindingsBlock`), or '' when there are
   * none. `buildPrompt` ignores its state and context arguments, so this is the
   * only channel through which the prompt can learn what a previous review named
   * its findings — and a finding's identity is its file plus its title. Without
   * it, a re-review of a backport has nothing to be stable against and forks
   * every thread into a duplicate rather than updating it.
   */
  priorFindingsBlock?: string;
}

export function createBackportReviewConfig(
  config: PipelineConfig,
  params: BackportReviewParams,
): AgentConfig<typeof BackportReviewSchema> {
  return {
    name: 'cherry-pick-reviewer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: ['dependencies-folder.md'],
    outputSchema: BackportReviewSchema,

    // No `Agent`, no `Task`. The full reviewer costs ~$10 because seven sub-agents
    // each cache their own context; this agent has no sub-agents and cannot
    // dispatch any. That is the saving, made structural instead of instructed —
    // this codebase has twice measured a model ignoring an instruction of exactly
    // that kind.
    //
    // Omitting them here is NOT what enforces that — see `disallowedTools` below.
    // They are omitted anyway so this list states the agent's actual tool surface.
    //
    // Listed additively rather than as a filtered TOOL_SETS entry: a set this
    // agent subtracts from would hand it write access the day someone adds a tool
    // to that set, and silently.
    //
    // LSP is enabled unconditionally, following plan-reviewer rather than
    // pr-reviewer: pr-reviewer gates it on CALLEE_MECHANISM, which
    // container-dispatcher does not forward, so in production it runs with no LSP
    // at all. Checks 2 and 3 are LSP work, so gating them would make this agent
    // silently useless.
    allowedTools: [
      ...TOOL_SETS.fsReadOnlyWithLSP,
      TOOLS.Bash,
      'mcp__azureDevOps__get_pull_request_changes',
      'mcp__azureDevOps__get_pull_request_checks',
      'mcp__azureDevOps__get_file_content',
      'mcp__azureDevOps__list_commits',
      MCP_ADD_COMMENT_TOOL,
      MCP_UPDATE_COMMENT_TOOL,
    ],
    // THIS is what makes the no-fan-out guarantee real. `allowedTools` is not an
    // availability restriction: the SDK documents it as the list auto-allowed
    // *without prompting*, and `runAgent` passes `permissionMode:
    // 'bypassPermissions'`, which bypasses the permission layer it feeds. The
    // claude_code preset supplies the full default tool set regardless.
    //
    // Production telemetry says the same: `analyzer` lists neither dispatch tool
    // and has no sub-agents, yet 6 of its recorded stage runs called `Agent`;
    // pr-reviewer called Write (95 runs), TodoWrite (91) and Edit (2), none of
    // them in its list. In the same data, `Bash` — which analyzer *disallows* —
    // appears in 0 of its 14 runs. Omission is advisory; disallowing removes the
    // tool from the model's context.
    //
    // Four names, because the SDK offers four ways to fan out and denying only
    // the obvious two leaves the cost guarantee open:
    //   Agent / Task — the dispatch tool proper. Both are listed because the SDK
    //                  has used both across versions: this agent's sibling
    //                  plan-reviewer allows `Task`, and what its runs actually
    //                  record is `Agent`.
    //   Workflow     — takes a script of agent()/parallel()/pipeline() calls
    //                  (sdk-tools.d.ts WorkflowInput), i.e. the same fan-out under
    //                  a third name.
    //   REPL         — arbitrary JavaScript with persistent state, which can reach
    //                  anything the other three can.
    // None of the four has ever been called (0 across 1483 recorded reviews and
    // 0 of 90,218 recorded stage tool calls) — this closes a door nobody has yet
    // walked through, which is the point: the guarantee is meant to be structural,
    // not merely unexercised. Do not prune the two that look unused.
    //
    // The file-mutation tools are denied too. Note what that does and does not
    // buy: `Bash` is retained, and `sed -i`, `>` and `git checkout` alter a tree
    // perfectly well, so this makes the agent's *file tools* read-only rather
    // than making the agent incapable of changing the checkout.
    disallowedTools: ['Agent', 'Task', 'Workflow', 'REPL', 'Write', 'Edit', 'NotebookEdit'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: { azureDevOps: azureDevOpsMcp(config) },
    // Inside the container the session root holds the cloned repo in a subdirectory
    // named for the repo key, alongside any companion repos — the checkout is applied
    // to that subdirectory, not to the session root itself. `cwd` still points at the
    // session root: pr-reviewer uses the same working directory, and the agent can
    // navigate to the checked-out subdirectory from there.
    cwd: config.paths.sessionRoot,

    // Pinned, not inherited. The model is the measured cost lever: seven
    // sub-agents silently running opus rather than sonnet took one review from
    // $10.06 to $18.77 on an identical image.
    model: 'claude-sonnet-5',

    maxTurns: 30,
    maxRetries: 1, // posts PR comments; not idempotent

    buildPrompt(_state: PipelineState, _ctx: PipelineContext): string {
      // `null` marks a section that does not apply here and is dropped; `''` is a
      // real blank line and survives. Filtering on truthiness, as pr-reviewer
      // does, collapses both — which costs that prompt every paragraph break and
      // runs its bullet list into the prose below it.
      const lines: (string | null)[] = [
        `## Task`,
        `Review pull request #${params.prId} in ${config.azureDevOps.repositoryName}.`,
        ``,
        `This is a **backport**: the change was ported from PR !${params.sourcePrId}. The deep`,
        `analysis of the change itself happened there. Your job is the three things that can`,
        `only be wrong about the port, described in your CLAUDE.md.`,
        ``,
        `## Port details`,
        `- **This PR:** #${params.prId}`,
        `- **Ported from:** !${params.sourcePrId}`,
        `- **Source PR review status:** ${params.sourceReviewStatus}${params.sourceRecommendation ? ` (${params.sourceRecommendation})` : ''}`,
        `- **This PR's branch:** ${params.sourceBranch}`,
        `- **Target branch:** ${params.targetBranch}`,
        `- **Working tree checked out to this PR's branch:** ${params.checkoutOk ? 'yes' : 'NO'}`,
        `- **Merge preview current:** ${params.mergePreviewStale ? 'no — the target advanced after this branch was cut' : 'yes'}`,
        ``,
        params.sourceReviewStatus === 'not-reviewed'
          ? `The source PR has **not-reviewed** status: this change has no recorded deep review anywhere. Say so in your summary so a human can ask for a full review if they want one.`
          : null,
        params.sourceReviewStatus === 'not-reviewed' ? `` : null,
        params.diffComparison,
        ``,
        `Your working directory holds the cloned repository in the \`${params.repoKey}\` subdirectory, alongside any companion repos${params.checkoutOk
          ? `; that subdirectory is checked out to ${params.sourceBranch}, so it represents this port merged into ${params.targetBranch}`
          : `, but the checkout to this PR's branch did NOT succeed — report the symbol and coverage checks as unverified`}.`,
        params.noPost ? `` : null,
        params.noPost
          ? `## REPLAY MODE\nThis is a measurement replay. Do ALL analysis but post no PR comment. Return the structured result with commentId set to 0.`
          : null,
      ];

      const body = lines.filter((l): l is string => l !== null).join('\n');
      // Prepended, not appended: the model needs the titles it must reuse before
      // it starts naming findings. Omitted entirely when empty — an unconditional
      // heading over an empty table would assert prior findings that don't exist.
      return params.priorFindingsBlock ? `${params.priorFindingsBlock}\n\n${body}` : body;
    },
  };
}

/**
 * True when the run *attempted* to write to the PR through the supported channel.
 *
 * Not "posted": the counts it reads come from `consumeAgentStream`, which
 * increments on each `tool_use` block (`src/sdk/agent-stream.ts:173`) — the
 * model's attempt, not the result. A comment call that failed still satisfies
 * this guard. It detects "never attempted", which is the failure mode worth
 * catching and the one `runPRReview` checks for identically.
 *
 * The MCP comment tools are the only supported channel: shell quoting around a
 * large markdown body has posted literal `'"$REVIEW_CONTENT"'` placeholders to a
 * live PR before, and a review that posted nothing at all is otherwise
 * indistinguishable in the data from one that posted fine.
 */
export function postedThroughMcp(toolCalls: Record<string, number>): boolean {
  return (toolCalls[MCP_ADD_COMMENT_TOOL] ?? 0) + (toolCalls[MCP_UPDATE_COMMENT_TOOL] ?? 0) > 0;
}

/**
 * Run the backport sanity review.
 * Expects to be called from within a container where the repo is already cloned
 * and checked out to the PR's own branch.
 */
export async function runBackportReview(
  params: BackportReviewParams,
  config: PipelineConfig,
  logger?: PipelineLogger,
): Promise<AgentResult<BackportReview>> {
  const context: PipelineContext = {
    workItemId: 0,
    workItem: {
      id: 0,
      title: `PR #${params.prId} backport review`,
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

  const state = createInitialState('cherry-pick-reviewer');
  const result = await runAgent(createBackportReviewConfig(config, params), state, context);

  if (!params.noPost && !postedThroughMcp(result.toolCalls)) {
    throw new AgentExecutionError('cherry-pick-reviewer', {
      reason: 'no-mcp-comment-call',
      message: `cherry-pick-reviewer produced structured output but never called ${MCP_ADD_COMMENT_TOOL} or ${MCP_UPDATE_COMMENT_TOOL}. The review was not posted to the PR via the supported channel.`,
      toolCalls: result.toolCalls,
      sessionId: result.sessionId,
    });
  }

  return result;
}
