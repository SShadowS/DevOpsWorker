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
import type { ReviewTreeSource } from '../../sdk/ado/review-tree.ts';

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
  /**
   * Which tree the clone at the cwd actually holds — set by the checkout walk in
   * `review-pr.ts`, never assumed.
   *
   * Required on purpose: the compiler then forces every constructor to decide.
   * The defect this replaces was a prompt that described the clone the same way
   * whatever was in it, while for roughly half of reviews it held a different
   * release line than the PR.
   */
  treeSource: ReviewTreeSource;
  /** What won: short commit sha, or branch name. Absent when `treeSource` is `default-branch`. */
  treeDetail?: string;
  /**
   * Markdown table of the `file` + `title` pairs that already carry an inline
   * thread on this PR (built by `buildPriorFindingsBlock`), or '' when there are
   * none. `buildPrompt` ignores its state and context arguments, so this is the
   * only channel through which the prompt can learn what a previous review named
   * its findings — and a finding's identity is its file plus its title.
   */
  priorFindingsBlock?: string;
}

export interface CherryPickInfo {
  isCherryPick: boolean;
  originalPrId?: number;
  /**
   * Set only when the port names SEVERAL merged parents and nothing settles
   * which one it came from — the ids, in the order they appear. `originalPrId`
   * is then deliberately left unset: the cheap path compares against exactly
   * one source, and half a comparison reports the other half as divergence.
   *
   * Carried so the route reason can say what really happened instead of
   * blaming a missing trailer, and so the prompt can still tell the reviewer
   * this is a port.
   */
  multiSourcePrIds?: number[];
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

  // The second shape, written by the backport tooling rather than the Azure DevOps
  // button: `Merged PR 52705: [Cherry-pick 25] Remove DK prefix...`. The marker sits
  // mid-title in brackets and no description ever says "picked FROM" anything, so
  // neither test above sees it. Nine reviews took the full path on this shape and cost
  // $63.71 between them against roughly $0.42 a review on the cheap path.
  //
  // The same tooling also writes `[Backport 26.x] <title>` — same brackets, same
  // position, same meaning, different word, and the version may carry a `.x`. PR 53271
  // took the full path on it: $6.23, and all three of its Major findings were rejected
  // with "That's a merge from master where it was tested and approved", because nothing
  // in the review knew the code had already shipped upstream.
  //
  // The number in the bracket is the Business Central version branch (25.x, 26.x), NOT
  // a PR id — `\d+` is matched only to anchor the form, and never read as an id.
  const BRACKETED = /\[(?:cherry[- ]pick|backport)\s*\d*(?:\.x)?\s*\]/i;
  const bracketMatch = BRACKETED.test(pr.title) || BRACKETED.test(pr.description ?? '');

  // A revert of a port quotes the port's own title, marker and all, so every test above
  // says yes to it. It is the opposite of a port — it takes a change away — and the
  // cheap path would compare it against the very PR it undoes, calling every file
  // "diverged". Reverts are rare and read cheap; send them down the full path.
  const isRevert = /^\s*revert\b/i.test(pr.title);

  const isCherryPick = !isRevert && (titleMatch || descMatch || bracketMatch);
  if (!isCherryPick) return { isCherryPick: false };

