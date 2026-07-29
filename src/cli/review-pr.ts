import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { runPRReview } from '../agents/pr-reviewer/config.ts';
import type { PRFinding } from '../agents/pr-reviewer/schema.ts';
import { findRepoByRepositoryId } from '../config/repos.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { connectStores } from '../db/connect-stores.ts';
import { notifyPipelineError } from '../sdk/discord-notify.ts';
import { PipelineLogger } from '../sdk/pipeline-logger.ts';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import {
  fetchReviewThreadsRaw,
  postInlineThread,
  updateThreadComment,
  appendToThread,
  type ReviewThread,
} from '../sdk/ado/pull-requests.ts';
import { reconcileFindings } from '../sdk/ado/reconcile-findings.ts';
import { extractKey, findingKey, FINDING_MARKER_RE, markerFor } from '../sdk/ado/finding-key.ts';

export function makeReviewRunId(prId: number): string {
  return `pr-${prId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * EVAL-ONLY: rewrite the pinned `model:` frontmatter in every pr-reviewer
 * sub-agent definition so the requested model actually takes effect.
 *
 * The 7 sub-agents under `src/agents/pr-reviewer/.claude/agents/*.md` pin
 * `model: opus` in their frontmatter, which wins over the orchestrator's
 * `ANTHROPIC_MODEL` default. Without rewriting them, the opus-vs-sonnet A/B
 * arm measures nothing — every sub-agent stays on opus regardless.
 *
 * Guarded so this is a TRUE NO-OP unless `PR_REVIEW_SUBAGENT_MODEL` is set and
 * non-empty. Production PR reviews never set it, so their pinned models stay.
 *
 * Rewriting in the ephemeral container at startup is fine — the image bakes
 * fresh copies of these files on every run. The dir is resolved relative to
 * this module (mirroring config.ts's AGENT_DIR derivation) so it works both
 * in-container (`/app/...`) and locally.
 *
 * Returns the number of files modified (0 when the env var is unset).
 */
export function maybeOverrideSubAgentModel(): number {
  const model = process.env['PR_REVIEW_SUBAGENT_MODEL'];
  if (!model || model.trim() === '') return 0; // no-op by default

  const cliDir = dirname(fileURLToPath(import.meta.url));
  const agentsDir = resolve(cliDir, '..', 'agents', 'pr-reviewer', '.claude', 'agents');
  if (!existsSync(agentsDir)) {
    console.log(`[eval] PR_REVIEW_SUBAGENT_MODEL set but sub-agent dir not found at ${agentsDir} — skipping`);
    return 0;
  }

  let modified = 0;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(agentsDir, file);
    const content = readFileSync(path, 'utf-8');
    // Only touch files that already pin a `model:` frontmatter line.
    if (!/^model:\s*\S+/m.test(content)) continue;
    const updated = content.replace(/^model:\s*\S+/m, `model: ${model}`);
    if (updated !== content) {
      writeFileSync(path, updated);
      modified++;
    }
  }

  console.log(`[eval] overrode sub-agent model → ${model} in ${modified} files`);
  return modified;
}

/**
 * The tool-discipline block injected by `maybeInjectToolRule`.
 *
 * Framed as routing ("use X for Y"), never as prohibition. Negative framing has
 * been measured on this codebase to backfire — telling an agent what NOT to do
 * suppresses the tool entirely rather than redirecting it.
 */
export const SUBAGENT_TOOL_RULE = `
## Reading code — use the right tool

You have \`Read\`, \`Grep\`, \`Glob\` and a running AL Language Server (\`LSP\`).
Reach for those first; \`Bash\` is for commands with no tool equivalent (\`git\`,
\`az\`).

| To... | Use |
|---|---|
| Read part of a file | \`Read\` with \`offset\`/\`limit\` |
| Find text | \`Grep\` |
| Find files | \`Glob\` |
| Jump to a definition | \`LSP goToDefinition\` |
| Find every usage of a symbol | \`LSP findReferences\` |
| Check a type, signature or table relation | \`LSP hover\` |
| List an object's procedures/fields | \`LSP documentSymbol\` |
| Find callers of a procedure | \`LSP incomingCalls\` |

\`Read\` returns the same bytes as \`sed -n\` but the harness can track and
de-duplicate it, so re-reading a file you already opened is nearly free —
whereas each \`sed\`/\`cat\` result is fresh text that stays in your context for
every later turn. On a large AL repo that difference dominates the cost of a
review.

LSP answers from the compiled symbol table, so it resolves what text search
cannot: aliases, cross-file references, and inherited members.
`;

