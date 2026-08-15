import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { ReflectionOutputSchema } from './schema.ts';
import { azureDevOpsMcp, TOOLS } from '../../sdk/mcp-configs.ts';

// ---------------------------------------------------------------------------
// Reflection Agent — reads a month of human responses to the PR reviewer's
// findings and proposes at most three prompt changes. Read-only by design: it
// changes no files, posts no comments, and its structured output is the whole
// product of the run (see its CLAUDE.md).
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

export interface ReflectionParams {
  /**
   * Every disputed finding in the window plus its full body, pre-queried and
   * rendered by the `reflect` CLI (`buildLearningSetBlock`) — this agent has no
   * SQL access, so this is its only channel onto `finding_outcomes`. Injected
   * verbatim; the block carries its own heading and coverage counts.
   */
  learningSetBlock: string;
  /**
   * The reviewer's current prompt file paths (core and, when an overlay is
   * mounted, the overlay append file) plus a note that both are readable under
   * `/app/src/agents/` and `/app/private/agents/`. Injected verbatim.
   */
  promptFilesBlock: string;
  windowDays: number;
  /** YYYY-MM-DD anchor of this cycle. */
  cycleDate: string;
  /**
   * Prior proposals' `proposedChanges` + `status`, when the CLI has any to show
   * (decision (d): a change a human already rejected must not be re-proposed
   * unchanged). Optional — a cycle with no prior proposals omits the section
   * entirely rather than heading an empty block.
   */
  priorProposalsBlock?: string;
}

export function createReflectionConfig(
  config: PipelineConfig,
  params: ReflectionParams,
): AgentConfig<typeof ReflectionOutputSchema> {
  return {
    name: 'reflection',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [],
    outputSchema: ReflectionOutputSchema,

    // Additive, not a TOOL_SETS entry minus something: a set this agent
    // subtracts from would hand it write access the day someone adds a tool to
    // that set, silently. Read/Grep/Glob for the prompt files under
    // /app/src/agents and /app/private/agents; WebFetch/WebSearch for platform
    // documentation (the evidence a `reviewer-wrong`/`human-wrong` verdict
    // needs); the five ADO tools are read-only lookups for verifying a
    // disputed finding against the code or PR that produced it.
    allowedTools: [
      TOOLS.Read,
      TOOLS.Grep,
      TOOLS.Glob,
      TOOLS.WebFetch,
      TOOLS.WebSearch,
      'mcp__azureDevOps__search_code',
      'mcp__azureDevOps__get_file_content',
      'mcp__azureDevOps__get_repository_details',
      'mcp__azureDevOps__list_pull_requests',
      'mcp__azureDevOps__get_pull_request_changes',
    ],
    // THIS is what actually keeps the agent read-only. `allowedTools` is only
    // the SDK's auto-approve-without-prompting list: `runAgent` passes
    // `permissionMode: 'bypassPermissions'` and no `tools:` option, so the
    // claude_code preset's full default tool set stays reachable regardless of
    // what `allowedTools` names — the same finding `tests/agents/tool-scoping.
    // test.ts` pins from production telemetry (pr-reviewer called Write 125
    // times and analyzer called Agent 24 times, neither having listed them).
    //
    // Write/Edit/NotebookEdit/Bash: this agent's whole output is the
    // structured proposal — its CLAUDE.md is explicit that it changes no
    // files, and Bash would also let it read past the prompt's scoped
    // learning-set query straight against the database or the repo.
    //
    // Agent/Task/Workflow/REPL: no sub-agent definitions exist here and none
    // are needed — this is a single read-and-adjudicate pass, not a fan-out
    // review. All four are denied together because they are four names for
    // the same capability (Workflow scripts agent()/parallel()/pipeline()
    // calls; REPL runs arbitrary JavaScript with persistent state that can
    // reach the other three) — cherry-pick-reviewer denies the same four for
    // the same reason, and closing only the obvious two would leave the
    // fan-out cost blowup the seven-sub-agent full review pays for one call
    // away. REPL is additionally required of every read-only agent in this
    // codebase on an asymmetry argument (`tests/agents/tool-scoping.test.ts`):
    // its sandbox is unestablished, so denying it is cheap insurance against
    // an unverified write route rather than proof one exists.
    //
    // The four ADO writes: this agent must never post to a PR, edit a work
    // item, or open one — its proposal is reviewed and applied by a human
    // (Task 6), never by this run.
    disallowedTools: [
      'Write', 'Edit', 'NotebookEdit', 'Bash',
      'Agent', 'Task', 'Workflow', 'REPL',
      'mcp__azureDevOps__add_pull_request_comment',
      'mcp__azureDevOps__update_pull_request_comment',
      'mcp__azureDevOps__update_work_item',
      'mcp__azureDevOps__create_pull_request',
    ],
    mcpServers: { azureDevOps: azureDevOpsMcp(config) },
    cwd: config.paths.sessionRoot,

    buildPrompt(_state: PipelineState, _ctx: PipelineContext): string {
      // `null` marks a section that does not apply and is dropped; `''` is a
      // real blank line and survives — same convention cherry-pick-reviewer's
      // buildPrompt uses, so a filter on truthiness doesn't collapse the two
      // and run sections together.
      const lines: (string | null)[] = [
        `## Task`,
        `Reflect on human responses to the PR reviewer's findings over the last ${params.windowDays} days, anchored at ${params.cycleDate}. Produce a proposal per your CLAUDE.md — you change no files, post no comments, and write nothing anywhere; your structured output is the entire product of this run.`,
        ``,
        `## Cycle`,
        `- **Window:** last ${params.windowDays} days`,
        `- **Cycle date:** ${params.cycleDate}`,
        ``,
        params.learningSetBlock,
        ``,
        params.promptFilesBlock,
        params.priorProposalsBlock ? `` : null,
        params.priorProposalsBlock ? `## Prior proposals` : null,
        params.priorProposalsBlock ?? null,
      ];

      return lines.filter((l): l is string => l !== null).join('\n');
    },
  };
}