  // A port can carry more than one source. PR 53271 lists two, one per line:
  //   - Merged PR 41464: Fix Quantity Matching for Purchase Documents
  //   - Merged PR 42379: Merged PR 42271: Purchase Receipt/Shipment Unit Cost Matching
  // The cheap path compares against exactly ONE source PR, so picking the first would
  // compare half the change and report the other half as divergence — confidently, and
  // with nothing downstream to catch it. Better to pay for the full review and say why.
  //
  // One id per line, deliberately: nested prefixes on a single line are a port of a
  // port (one chain, nearest ancestor first), not two separate sources.
  const parentsPerLine = (text: string | undefined): number[] =>
    (text?.split(/\r?\n/) ?? [])
      .map((line) => line.match(/merged pr (\d+):/i))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => parseInt(m[1]!, 10));
  const distinctParents = [...new Set([...parentsPerLine(pr.title), ...parentsPerLine(pr.description)])];
  // An explicit `Cherry picked from !<id>` trailer names the source outright and
  // outranks any list of merged parents, exactly as it does everywhere below.
  const hasTrailer = /cherry[- ]picked? from !\d+/i.test(pr.description ?? '');
  if (!hasTrailer && distinctParents.length > 1) {
    return { isCherryPick: true, multiSourcePrIds: distinctParents };
  }

  let originalPrId: number | undefined;

  // `Merged PR <id>:` is what a squash merge writes at the front of the message, so on a
  // port it names the PR this branch was taken from. On a port of a port the prefixes
  // nest — `Merged PR 52705: Merged PR 52680: [Cherry-pick 26] …` — and the FIRST is the
  // nearest ancestor, matching the "newest trailer wins" rule below.
  //
  // Only consulted once the cherry-pick marker is present. Every squash-merged PR in this
  // organisation carries this prefix, so on its own it means nothing at all.
  // The trailing colon is required, and it is the whole guard against prose. A squash
  // merge always writes `Merged PR 52705:` as a prefix; a sentence like "align with what
  // merged PR 51000 did" names a PR that is not this change's parent, and nothing
  // downstream would catch that — 51000 is real, same-repo and fetchable, so the cheap
  // path would compare against the wrong change and report on it confidently.
  const mergedParent = (text: string | undefined): number | undefined => {
    const m = text?.match(/merged pr (\d+):/i);
    return m ? parseInt(m[1]!, 10) : undefined;
  };
  const parentFromTitle = mergedParent(pr.title) ?? mergedParent(pr.description);

  if (pr.description) {
    // Ordered by how strongly each form indicates the SOURCE of this port.
    //
    // 1. The `Cherry picked from !<id>` trailer is written by whoever made the port
    //    and names the immediate parent. Last match wins: a port of a port
    //    accumulates trailers, and the newest is the branch this was taken from
    //    (PR 52309 carries !51720 then !52121 — 52121 is the parent).
    // 2. A `/pullrequest/<id>` URL is what the Azure DevOps cherry-pick button
    //    emits, and those descriptions carry no trailer at all.
    // 3. A bare `!<id>` is the loosest form and only used when nothing better exists.
    //
    // The ordering is the bug fix. Preferring the URL first meant PR 52307 resolved
    // to 50231 — an unrelated sibling fix cited in its prose — instead of its real
    // source 52117. 50231 is same-repo and fetchable, so no downstream guard catches
    // it; this ordering is the only protection.
    const trailers = [...pr.description.matchAll(/cherry[- ]picked? from !(\d+)/gi)];
    const lastTrailer = trailers[trailers.length - 1];
    const urlMatch = pr.description.match(/\/pullrequest\/(\d+)/);
    const refMatch = pr.description.match(/!(\d+)/);
    // 4. The `Merged PR <id>:` prefix. It outranks the URL and the bare `!<id>` when the
    //    bracketed marker is present, and only then: on that shape the prefix is written
    //    by the backport tooling and is structural, while a URL or a bare `!<id>` in the
    //    same description is prose a person typed. That is the 52307 lesson applied to
    //    the newer shape — a cited sibling PR is real, same-repo and fetchable, so
    //    picking it over the true parent is a mistake no later guard can catch. An
    //    explicit trailer still wins over everything: it names the source outright.
    const chosen = bracketMatch
      ? (lastTrailer?.[1] ?? parentFromTitle ?? urlMatch?.[1] ?? refMatch?.[1])
      : (lastTrailer?.[1] ?? urlMatch?.[1] ?? refMatch?.[1]);
    if (chosen) originalPrId = typeof chosen === 'number' ? chosen : parseInt(chosen, 10);
  }

  originalPrId ??= parentFromTitle;

  return { isCherryPick, originalPrId };
}

/**
 * What the clone's working tree actually holds, in words the agent can act on.
 *
 * One branch per `ReviewTreeSource`. The honest degradation on `default-branch`
 * is the point: the defect this replaces was a prompt that implied the PR's code
 * over a tree from another release line — and, as the comment on the backport
 * path's own fix puts it, that "would answer from a different release line and
 * look verified".
 */
