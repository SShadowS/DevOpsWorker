import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage, ReviewVerdict } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { CodeReviewSchema, type CodeReview } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { TOOL_SETS, TOOLS, MCP_TOOLS, azureDevOpsMcp, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Code Review Agent — independent review of generated code
// ---------------------------------------------------------------------------

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Exported for tests — buildPrompt is the §4.2 seam. */
export function createCodeReviewerConfig(config: PipelineConfig): AgentConfig<typeof CodeReviewSchema> {
  return {
    name: 'code-reviewer',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'repo-structure.md',
      'code-search.md',
      'al-investigation.md',
      'al-review-patterns.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
      'tdd.md',
    ],
    outputSchema: CodeReviewSchema,
    // Read-only FS + Bash (for git diff/log) + LSP + Task (for spawning subagents) + pipeline read
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, 'Bash', TOOLS.Task, ...MCP_TOOLS.pipelinesReadOnly],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.targetRepo,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const devPlan = state.devPlan!;
      const changeset = state.changeset!;
      const layout = ctx.config.layout;
      const allReviews = state.codeReviews ?? [];

      // Two windows, deliberately different sizes.
      //
      // The circuit breaker in CLAUDE.md Step 1 does a literal "last two entries"
      // check on domainAnalyses — widening that window would change what it
      // decides, so it stays at 2.
      const circuitBreakerHistory = allReviews.slice(-2).map((r) => ({
        verdict: r.verdict,
        domainAnalyses: (r as { domainAnalyses?: unknown }).domainAnalyses,
      }));

      // Prior findings, however, were being thrown away entirely: only verdict +
      // domainAnalyses survived, so round N+1 could not see what round N demanded.
      // Reviewers then contradicted each other across rounds — one round demanding
      // a change the next round objected to — and the loop could not converge.
      // Full history, not slice(-2): the observed oscillation spanned rounds 3–5,
      // i.e. straddling the old window edge. Critical + major only keeps it small.
      //
      // `state.codeReviews` is typed `ReviewVerdict[]` — the common minimum —
      // because pipeline.types.ts must not import agent output schemas. Every
      // entry in it was written by THIS agent's `applyOutput`, so it is a
      // CodeReview; narrow to the fields we need rather than widening the shared
      // type with a shape PlanReview does not have.
      const priorFindings = (allReviews as Array<ReviewVerdict & Partial<CodeReview>>)
        .map((r, i) => ({
          round: i + 1,
          verdict: r.verdict,
          issues: (r.issues ?? [])
            .filter((issue) => issue.severity === 'critical' || issue.severity === 'major')
            .map((issue) => ({
              severity: issue.severity,
              filePath: issue.filePath,
              category: issue.category,
              comment: issue.comment,
            })),
          revisionInstructions: r.revisionInstructions,
        }))
        .filter((r) => r.issues.length > 0 || r.revisionInstructions);

      return [
        `## Task`,
        `You are the code-reviewer orchestrator for work item #${ctx.workItemId}. Follow the orchestrator pattern in CLAUDE.md — spawn the 8 subagents in parallel and synthesize their findings.`,
        ``,
        `### LSP Warm-Up (MANDATORY FIRST ACTION)`,
        `Before doing ANY other work, verify that the AL Language Server is functional:`,
        `1. Call \`ToolSearch\` with query "LSP" to load the LSP tool schema`,
        `2. Use \`Glob\` with pattern \`${layout.source}/**/*.al\` to find an AL source file`,
        `3. Call \`LSP\` with operation \`documentSymbol\` on the first .al file found`,
        `4. Report: "LSP verified — [N] symbols found in [filename]" then proceed`,
        `5. If LSP fails, report the error and continue with text-based tools as fallback`,
        ``,
        `This step is non-negotiable. Skip it and your output will be rejected.`,
        `After this warm-up, use LSP for ALL subsequent AL code navigation.`,
        ``,
        `## Development Plan (what was intended)`,
        `${JSON.stringify(devPlan, null, 2)}`,
        ``,
        `## Changeset (what was implemented)`,
        `- **Branch:** ${changeset.branchName}`,
        `- **Files created:** ${changeset.filesCreated.join(', ') || '(none)'}`,
        `- **Files modified:** ${changeset.filesModified.join(', ') || '(none)'}`,
        `- **CI Result:** ${changeset.ciResult ?? 'not-run'}`,
        changeset.compilationErrors?.length
          ? `- **Compilation errors:** ${changeset.compilationErrors.join('; ')}`
          : '',
        ``,
        `## Prior Review History (for circuit-breaker evaluation)`,
        circuitBreakerHistory.length
          ? `${JSON.stringify(circuitBreakerHistory, null, 2)}`
          : `(none — this is the first iteration; devils-advocate mode defaults to blocking)`,
        ``,
        `## Prior Findings (critical + major, all rounds) — forward these to every sub-agent`,
        priorFindings.length
          ? [
              `${JSON.stringify(priorFindings, null, 2)}`,
              ``,
              `These are **context to be reconciled, not settled decisions.** A prior round`,
              `may itself have been mistaken — if you or a sub-agent concludes a previous`,
              `demand was wrong, say so explicitly in \`feedback\` rather than silently`,
              `re-asserting it. What you must NOT do is contradict a prior round without`,
              `noticing: demanding the reverse of round N-1 with no acknowledgement is the`,
              `failure this history exists to prevent.`,
              ``,
              `Pass this block to all 8 sub-agents as \`<PRIOR_FINDINGS>\`.`,
            ].join('\n')
          : `(none — first iteration. Pass \`<PRIOR_FINDINGS>\` as "none" to every sub-agent.)`,
        ``,
        `Proceed per the orchestrator procedure in your CLAUDE.md: circuit-breaker check, parallel spawn of 8 subagents, synthesis into CodeReview. Use \`git diff master...${changeset.branchName}\` in Step 1.`,
      ].join('\n');
    },
  };
}

export function codeReviewerStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createCodeReviewerConfig(config),
    canRun: (state) => state.changeset != null,
    applyOutput: (state, output: CodeReview) => ({
      ...state,
      codeReviews: [...(state.codeReviews ?? []), output],
    }),
  });
}
