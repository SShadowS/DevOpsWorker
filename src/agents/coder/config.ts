import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PipelineConfig, PipelineState, PipelineContext, Stage } from '../../types/pipeline.types.ts';
import type { AgentConfig } from '../../types/agent.types.ts';
import { ChangesetSchema, type Changeset } from './schema.ts';
import { agentStage } from '../../pipeline/stage.ts';
import { buildHumanFeedbackSection } from '../../pipeline/human-feedback.ts';
import { azureDevOpsMcp, TOOL_SETS, TOOLS, MCP_TOOLS, resolveAlLspPlugin, bcMcp, BC_MCP_TOOLS, alObjectIdNinjaMcp, OBJID_MCP_TOOLS } from '../../sdk/mcp-configs.ts';
import { findRepoByRepoKey } from '../../config/repos.ts';
import type { McpServerConfig } from '../../types/agent.types.ts';
import type { SdkPluginConfig, AgentDefinition as SdkAgentDefinition, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { CodeReview } from '../code-reviewer/schema.ts';

// ---------------------------------------------------------------------------
// Coding Agent — writes AL code according to the approved dev plan
// ---------------------------------------------------------------------------

interface CodeIssueOccurrence {
  key: string;
  reviewIndex: number;
}

/**
 * Build the revision section of the coder prompt with cumulative code-review
 * history, recurring-issue detection, and full reviewer suggestions /
 * revision instructions.
 */
export function buildCodeRevisionSection(state: PipelineState): string[] {
  const reviews = (state.codeReviews ?? []) as CodeReview[];
  if (reviews.length === 0) return [];

  const lastReview = reviews[reviews.length - 1]!;
  if (lastReview.verdict !== 'revise') return [];

  const parts: string[] = [];

  // ── Collect all issues with their review index for recurrence check ──
  const allOccurrences: CodeIssueOccurrence[] = [];
  for (let idx = 0; idx < reviews.length; idx++) {
    for (const issue of reviews[idx]!.issues) {
      const key = `${issue.filePath}::${issue.category}`;
      allOccurrences.push({ key, reviewIndex: idx });
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
    `## ⚠️ Code Review Feedback (attempt ${reviews.length + 1})`,
  );

  // ── Older reviews (compact — regression awareness) ──────────────────
  if (reviews.length > 1) {
    parts.push(``, `### Review History`);
    for (let idx = 0; idx < reviews.length - 1; idx++) {
      const r = reviews[idx] as CodeReview;
      parts.push(
        ``,
        `**Review ${idx + 1} issues (now resolved — do not regress):**`,
        ...r.issues.map(i => `- [${i.severity}] ${i.filePath}: ${i.comment}`),
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
    `**Issues to fix:**`,
    ...lastReview.issues.map(i => {
      const loc = i.line ? `${i.filePath}:${i.line}` : i.filePath;
      const line = `- [${i.severity}] ${loc}: ${i.comment}`;
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
    const key = `${i.filePath}::${i.category}`;
    return recurringKeys.has(key);
  });

  if (recurringIssues.length > 0) {
    parts.push(``, `**⚠️ RECURRING ISSUES (fix these permanently):**`);
    for (const i of recurringIssues) {
      const key = `${i.filePath}::${i.category}`;
      const indices = [...keyToReviewIndices.get(key)!].sort((a, b) => a - b);
      const reviewNums = indices.map(idx => idx + 1).join(', ');
      parts.push(`- (reviews ${reviewNums}) [${i.severity}] ${i.filePath}: ${i.comment}`);
    }
  }

  parts.push(
    ``,
    `Address ALL issues from the latest review, commit, push, and re-trigger CI. Do NOT re-introduce problems from earlier reviews.`,
  );

  return parts;
}

export function buildFixPrompt(state: PipelineState, workItemId: number): string {
  const changeset = state.changeset!;

  const parts = [
    `## Task`,
    `Fix a specific issue on the existing branch for work item #${workItemId}.`,
    ``,
    `## Existing Branch`,
    `The branch \`${changeset.branchName}\` already has a working implementation.`,
    `Check it out — do NOT create a new branch or re-implement from scratch.`,
    ``,
  ];

  // Human feedback goes FIRST — it's the primary instruction
  parts.push(...buildHumanFeedbackSection(state, 'coding'));

  // Code review history for context (preserved because resetState was skipped)
  parts.push(...buildCodeRevisionSection(state));

  parts.push(
    ``,
    `## Instructions`,
    `1. Check out the existing branch \`${changeset.branchName}\``,
    `2. Read the feedback carefully — understand exactly what needs fixing`,
    `3. Make the MINIMAL change needed to address the feedback`,
    `4. Do NOT rewrite, restructure, or re-implement existing code`,
    `5. Commit the fix with a descriptive message`,
    `6. Push the branch`,
    `7. Trigger the CI pipeline and monitor the result`,
    `8. If CI fails, fix the issues and retry`,
    `9. Report the final changeset (only the new changes from this fix)`,
  );

  return parts.join('\n');
}

export function buildFixTestPrompt(state: PipelineState, workItemId: number): string {
  const changeset = state.changeset!;
  const failures = state.humanFeedback?.testCaseFailures ?? [];

  const parts = [
    `## Task`,
    `Fix test case failures on the existing branch for work item #${workItemId}.`,
    ``,
    `## Existing Branch`,
    `The branch \`${changeset.branchName}\` already has a working implementation.`,
    `Check it out — do NOT create a new branch or re-implement from scratch.`,
    ``,
    `## Test Case Failures to Fix`,
    ``,
  ];

  for (const tc of failures) {
    parts.push(`### WI #${tc.testCaseId} (Test Case): ${tc.title}`);
    for (const step of tc.failedSteps) {
      parts.push(`- **Step ${step.stepNumber} FAILED**: ${step.action}`);
      if (step.expectedResult) {
        parts.push(`  - Expected: ${step.expectedResult}`);
      }
      if (step.comment) {
        parts.push(`  - Tester comment: "${step.comment}"`);
      }
    }
    parts.push(``);
  }

  // Include code review history for context
  parts.push(...buildCodeRevisionSection(state));

  parts.push(
    ``,
    `## Instructions`,
    `1. Check out the existing branch \`${changeset.branchName}\``,
    `2. Read the test case failures carefully — understand exactly what is broken`,
    `3. Use \`get_work_item\` to fetch full test case details if the failure comments are vague`,
    `4. Make the MINIMAL change needed to fix the failures`,
    `5. Do NOT rewrite, restructure, or re-implement existing code`,
    `6. Commit the fix with a descriptive message`,
    `7. Push the branch`,
    `8. Trigger the CI pipeline and monitor the result`,
    `9. If CI fails, fix the issues and retry`,
    `10. Report the final changeset (only the new changes from this fix)`,
  );

  return parts.join('\n');
}

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Model for the CI-waiter subagent. Cheap poller — Haiku by default, env-overridable. */
const CI_WAITER_MODEL = process.env.CI_WAITER_MODEL ?? 'claude-haiku-4-5';

/**
 * ci-waiter — a cheap Haiku subagent the coder delegates CI polling to.
 *
 * The coder triggers the build itself (so it owns the authoritative runId for
 * `changeset.ciRunId`), then hands the `--attach <runId>` command to this agent
 * via the Task tool. The poll loop (one fresh turn per ~100s `--attach`
 * round-trip) runs here on a tiny context instead of replaying the coder's large
 * Sonnet context every cycle — the whole reason CI waits used to be expensive.
 */
const ciWaiterAgent: SdkAgentDefinition = {
  description:
    'Waits for an Azure DevOps CI build to finish and reports PASSED/FAILED. Delegate the ' +
    '`await-pipeline.ts --attach <runId>` poll loop to this agent instead of polling inline.',
  model: CI_WAITER_MODEL,
  tools: [TOOLS.Bash],
  maxTurns: 80,
  prompt: [
    'You wait for a single Azure DevOps CI build to finish, then report the outcome. Nothing else.',
    '',
    'Your task message gives you a CI run id. Build the command:',
    '  bun /app/scripts/await-pipeline.ts --attach <runId> --timeout 100 --waiter',
    'The `--waiter` flag is MANDATORY — it is the sentinel that authorizes you (and only you)',
    'to poll. Every command you run MUST include `--waiter`.',
    '',
    'Procedure:',
    '1. Run that command (Bash timeout 600000ms).',
    '2. Act on its EXIT CODE:',
    '   - exit 0 → the build SUCCEEDED. Stop.',
    '   - exit 1 → the build FAILED. Capture the printed failure-log excerpt. Stop.',
    '   - exit 2 → still in progress. The output prints the exact re-run command (it already',
    '     includes `--waiter`) — run that exact command again. Repeat from step 2.',
    '   - exit 3 → configuration error. Stop and report it verbatim.',
    '3. NEVER `sleep`. NEVER re-run with `--branch` (that starts a duplicate build). Only ever',
    '   re-run the exact `--attach ... --waiter` command the script prints.',
    '',
    'When done, your FINAL message must be exactly one of:',
    '  RESULT: PASSED runId=<id>',
    '  RESULT: FAILED runId=<id>',
    'followed (for FAILED) by the key error lines from the failure log. Do not add commentary.',
  ].join('\n'),
};

/**
 * Pure guard: decide whether a Bash command is a forbidden inline CI poll/trigger.
 * The coder must trigger via `--trigger-only` and delegate the WAIT to the ci-waiter
 * subagent; only the subagent may `--attach` (it carries the `--waiter` sentinel).
 * Prompting alone did not get the subagent used (the coder inline-polled anyway), so
 * this is enforced deterministically by a PreToolUse hook.
 */
export function ciWaiterGuard(command: string): { deny: false } | { deny: true; reason: string } {
  if (!command.includes('await-pipeline')) return { deny: false };
  if (command.includes('--attach') && !command.includes('--waiter')) {
    return {
      deny: true,
      reason:
        'Do NOT poll CI inline. Trigger with `await-pipeline.ts --branch <branch> --trigger-only` ' +
        '(it prints runId=<id> and exits), then delegate the wait to the ci-waiter subagent: ' +
        'Task(subagent_type: "ci-waiter", prompt with `await-pipeline.ts --attach <id> --timeout 100 --waiter`). ' +
        'The subagent does ALL --attach polling — you never run --attach yourself.',
    };
  }
  if (command.includes('--branch') && !command.includes('--trigger-only')) {
    return {
      deny: true,
      reason:
        'Do NOT trigger-and-wait inline. Use `await-pipeline.ts --branch <branch> --trigger-only` to ' +
        'trigger (it returns runId=<id> and exits 0), then hand that runId to the ci-waiter subagent via Task.',
    };
  }
  return { deny: false };
}

// ---------------------------------------------------------------------------
// File-operation guard — deny bash file-ops that have a dedicated tool.
//
// The coder's CLAUDE.md already tells it to use Glob/Grep/Read/jq/branch-diff
// instead of bash `ls`/`find`/`grep`/`cat`/`head`/`tail`/inline-python/`git diff
// master...`. Prompting alone failed (one real run made ~57 bash file-ops),
// burning expensive Sonnet context with noisy shell output. Same fix that got
// the ci-waiter subagent used: a deterministic PreToolUse(Bash) deny that feeds
// the exact replacement back to the model.
//
// Correctness hinges on PRIMARY-vs-PIPE: `cat file` (bash reading the repo) is
// denied, but `git log | cat` / `az ... | grep` (filtering another command's
// output — no dedicated-tool equivalent) is allowed. So we tokenize: split the
// command on top-level `&& || ; \n` (quote-aware), and within each segment look
// only at the FIRST pipe stage's primary command. Anything after a `|` is a
// filter and passes. Conservative: when unsure, ALLOW (a false deny wedges the
// agent in a retry loop, which is worse than missing one bash call).
// ---------------------------------------------------------------------------

/** Split a command line on top-level `&&`/`||`/`;`/newline, ignoring operators
 *  inside single/double quotes (so `git commit -m "a && b"` stays one segment). */
function splitSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';') { segs.push(cur); cur = ''; continue; }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      segs.push(cur); cur = ''; i++; continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}

/** Split a single segment into pipe stages on top-level `|` (quote-aware).
 *  `||` is already consumed at the segment level, so only single pipes remain. */
function splitPipes(seg: string): string[] {
  const stages: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '|') { stages.push(cur); cur = ''; continue; }
    cur += c;
  }
  stages.push(cur);
  return stages.map(s => s.trim()).filter(Boolean);
}

/** First real command token of a pipe stage, stripping leading `VAR=val` env
 *  assignments and harmless prefixes (`sudo`/`command`/`time`/`nohup`). */
function primaryToken(stage: string): { cmd: string; rest: string } {
  let s = stage.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  s = s.replace(/^(?:sudo|command|time|nohup)\s+/, '');
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return { cmd: m?.[1] ?? '', rest: m?.[2] ?? '' };
}

const READ_UTILS = new Set(['cat', 'head', 'tail']);
const GREP_UTILS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

/** Classify a single command token + its stage text. Returns a deny reason or null. */
function classifyUtil(cmd: string, stage: string, cdWarn: string): string | null {
  if (cmd === 'ls') {
    return `Do not list files with bash \`ls\`. Use the Glob tool: Glob {pattern:"<dir>/*"}.${cdWarn}`;
  }
  if (READ_UTILS.has(cmd)) {
    return `Do not read files with bash \`${cmd}\`. Use the Read tool: Read {file_path:"<path>"}.${cdWarn}`;
  }
  if (GREP_UTILS.has(cmd)) {
    return `Do not text-search with bash \`${cmd}\`. Use the Grep tool: Grep {pattern:"...", path:"..."}. For AL code navigation prefer LSP.${cdWarn}`;
  }
  if (cmd === 'find') {
    // `find ... -exec/-delete/-ok` is an ACTION, not a search — allow it.
    if (/\s-(?:exec(?:dir)?|delete|ok)\b/.test(stage)) return null;
    return `Do not search files with bash \`find\`. Use the Glob tool: Glob {pattern:"**/*.al"}.${cdWarn}`;
  }
  if (cmd === 'python' || cmd === 'python3') {
    if (/\s-c\b/.test(stage) && /json/i.test(stage)) {
      return `Do not parse JSON with inline python. Use \`jq\` (e.g. jq -r '.application' app.json); for saved MCP result files use \`bun scripts/parse-mcp.ts <file>\`.`;
    }
    return null;
  }
  if (cmd === 'git' && /\bdiff\b/.test(stage) && /(?:master|main|origin\/\S+)\.\.\./.test(stage)) {
    return `Do not run \`git diff <ref>...\` — the shell mangles \`#\` in branch names. Use \`bun scripts/branch-diff.ts <branch>\` (handles the quoting and local-vs-origin).`;
  }
  return null;
}

/**
 * Pure guard: decide whether a Bash command is a file-op that should go through
 * a dedicated tool (Glob/Grep/Read/jq/branch-diff) instead. Denies only the
 * PRIMARY command of each `&&`/`||`/`;`-separated segment; post-pipe filters and
 * `find -exec/-delete` actions are allowed. Conservative — unknown shapes pass.
 */
export function fileOpGuard(command: string): { deny: false } | { deny: true; reason: string } {
  // ci-poll commands are owned by ciWaiterGuard — never touch them here.
  if (command.includes('await-pipeline')) return { deny: false };
  const cdWarn = /(?:^|\s|&&|;)\s*cd\s/.test(command)
    ? ' NOTE: the `cd` in this command did NOT execute — pass the full/correct path to the tool.'
    : '';

  for (const seg of splitSegments(command)) {
    const stages = splitPipes(seg);
    if (stages.length === 0) continue;

    // Primary = first stage's command.
    const first = primaryToken(stages[0]!);
    const reason = classifyUtil(first.cmd, stages[0]!, cdWarn);
    if (reason) return { deny: true, reason };

    // `... | xargs cat` / `... | xargs grep` reads files through xargs — treat the
    // util after xargs as primary (read-utils only; `xargs rm` etc. stay allowed).
    for (const stage of stages) {
      const p = primaryToken(stage);
      if (p.cmd !== 'xargs') continue;
      const x = primaryToken(p.rest);
      if (READ_UTILS.has(x.cmd) || GREP_UTILS.has(x.cmd) || x.cmd === 'ls') {
        const r = classifyUtil(x.cmd, x.cmd + ' ' + x.rest, cdWarn);
        if (r) return { deny: true, reason: r };
      }
    }
  }
  return { deny: false };
}

/** PreToolUse(Bash) matcher wrapping fileOpGuard into the SDK hook shape. */
const fileOpGuardHook: HookCallbackMatcher = {
  matcher: 'Bash',
  hooks: [
    async (input) => {
      const cmd = (input as { tool_input?: { command?: unknown } }).tool_input?.command;
      if (typeof cmd !== 'string') return { continue: true };
      const verdict = fileOpGuard(cmd);
      if (verdict.deny) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason,
          },
        };
      }
      return { continue: true };
    },
  ],
};