function workingTreeLines(params: PRReviewParams): string[] {
  const at = params.treeDetail ? ` (${params.treeDetail})` : '';
  switch (params.treeSource) {
    case 'merge-preview':
      return [
        `The repository is cloned at the current working directory, checked out to this PR merged into its target branch${at}.`,
        `Files the PR does not touch match the target branch; files it touches already include the PR's changes.`,
      ];
    case 'source-head':
      return [
        `The repository is cloned at the current working directory, checked out to this PR's own head commit${at}.`,
        `It contains the PR's changes, but not target-branch work that landed after the PR branched.`,
      ];
    case 'target-tip':
      return [
        `The repository is cloned at the current working directory, checked out to the tip of the target branch${at}.`,
        `It does NOT contain this PR's changes — read those from the diff and the MCP file tools.`,
        `It IS the right place to read the current behaviour of code the PR calls but does not change.`,
      ];
    case 'default-branch':
      return [
        `WARNING: the PR's code could not be checked out. The clone at the current working directory sits on the repository's default branch, which may be a different release line than this PR's target (${params.targetBranch}).`,
        `Do not trust the clone for the behaviour of code this PR touches or calls — verify against the target branch with mcp__azureDevOps__get_file_content when a finding depends on it.`,
        `Pass this warning to every analysis sub-agent.`,
      ];
  }
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
      // Declared because they are genuinely used — see the note on
      // `disallowedTools` below. They were previously absent while the agent
      // called `Write` 125 times, which is precisely the confusion this list is
      // supposed to prevent.
      'Write',
      'Edit',
      'mcp__azureDevOps__list_pull_requests',
      'mcp__azureDevOps__get_pull_request_changes',
      'mcp__azureDevOps__get_pull_request_comments',
      'mcp__azureDevOps__get_file_content',
      'mcp__azureDevOps__add_pull_request_comment',
      'mcp__azureDevOps__update_pull_request_comment',
      'mcp__azureDevOps__list_commits',
      ...lspTools,
    ],
    // `Write` and `Edit` are NOT denied, and that is deliberate. Neither is in
    // `allowedTools`, yet the orchestrator's recorded turns issued 125 `Write`
    // calls: it builds a scratch context file (`/tmp/pr<id>/CONTEXT.md`) and
    // hands its 7 sub-agents that path instead of inlining the whole PR context
    // into every dispatch — 929 recorded dispatches reference such a path.
    // Denying `Write` would break the review's context passing. `Agent` stays for
    // the same reason: fanning out IS this agent's design.
    //
    // Known gap, left open on purpose: 31 of those writes landed under the
    // checked-out repo rather than `/tmp`, and one overwrote a real source file.
    // A blanket deny cannot fix that without breaking the scratch-file pattern —
    // the right fix is a path-scoped PreToolUse hook, not a tool denial. That
    // hook must cover Bash as well: this agent keeps `Bash`, and `sed -i`, `>`
    // and `git checkout` write to the tree without going near Write or Edit.
    disallowedTools: ['NotebookEdit'],
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
        `## Working Tree`,
        ...workingTreeLines(params),
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
            : cherryPick.multiSourcePrIds?.length
              // Named, but plural: this port carries several already-merged changes.
              // Saying "could not be determined" here would send the model looking for
              // a source the description already gives it.
              ? `Original PRs: ${cherryPick.multiSourcePrIds.map((id) => `#${id}`).join(', ')} — this port carries work from more than one already-merged PR, so verify it against each of them.`
              : `Original PR: could not be determined from description — use commit messages to find the source.`,
          ``,
          `**Follow the Cherry-Pick Verification workflow in CLAUDE.md Phase 2.**`,
        );
      }

      const body = lines.filter(Boolean).join('\n');
      // Prepended, not appended: the model needs the titles it must reuse before
      // it starts naming findings. Omitted entirely when empty — an unconditional
      // heading over an empty table would assert prior findings that don't exist.
      return params.priorFindingsBlock ? `${params.priorFindingsBlock}\n\n${body}` : body;
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
