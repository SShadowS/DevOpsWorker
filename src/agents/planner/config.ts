import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { DevPlanSchema, type DevPlan } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { buildHumanFeedbackSection } from '../../pipeline/human-feedback.ts';
import { azureDevOpsMcp, TOOL_SETS, MCP_TOOLS, resolveAlLspPlugin } from '../../sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { PlanReview } from '../plan-reviewer/schema.ts';

// ---------------------------------------------------------------------------
// Planning Agent — produces a structured dev plan
// ---------------------------------------------------------------------------

interface IssueOccurrence {
  key: string;
  reviewIndex: number;
  issue: { severity: string; category: string; description: string; suggestion: string; relatedObject?: string };
}

/**
 * Build the revision section of the planner prompt with cumulative review
 * history, the previous plan, recurring-issue detection, and full
 * reviewer suggestions / revision instructions.
 */
export function buildRevisionSection(state: PipelineState): string[] {
  const reviews = (state.planReviews ?? []) as PlanReview[];
  if (reviews.length === 0) return [];

  const lastReview = reviews[reviews.length - 1]!;
  if (lastReview.verdict !== 'revise') return [];

  const parts: string[] = [];

  // ── Previous plan (so the planner can iterate, not rebuild) ──────────
  if (state.devPlan) {
    parts.push(
      ``,
      `## Your Previous Plan`,
      `\`\`\`json`,
      JSON.stringify(state.devPlan, null, 2),
      `\`\`\``,
    );
  }

  // ── Collect all issues with their review index for recurrence check ──
  const allOccurrences: IssueOccurrence[] = [];
  for (let idx = 0; idx < reviews.length; idx++) {
    for (const issue of reviews[idx]!.issues) {
      const key = `${issue.relatedObject ?? ''}::${issue.category}`;
      allOccurrences.push({ key, reviewIndex: idx, issue });
    }
  }

  // Keys that appear in 2+ distinct reviews
  const keyToReviewIndices = new Map<string, Set<number>>();
  for (const occ of allOccurrences) {
    if (!keyToReviewIndices.has(occ.key)) keyToReviewIndices.set(occ.key, new Set());
    keyToReviewIndices.get(occ.key)!.add(occ.reviewIndex);
  }
  const recurringKeys = new Set(
    [...keyToReviewIndices.entries()]
      .filter(([, indices]) => indices.size >= 2)
      .map(([key]) => key),
  );

  parts.push(
    ``,
    `## ⚠️ Revision Required (attempt ${reviews.length + 1})`,
  );

  // ── Older reviews (compact — regression awareness) ──────────────────
  if (reviews.length > 1) {
    parts.push(``, `### Review History`);
    for (let idx = 0; idx < reviews.length - 1; idx++) {
      const r = reviews[idx] as PlanReview;
      parts.push(
        ``,
        `**Review ${idx + 1} issues (now resolved — do not regress):**`,
        ...r.issues.map(i => `- [${i.severity}] ${i.description}`),
      );
    }
  }

  // ── Latest review (full detail) ─────────────────────────────────────
  const reviewNum = reviews.length;
  parts.push(
    ``,
    `### Latest Review (Review ${reviewNum})`,
    `**Feedback:** ${lastReview.feedback}`,
    ``,
    `**Issues to address:**`,
    ...lastReview.issues.map(i => {
      const line = `- [${i.severity}] ${i.description}`;
      const fix = i.suggestion ? `\n  → Fix: ${i.suggestion}` : '';
      return `${line}${fix}`;
    }),
  );

  if (lastReview.revisionInstructions) {
    parts.push(
      ``,
      `**Revision Instructions:**`,
      lastReview.revisionInstructions,
    );
  }

  // ── Recurring issues ────────────────────────────────────────────────
  const recurringIssues = lastReview.issues.filter(i => {
    const key = `${i.relatedObject ?? ''}::${i.category}`;
    return recurringKeys.has(key);
  });

  if (recurringIssues.length > 0) {
    parts.push(``, `**⚠️ RECURRING ISSUES (fix these permanently):**`);
    for (const i of recurringIssues) {
      const key = `${i.relatedObject ?? ''}::${i.category}`;
      const indices = [...keyToReviewIndices.get(key)!].sort((a, b) => a - b);
      const reviewNums = indices.map(idx => idx + 1).join(', ');
      parts.push(`- (reviews ${reviewNums}) [${i.severity}] ${i.description}`);
    }
  }

  parts.push(
    ``,
    `Revise the plan to address ALL issues from the latest review. Do NOT re-introduce problems from earlier reviews.`,
  );

  return parts;
}

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

function createPlannerConfig(config: PipelineConfig): AgentConfig<typeof DevPlanSchema> {
  return {
    name: 'planner',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'ado-reference-syntax.md',
      'repo-structure.md',
      'code-search.md',
      'al-investigation.md',
      'branch-naming.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
      'tdd.md',
    ],
    outputSchema: DevPlanSchema,
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP, ...MCP_TOOLS.zendeskReadOnly, ...MCP_TOOLS.pipelinesReadOnly],
    disallowedTools: ['Bash'],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    mcpServers: {
      azureDevOps: azureDevOpsMcp(config),
    },
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      const readiness = state.readiness!;
      const repoKey = ctx.config.repoKey;
      const layout = ctx.config.layout;

      const parts = [
        `## Working Directory`,
        `Your cwd is the session root. The target extension repo is \`${repoKey}/\`.`,
        `- Production code: \`${repoKey}/${layout.source}/\``,
        `- Test code: \`${repoKey}/${layout.test}/\``,
        `- Companion repos (read-only): available as sibling directories`,
        ``,
        `## Task`,
        `Create a detailed development plan for work item #${ctx.workItemId}.`,
        ``,
        `## Enriched Context (from Analyzer)`,
        `${JSON.stringify(readiness.enrichedContext, null, 2)}`,
        ``,
        `## Instructions`,
        ``,
        `### Step 0 — LSP Warm-Up (MANDATORY FIRST ACTION)`,
        `Before doing ANY other work, verify that the AL Language Server is functional:`,
        `1. Call \`ToolSearch\` with query "LSP" to load the LSP tool schema`,
        `2. Use \`Glob\` with pattern \`${repoKey}/${layout.source}/**/*.al\` (or \`**/Cloud/Al/**/*.al\` from session root) to find an AL source file`,
        `3. Call \`LSP\` with operation \`documentSymbol\` on the first .al file found`,
        `4. Report: "LSP verified — [N] symbols found in [filename]" then proceed`,
        `5. If LSP fails, report the error and continue with text-based tools as fallback`,
        ``,
        `This step is non-negotiable. Skip it and your output will be rejected.`,
        `After this warm-up, use LSP for ALL subsequent AL code navigation (see .claude/rules/USE-AL-LSP-TOOLS.md).`,
        ``,
        `### Steps 1-5 — Plan Creation`,
        `1. Search the codebase to understand existing patterns`,
        `2. Identify which AL objects need creation or modification`,
        `3. Design test scenarios that cover the acceptance criteria`,
        `4. Assess risk (shared tables, integration points, breaking changes)`,
        `5. Produce a structured DevPlan`,
      ];

      parts.push(...buildRevisionSection(state));
      parts.push(...buildHumanFeedbackSection(state, 'planning'));

      return parts.join('\n');
    },
  };
}

export function plannerStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createPlannerConfig(config),
    canRun: (state) => state.readiness != null && state.readiness.verdict === 'proceed',
    applyOutput: (state, output: DevPlan) => ({
      ...state,
      devPlan: output,
      humanFeedback: undefined,
    }),
  });
}