/**
 * EVAL-ONLY: append a tool-discipline section to every pr-reviewer sub-agent.
 *
 * The 7 sub-agents inherit `Read`/`Grep`/`Glob`/`LSP` from the orchestrator's
 * `allowedTools`, but nothing in their prompts steers them there. Measured on
 * PR 52081: 207 Bash calls of which 168 were `sed`/`cat`/`head`/`tail` file
 * reads, 23 `Read` calls, and ZERO LSP calls — 10.0M cache-read tokens on a
 * two-file diff, $16.53.
 *
 * Guarded so this is a TRUE NO-OP unless `PR_REVIEW_SUBAGENT_TOOL_RULE=1`.
 * Idempotent — appends only to files that don't already carry the block.
 *
 * Returns the number of files modified (0 when the env var is unset).
 */
export function maybeInjectToolRule(): number {
  if (process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] !== '1') return 0;

  const cliDir = dirname(fileURLToPath(import.meta.url));
  const agentsDir = resolve(cliDir, '..', 'agents', 'pr-reviewer', '.claude', 'agents');
  if (!existsSync(agentsDir)) {
    console.log(`[eval] PR_REVIEW_SUBAGENT_TOOL_RULE set but sub-agent dir not found at ${agentsDir} — skipping`);
    return 0;
  }

  const marker = '## Reading code — use the right tool';
  let modified = 0;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(agentsDir, file);
    const content = readFileSync(path, 'utf-8');
    if (content.includes(marker)) continue;
    writeFileSync(path, `${content.trimEnd()}\n${SUBAGENT_TOOL_RULE}`);
    modified++;
  }

  console.log(`[eval] injected tool-usage rule into ${modified} sub-agent files`);
  return modified;
}

/**
 * Render the marker + severity-labeled body shared by a thread's creation and
 * its later update — the only difference between the two call sites is which
 * ADO write carries this same string.
 */
function buildCommentBody(finding: PRFinding, key: string): string {
  return `${markerFor(key)}\n\n**${finding.severity === 'critical' ? '🔴 Critical' : '🟠 Major'}** — ${finding.title}\n\n${finding.body}`;
}

/**
 * The severity line `buildCommentBody` renders directly under the marker, e.g.
 * `**🔴 Critical** — Missing timeout`.
 *
 * The emoji is optional so a body written before it existed still parses, but the
 * severity word itself is required: that is what keeps a bold em-dash line from
 * the finding's own prose from being lifted as a title.
 */
const SEVERITY_TITLE_RE = /^\*\*(?:🔴 |🟠 )?(?:Critical|Major)\*\*\s+—\s+(.+?)\s*$/;

/**
 * Recover the title from a marker thread's first comment.
 *
 * Only the FIRST non-empty line after the marker is considered — the title lives
 * there by construction, and scanning further would start matching the body.
 * Returns null when that line is not a severity line, so a hand-edited comment
 * contributes no row rather than a wrong one.
 */