/** PreToolUse(Bash) matcher wrapping ciWaiterGuard into the SDK hook shape. */
const ciWaiterGuardHook: HookCallbackMatcher = {
  matcher: 'Bash',
  hooks: [
    async (input) => {
      const cmd = (input as { tool_input?: { command?: unknown } }).tool_input?.command;
      if (typeof cmd !== 'string') return { continue: true };
      const verdict = ciWaiterGuard(cmd);
      if (verdict.deny) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason,
          },
        };
      }
      return { continue: true };
    },
  ],
};

export function createCoderConfig(config: PipelineConfig): AgentConfig<typeof ChangesetSchema> {
  return {
    name: 'coder',
    useClaudeCodePreset: true,
    agentSourceDir: AGENT_DIR,
    sharedPromptFragments: [
      'project-context.md',
      'repo-structure.md',
      'code-search.md',
      'al-investigation.md',
      'branch-naming.md',
      'al-review-patterns.md',
      'lsp-reinforcement.md',
      'dependencies-folder.md',
      'sdd.md',
      'tdd.md',
    ],
    outputSchema: ChangesetSchema,
    allowedTools: [...TOOL_SETS.fsAndBashWithLSP, TOOLS.Task, ...MCP_TOOLS.zendeskReadOnly, ...MCP_TOOLS.pipelinesWithTrigger, ...MCP_TOOLS.workItemRead, ...BC_MCP_TOOLS, ...OBJID_MCP_TOOLS],
    plugins: [resolveAlLspPlugin()].filter(Boolean) as SdkPluginConfig[],
    agents: { 'ci-waiter': ciWaiterAgent },
    hooks: { PreToolUse: [ciWaiterGuardHook, fileOpGuardHook] },
    mcpServers: (state: PipelineState) => {
      const servers: Record<string, McpServerConfig> = {
        azureDevOps: azureDevOpsMcp(config),
        'al-object-id-ninja': alObjectIdNinjaMcp(),
      };
      if (state.environment) {
        const bc = bcMcp(state.environment);
        if (bc) servers['business-central'] = bc;
      }
      return servers;
    },
    maxTurns: 200,  // Opus is more efficient but needs headroom for CI iteration loops
    cwd: config.paths.sessionRoot,

    buildPrompt(state: PipelineState, ctx: PipelineContext): string {
      if (state.rerunMode === 'fix') {
        return buildFixPrompt(state, ctx.workItemId);
      }

      if (state.rerunMode === 'fix-test') {
        return buildFixTestPrompt(state, ctx.workItemId);
      }

      const devPlan = state.devPlan!;
      const repoKey = ctx.config.repoKey;
      const layout = ctx.config.layout;

      const branchPrefix = ctx.workItemType === 'Bug' ? 'bug' : 'userstory';

      const parts = [
        `## Task`,
        `Implement the approved development plan for work item #${ctx.workItemId}.`,
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
        `## Branch Naming`,
        `Create branch: \`${branchPrefix}/#${ctx.workItemId}-<short-description>\` from \`master\``,
        ``,
        `## Development Plan`,
        `${JSON.stringify(devPlan, null, 2)}`,
        ``,
        `## CI Pipeline (trigger, then delegate the wait — enforced by a hook)`,
        `You do NOT wait for CI yourself. A PreToolUse hook BLOCKS any inline \`await-pipeline --attach\` and any \`--branch\` without \`--trigger-only\` — so the only path that works is:`,
        `1. **Trigger only:** \`bun scripts/await-pipeline.ts --branch <your-branch> --trigger-only\` (pipeline ${config.azureDevOps.ciPipelineId}). It triggers the build, prints \`runId=<id>\`, and exits 0 immediately (it does NOT print a runnable poll command). Capture \`<id>\` — your authoritative CI run id; report it as \`ciRunId\`.`,
        `2. **Delegate the wait:** call the \`Task\` tool with \`subagent_type: "ci-waiter"\`, passing the \`runId\` in the prompt (e.g. "Wait for CI run <id> and report the outcome."). The cheap Haiku subagent polls the build to completion and returns \`RESULT: PASSED runId=<id>\` or \`RESULT: FAILED runId=<id>\` (plus error lines). It is blocking — you get the result, then continue.`,
        `3. **Act on the result:** if PASSED, record \`ciResult: 'passed'\` and \`ciRunId: <id>\`. If FAILED, read the returned errors, fix the code, commit, push, and repeat from step 1 (a NEW build → a NEW runId).`,
        `- Do NOT try to \`--attach\` yourself or \`sleep\` — the hook will deny it. \`--trigger-only\` is the ONLY way you start a build; the ci-waiter subagent does ALL waiting.`,
        `- **Parse existing results:** \`bun scripts/parse-mcp.ts <file> errors\` for previously saved pipeline timeline files.`,
        ``,
        `## Instructions`,
        `1. Create the feature branch from master`,
        `2. Implement ALL changes described in the plan`,
        `3. Production code goes in ${repoKey}/${layout.source}/, test code in ${repoKey}/${layout.test}/`,
        `4. Commit all changes with a descriptive message`,
        `5. Push the branch`,
        `6. Trigger the CI pipeline and monitor the result`,
        `7. If CI fails, fix the issues and retry`,
        `8. Report the final changeset`,
      ];

      parts.push(...buildCodeRevisionSection(state));
      parts.push(...buildHumanFeedbackSection(state, 'coding'));

      // Add environment info if available
      if (state.environment) {
        const envConfig = config.environment;
        // The env CLI is invoked by name on PATH inside the container (the entrypoint
        // sets ENV_CLI to the baked binary, read in cli/config.ts). The on-PATH
        // fallback (NOT the Windows `.tools/env-cli.exe`) avoids handing the agent a
        // path that cannot run in the Linux container if envCli is ever unset.
        const cliPath = envConfig?.envCli ?? 'env-cli';
        const appPaths = envConfig?.appPaths ?? [`${repoKey}/${layout.appRoot}`, `${repoKey}/${layout.testAppRoot}`];

        parts.push(
          ``,
          `## BC Test Environment`,
          `- **Environment ID:** ${state.environment.envId}`,
          `- **Environment URL:** ${state.environment.url}`,
          `- **Environment CLI:** ${cliPath}`,
          `- **App dependency order:** ${appPaths.join(', ')}`,
          ``,
          `## Deploy & Test Workflow`,
          `After coding and committing, deploy and test on the BC environment.`,
          `**Note:** env-provision has already installed deps + deployed the product app baseline from \`master\` and run core activation. You only need to upgrade with your branch changes.`,
          `1. Check env status: \`${cliPath} env get ${state.environment.envId} --json\``,
          `2. If status is not "Running", poll every 15s until ready`,
          `3. Deploy your branch (upgrades the existing app): \`${cliPath} deploy ${state.environment.envId} ${repoKey}/${layout.appRoot} --json\``,
          `4. Deploy test code: \`${cliPath} deploy ${state.environment.envId} ${repoKey}/${layout.testAppRoot} --json\``,
          `5. Run task-specific tests: \`${cliPath} test run ${state.environment.envId} <codeunitId>\``,
          `6. If tests fail, fix code, re-deploy, and re-test until green`,
          `7. Then trigger the CI pipeline as final validation`,
          ``,
          `**Recovery:** If deploy fails with "missing symbols" or similar, run \`${cliPath} deps install ${state.environment.envId} <appPath> --json\` and \`${cliPath} deps download ${state.environment.envId} <appPath> --json\` for the affected app, then retry deploy.`,
          ``,
          `**Important:** Run deploy commands from the session root directory, not from inside ${repoKey}/.`,
          `**Important:** BC does not support parallel test jobs. Run tests sequentially.`,
          `**Fallback:** If the environment fails to reach Running status within 20 minutes, skip env testing and proceed with CI-only validation.`,
        );

        // Wizard reference — coder runs the wizard during its first iteration when
        // state.environment.activated is false, AND optionally during OnInstall
        // recovery (uninstall + reinstall to re-fire OnInstall). The instructions
        // are surfaced regardless of activation state so coder always has them.
        const repo = findRepoByRepoKey(ctx.config.repoKey)?.config;
        if (repo?.envProvision?.wizard?.instructions) {
          const isActivated = state.environment?.activated === true;
          parts.push(
            ``,
            `## BC Setup Wizard Reference`,
            isActivated
              ? `Wizard already run on this env (\`state.environment.activated === true\`). Reference only — re-run via bc-mcp if you uninstall the product app for OnInstall recovery.`
              : `Wizard NOT yet run on this env (\`state.environment.activated === false\`). Run it via bc-mcp tools after your first env deploy, before running env tests. See the environment instructions in your CLAUDE.md.`,
            ``,
            `Wizard instructions (from RepoConfig):`,
            repo.envProvision.wizard.instructions,
            ``,
            `Tools: \`bc_search_pages\` to find the wizard page, \`bc_open_page\` to open, \`bc_read_data\` / \`bc_write_data\` / \`bc_execute_action\` / \`bc_respond_dialog\` to drive it, \`bc_close_page\` to close.`,
            `When done, set \`wizardActivated: true\` in your output if you ran the wizard successfully (or it was already complete).`,
          );
        }
      }

      return parts.join('\n');
    },
  };
}

/**
 * Apply coder agent output to pipeline state.
 * - Stores the changeset.
 * - Clears revision/feedback flags.
 * - Flips state.environment.activated to true if coder reported wizardActivated:true.
 * - Leaves state.environment.activated alone if wizardActivated is undefined or false
 *   (so prior activation state is preserved across iterations).
 */
export function applyCoderOutput(state: PipelineState, output: Changeset): PipelineState {
  const next: PipelineState = {
    ...state,
    changeset: output,
    humanFeedback: undefined,
    rerunMode: undefined,
  };
  if (output.wizardActivated === true && state.environment) {
    next.environment = { ...state.environment, activated: true };
  }
  return next;
}

export function coderStage(config: PipelineConfig): Stage {
  return agentStage({
    agent: createCoderConfig(config),
    canRun: (state) => state.devPlan != null,
    applyOutput: applyCoderOutput,
  });
}