function parseFindingTitle(rawContent: string): string | null {
  // ADO round-trips comment bodies through JSON and can hand back CRLF. The
  // \r?\n split keeps a blank line from arriving as '\r' (which would read as
  // content and end the scan early), and the per-line trim strips any CR the
  // split left behind — either would carry a stray \r into the printed title.
  for (const line of rawContent.replace(FINDING_MARKER_RE, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    return SEVERITY_TITLE_RE.exec(trimmed)?.[1]?.trim() ?? null;
  }
  return null;
}

/**
 * Keep a `|` in a title from breaking the markdown table it is printed in.
 *
 * Idempotent: `\?\|` also matches an already-escaped `\|`, so escaping a title
 * that was itself copied back out of a previous prior-findings row (the model
 * reuses the row verbatim) does not accrete a second backslash. Safe for the
 * key either way — `findingKey` collapses every non-alphanumeric run to a
 * single space, so `\|` and `|` normalise to the same identity.
 */
function escapeCell(text: string): string {
  return text.replace(/\\?\|/g, '\\|');
}

/**
 * Return the `file` spelling that reproduces this thread's own key, or null when
 * neither candidate does.
 *
 * `findingKey` now normalises the path itself (strips a leading slash, folds
 * backslashes to forward slashes), so the two candidates below agree whenever the
 * title also matches — the slash-spelling ambiguity this function was written for
 * is closed at the source. It stays a two-candidate check anyway because it has a
 * second job that path normalisation cannot touch: proving the TITLE on hand is
 * the one the key was built from. A null still means the pair on hand cannot name
 * this thread — the comment was hand-edited, or the title spans lines and only
 * its first line survived parsing — and that case is unaffected by this change.
 *
 * Printing an unverified row would be worse than omitting it — the model would
 * reuse it verbatim and still fork the thread, with the table taking the blame
 * off the model. So the row is dropped, and the caller logs the drop.
 */
function fileSpellingMatchingKey(filePath: string, title: string, key: string): string | null {
  for (const candidate of [filePath.replace(/^\/+/, ''), filePath]) {
    if (findingKey(candidate, title) === key) return candidate;
  }
  return null;
}

/**
 * Tell the model the exact `file` + `title` pairs that already carry a thread on
 * this PR, so a re-review can reuse them instead of paraphrasing them.
 *
 * This is the lookup the whole inline-comment design rests on. A finding's
 * identity is `sha1(file + '::' + normalised title)` — but the sub-agents write
 * their findings fresh every run and never see the previous wording, so without
 * being shown it the orchestrator has nothing to be stable *against* and each
 * re-review forks every thread into a duplicate.
 *
 * Anchored, marked threads only: a human's thread carries no marker and their
 * "by design, see ticket X" reply must stay out of this table, and an unanchored
 * thread has no path for the model to reuse.
 *
 * Returns '' when nothing qualifies — an empty heading and table would tell the
 * model prior findings exist when they do not.
 */
export function buildPriorFindingsBlock(threads: ReviewThread[]): string {
  const rows: string[] = [];
  const seen = new Set<string>();
  const unverifiable: number[] = [];

  for (const thread of threads) {
    if (!thread.filePath) continue;
    const key = extractKey(thread.rawContent);
    if (!key) continue;
    const title = parseFindingTitle(thread.rawContent);
    if (!title) continue;
    // Every row must hash back to the key of the thread it names — this is a
    // runtime self-check on the one assumption the design rests on, covering
    // hand-edited bodies and any future drift in how the body is rendered.
    const file = fileSpellingMatchingKey(thread.filePath, title, key);
    if (!file) { unverifiable.push(thread.id); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| ${file} | ${escapeCell(title)} |`);
  }

  if (unverifiable.length > 0) {
    // Visible rather than silent: a duplicate thread on the next review is then
    // attributable — the model was never handed these rows to reuse.
    console.log(
      `[inline] ${unverifiable.length} marker thread(s) left out of the prior-findings table` +
      ` — file+title does not reproduce the thread key (thread ids: ${unverifiable.join(', ')})`,
    );
  }

  if (rows.length === 0) return '';

  return [
    `## Findings already tracked on this PR`,
    ``,
    `Each row below is a finding an earlier review raised, and each already has its own comment`,
    `thread on this PR. When you raise one of them again, reuse that row's \`file\` and \`title\``,
    `verbatim in \`findingsList\`: the two together identify the thread, so reusing them updates`,
    `the existing discussion, while any rewording opens a second thread beside it.`,
    ``,
    `| File | Title |`,
    `|---|---|`,
    ...rows,
  ].join('\n');
}

/**
 * Post this review's Critical/Major findings as line-anchored threads.
 *
 * Additive by construction: it runs AFTER the agent has already posted the
 * summary comment, and every ADO call is individually guarded. An inline failure
 * is counted and logged; the finding is in the summary regardless, so a rejected
 * anchor costs presentation, never information.
 */
export async function applyInlineFindings(
  prId: number,
  findings: PRFinding[],
  config: PipelineConfig,
  opts: { today?: string } = {},
): Promise<{ created: number; updated: number; stale: number; failed: number }> {
  const result = { created: 0, updated: 0, stale: 0, failed: 0 };
  if (findings.length === 0) return result;
  // Belt and braces: the call site already guards on `!noPost`, but this function
  // is exported and an A/B harness is about to call it directly across many arms.
  // Guarding here too means a caller that forgets the check still cannot write to
  // a live PR.
  if (process.env['PR_REVIEW_NO_POST'] === '1') return result;

  let threads: ReviewThread[] = [];
  try {
    threads = await fetchReviewThreadsRaw(prId, config);
  } catch (err) {
    console.log(`[inline] could not read PR threads, skipping inline comments: ${err}`);
    return result;
  }

  const stamp = opts.today ?? new Date().toISOString().slice(0, 10);

  for (const action of reconcileFindings(findings, threads)) {
    try {
      if (action.kind === 'create') {
        const { finding, key } = action;
        await postInlineThread(prId, {
          filePath: finding.file!,
          line: finding.line!,
          content: buildCommentBody(finding, key),
        }, config);
        result.created++;
      } else if (action.kind === 'update') {
        const { finding, key } = action;
        await updateThreadComment(prId, action.threadId, action.commentId, buildCommentBody(finding, key), config);
        result.updated++;
      } else {
        await appendToThread(prId, action.threadId, `_Not detected in review of ${stamp}._`, config);
        result.stale++;
      }
    } catch (err) {
      result.failed++;
      console.log(`[inline] ${action.kind} failed: ${err}`);
    }
  }

  console.log(`[inline] created=${result.created} updated=${result.updated} stale=${result.stale} failed=${result.failed}`);
  return result;
}

export async function reviewPR(args: string[]): Promise<void> {
  let prId: number | undefined;
  let repoId: string | undefined;
  let sourceBranch = '';
  let targetBranch = '';
  let prUrl: string | undefined;
  let prTitle: string | undefined;
  let prDescription: string | undefined;
  let actionId: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr-id' && args[i + 1]) prId = parseInt(args[++i]!, 10);
    if (args[i] === '--repo-id' && args[i + 1]) repoId = args[++i];
    if (args[i] === '--source-branch' && args[i + 1]) sourceBranch = args[++i]!;
    if (args[i] === '--target-branch' && args[i + 1]) targetBranch = args[++i]!;
    if (args[i] === '--pr-url' && args[i + 1]) prUrl = args[++i];
    if (args[i] === '--pr-title' && args[i + 1]) prTitle = args[++i];
    if (args[i] === '--pr-description' && args[i + 1]) prDescription = args[++i];
    if (args[i] === '--action-id' && args[i + 1]) actionId = parseInt(args[++i]!, 10);
  }

  if (!prId || !repoId) {
    console.error('Usage: pipeline review-pr --pr-id <id> --repo-id <guid> [--source-branch <ref>] [--target-branch <ref>] [--action-id <id>]');
    process.exit(1);
  }

  const noPost = process.env['PR_REVIEW_NO_POST'] === '1';
  if (noPost) console.log('[review-pr] NO-POST mode: review will not be published to the PR');

  // EVAL-ONLY: when PR_REVIEW_SUBAGENT_MODEL is set, rewrite the pinned `model:`
  // frontmatter in the pr-reviewer sub-agents so the A/B model arm takes effect.
  // No-op by default — production runs leave this unset.
  maybeOverrideSubAgentModel();
  maybeInjectToolRule();

  const repo = findRepoByRepositoryId(repoId);
  if (!repo) {
    console.error(`Unknown repository ID: ${repoId}`);
    process.exit(1);
  }

  const sessionRoot = process.env['SESSION_ROOT'] ?? process.cwd();
  const baseConfig = loadConfig(sessionRoot);
  // Take the ADO coordinates from the resolved repo (the overlay registration),
  // including organization/orgUrl — NOT just project/repo. Spawned review
  // containers don't receive AZURE_DEVOPS_ORG, so relying on baseConfig's org
  // leaves the placeholder 'your-org' and every ADO call fails to authenticate.
  const org = repo.config.azureDevOps.organization ?? baseConfig.azureDevOps.organization;
  const config = {
    ...baseConfig,
    azureDevOps: {
      ...baseConfig.azureDevOps,
      organization: org,
      orgUrl: repo.config.azureDevOps.orgUrl ?? `https://dev.azure.com/${org}`,
      project: repo.config.azureDevOps.project,
      repositoryId: repo.config.azureDevOps.repositoryId,
      repositoryName: repo.config.azureDevOps.repositoryName,
      areaPath: repo.config.azureDevOps.areaPath,
    },
    repoKey: repo.config.repoKey,
  };

  // Fail loud if the resolved config still carries the open-source placeholder
  // defaults (e.g. organization='your-org') — better an obvious error than a
  // silent stream of 404s from the ADO MCP.
  assertRealAdoConfig(config, 'pr-review');

  // Connect to DB for persisting review result
  let prReviewStore: Awaited<ReturnType<typeof connectStores>>['prReviewStore'] | undefined;
  try {
    const stores = await connectStores();
    prReviewStore = stores.prReviewStore;
    console.log('[review-pr] Connected to database');
  } catch (dbErr) {
    console.warn(`Warning: could not connect to database — review result will not be persisted: ${dbErr}`);
  }

  const shortBranch = sourceBranch.replace('refs/heads/', '');
  const shortTarget = targetBranch.replace('refs/heads/', '');

  console.log(`Starting PR review for PR #${prId} in ${repo.config.azureDevOps.repositoryName}`);

  const logDir = process.env['LOG_DIR']
    ?? (process.env['STATE_DIR'] ? join(resolve(process.env['STATE_DIR'], '..'), 'logs', 'pr-reviews') : '.pipeline/logs/pr-reviews');
  const reviewRunId = makeReviewRunId(prId);
  let logger: PipelineLogger;
  if (prReviewStore) {
    // connectDatabase returns the same singleton sql the store already uses — no second pool.
    const { connectDatabase } = await import('../db/postgres.ts');
    const { PgPrReviewLogSink } = await import('../db/pg-pr-review-log-sink.ts');
    const sql = await connectDatabase(process.env['DATABASE_URL']!);
    const sink = new PgPrReviewLogSink(sql, prId, reviewRunId);
    logger = new PipelineLogger(logDir, prId, sink);
    logger.onAgentName((name) => sink.setAgentName(name));
    console.log(`[review-pr] run_id=${reviewRunId} — logging to stage_logs`);
  } else {
    logger = new PipelineLogger(logDir, prId);
  }
  logger.stageStart('pr-reviewer');

  // Read the PR's existing marker threads BEFORE the agent runs, so the prompt can
  // hand it the exact file+title pairs already under discussion. Without this the
  // agent is asked to keep titles stable with nothing to be stable against.
  //
  // This is deliberately a SECOND read of the same endpoint — applyInlineFindings
  // reads it again after the run. A review takes minutes, and reconciliation has to
  // act on the threads that exist when it WRITES: a human reply, or a second review
  // running on the same PR, lands inside that window, and two reviews sharing one
  // pre-agent snapshot would both see "no thread" and both create. One extra GET is
  // the cheaper half of that trade.
  //
  // Not a factor either way: the agent's own summary comment is posted PR-level via
  // the MCP tool, so it carries no threadContext and reconcileFindings filters it.
  //
  // Guarded like every other ADO read here: a failed read costs the model its
  // lookup table, never the review.
  let priorFindingsBlock = '';
  try {
    priorFindingsBlock = buildPriorFindingsBlock(await fetchReviewThreadsRaw(prId, config));
    const rows = priorFindingsBlock ? priorFindingsBlock.split('\n').filter((l) => l.startsWith('| ')).length - 1 : 0;
    console.log(`[inline] prompting with ${rows} prior finding(s) already threaded on this PR`);
  } catch (err) {
    console.log(`[inline] could not read prior PR threads, prompting without them: ${err}`);
  }

  try {
    const result = await runPRReview(
      { prId, repoKey: repo.key, repoUrl: repo.config.url, repositoryId: repoId, project: repo.config.azureDevOps.project, sourceBranch, targetBranch, prUrl, prTitle, prDescription, noPost, priorFindingsBlock },
      config,
      logger,
    );

    // `noPost` is read above and already suppresses the agent's own summary
    // comment. Inline threads MUST honour it too — see applyInlineFindings' doc.
    // `null` means "not attempted" (noPost, or no findings) — kept distinct from
    // an all-zero result, which means it ran and found nothing to anchor.
    let inlineThreads: { created: number; updated: number; stale: number; failed: number } | null = null;
    if (!noPost && result.output?.findingsList?.length) {
      inlineThreads = await applyInlineFindings(prId, result.output.findingsList, config);
    }

    if (prReviewStore) {
      try {
        await prReviewStore.save({
          prId,
          repoKey: repo.key,
          sourceBranch: shortBranch,
          targetBranch: shortTarget,
          title: `PR #${prId}`,
          recommendation: result.output.recommendation,
          findings: result.output.findings ?? null,
          findingsCount: result.output.findingsCount,
          commentId: result.output.commentId,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          turns: result.turns,
          toolCalls: result.toolCalls,
          subAgents: result.subAgents ?? null,
          modelUsage: result.modelUsage ?? null,
          sessionId: result.sessionId,
          error: null,
          reviewBody: result.output.reviewBody,
          createdAt: new Date().toISOString(),
          actionId: actionId ?? null,
          reviewRunId,
          findingsList: result.output.findingsList ?? null,
          inlineThreads,
        });
        console.log(`[review-pr] Saved review to database`);
      } catch (saveErr) {
        console.error(`[review-pr] Failed to save review to database: ${saveErr}`);
      }
    } else {
      console.warn('[review-pr] No database connection — review not persisted');
    }

    console.log(`PR #${prId} review completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorType = (err as { type?: string })?.type ?? 'agent-error';
    const errorStage = (err as { stage?: string })?.stage ?? 'pr-reviewer';

    if (err instanceof Error) logger.stageError(err);

    if (prReviewStore) {
      await prReviewStore.save({
        prId,
        repoKey: repo.key,
        sourceBranch: shortBranch,
        targetBranch: shortTarget,
        title: `PR #${prId}`,
        recommendation: null,
        findings: null,
        findingsCount: null,
        commentId: null,
        costUsd: null,
        durationMs: null,
        turns: null,
        toolCalls: null,
        subAgents: null,
        modelUsage: null,
        sessionId: null,
        error: errorMsg,
        reviewBody: null,
        createdAt: new Date().toISOString(),
        actionId: actionId ?? null,
        reviewRunId,
        findingsList: null,
        inlineThreads: null,
      });
    }

    await notifyPipelineError(
      { type: errorType, stage: errorStage, message: errorMsg },
      {
        source: 'pr-review-agent',
        url: prUrl,
        fields: [
          { name: 'PR', value: `#${prId}`, inline: true },
          { name: 'Repo', value: repo.config.azureDevOps.repositoryName, inline: true },
          { name: 'Branch', value: shortBranch, inline: true },
          { name: 'Target', value: shortTarget, inline: true },
        ],
      },
    );

    throw err;
  }
}
