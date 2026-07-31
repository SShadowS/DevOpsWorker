import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { runPRReview, detectCherryPick } from '../agents/pr-reviewer/config.ts';
import type { PRFinding, PRReviewResult } from '../agents/pr-reviewer/schema.ts';
import { runBackportReview } from '../agents/cherry-pick-reviewer/config.ts';
import type { BackportReview } from '../agents/cherry-pick-reviewer/schema.ts';
import { findRepoByRepositoryId } from '../config/repos.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { connectStores } from '../db/connect-stores.ts';
import { notifyPipelineError } from '../sdk/discord-notify.ts';
import { PipelineLogger } from '../sdk/pipeline-logger.ts';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import type { AgentResult } from '../types/agent.types.ts';
import {
  fetchReviewThreadsRaw,
  postInlineThread,
  updateThreadComment,
  appendToThread,
  fetchPRMetadata,
  fetchPRDiff,
  type ReviewThread,
  type PRMetadata,
} from '../sdk/ado/pull-requests.ts';
import { chooseReviewPath, compareDiffs, renderDiffComparison, type FileDiff } from '../sdk/ado/backport.ts';
import { checkoutBranch, resolveRef } from '../sdk/git-checkout.ts';
import { reconcileFindings } from '../sdk/ado/reconcile-findings.ts';
import { extractKey, findingKey, FINDING_MARKER_RE, markerFor } from '../sdk/ado/finding-key.ts';

export function makeReviewRunId(prId: number): string {
  return `pr-${prId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ReviewPrArgs {
  prId?: number;
  repoId?: string;
  sourceBranch: string;
  targetBranch: string;
  prUrl?: string;
  prTitle?: string;
  prDescription?: string;
  actionId?: number;
  /** `--full` — forces the full seven-agent review even when `chooseReviewPath`
   *  would otherwise route this PR to the backport reviewer. The CLI-flag half of
   *  the `/review-full` escape hatch (webhook-server/parse.ts's other half); a
   *  human uses the comment, an automated caller (eval harness, script) uses this. */
  forceFull: boolean;
}

/**
 * Parse `review-pr`'s argv into typed fields.
 *
 * Pulled out of `reviewPR` so this end of the webhook → action → argv bridge is
 * unit-testable without the full agent + DB stack `reviewPR` itself needs —
 * `buildReviewPrExtraArgs` (action-processor.ts) and `buildReviewPrActionFeedback`
 * (webhook-server/index.ts) pin the other two hops the same way.
 */
export function parseReviewPrArgs(args: string[]): ReviewPrArgs {
  let prId: number | undefined;
  let repoId: string | undefined;
  let sourceBranch = '';
  let targetBranch = '';
  let prUrl: string | undefined;
  let prTitle: string | undefined;
  let prDescription: string | undefined;
  let actionId: number | undefined;
  let forceFull = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr-id' && args[i + 1]) prId = parseInt(args[++i]!, 10);
    if (args[i] === '--repo-id' && args[i + 1]) repoId = args[++i];
    if (args[i] === '--source-branch' && args[i + 1]) sourceBranch = args[++i]!;
    if (args[i] === '--target-branch' && args[i + 1]) targetBranch = args[++i]!;
    if (args[i] === '--pr-url' && args[i + 1]) prUrl = args[++i];
    if (args[i] === '--pr-title' && args[i + 1]) prTitle = args[++i];
    if (args[i] === '--pr-description' && args[i + 1]) prDescription = args[++i];
    if (args[i] === '--action-id' && args[i + 1]) actionId = parseInt(args[++i]!, 10);
    if (args[i] === '--full') forceFull = true;
  }

  return { prId, repoId, sourceBranch, targetBranch, prUrl, prTitle, prDescription, actionId, forceFull };
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
  opts: { today?: string; suppressStale?: boolean } = {},
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

  // Computed inside its own try, not the `for` header: reconcileFindings is pure
  // and has no reason to throw today, but the governing invariant is "inline
  // posting can never fail a review" — an exception here would otherwise escape
  // applyInlineFindings entirely and land in reviewPR's outer catch, failing a
  // review whose agent already succeeded and posted its summary.
  let actions: ReturnType<typeof reconcileFindings>;
  try {
    actions = reconcileFindings(findings, threads, 5, { suppressStale: opts.suppressStale });
  } catch (err) {
    console.log(`[inline] could not reconcile findings against existing threads, skipping inline comments: ${err}`);
    return result;
  }

  for (const action of actions) {
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
  const { prId, repoId, sourceBranch, targetBranch, prUrl, prTitle, prDescription, actionId, forceFull } = parseReviewPrArgs(args);

  if (!prId || !repoId) {
    console.error('Usage: pipeline review-pr --pr-id <id> --repo-id <guid> [--source-branch <ref>] [--target-branch <ref>] [--action-id <id>] [--full]');
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

  // argv carries these only when a caller passed them; the watcher does not
  // (action-processor forwards no --pr-title), so detection would never see a
  // cherry-pick trailer. Read them from the PR itself and let argv win when given.
  let prMetadata: PRMetadata | undefined;
  try {
    prMetadata = await fetchPRMetadata(prId, config);
  } catch (err) {
    console.log(`[review-pr] could not read PR metadata, continuing without it: ${err}`);
  }
  const resolvedTitle = prTitle || prMetadata?.title || '';
  const resolvedDescription = prDescription || prMetadata?.description || '';

  // The container clones the repo ONE LEVEL BELOW the session root
  // (`docker/entrypoint.sh`: `MAIN_REPO_DIR="${SESSION_ROOT}/${REPO_KEY}"`) —
  // `config.paths.sessionRoot` alone has no `.git` of its own. `config.repoKey` (not
  // `config.paths.targetRepo`, which stays `loadConfig`'s placeholder here since this
  // file builds `config` without going through `buildConfigFromRepo`) is the real
  // directory name.
  //
  // Declared before the diff reads rather than just before the checkout: a PR's diff
  // is now computed with `git diff` inside this clone, because Azure DevOps REST
  // serves no unified diffs at all.
  const repoDir = join(config.paths.sessionRoot, config.repoKey);

  // Route before spending. `full` is the default for every uncertainty: an
  // unidentifiable backport then costs exactly what it costs today.
  const cherryPick = detectCherryPick({ title: resolvedTitle, description: resolvedDescription });
  let sourceDiff: FileDiff[] = [];
  let sourcePrExists = false;
  let sourceDiffError = '';
  if (cherryPick.originalPrId) {
    const source = await fetchPRDiff(cherryPick.originalPrId, repoDir, config);
    if (source.ok) {
      sourceDiff = source.files;
      sourcePrExists = true;
      // An empty-but-successful diff is not a fetch failure, and must not be
      // reported as one — there is simply nothing to compare against.
      if (sourceDiff.length === 0) sourceDiffError = 'the source PR changed no comparable files';
    } else {
      // `prMissing` is the only thing allowed to report the PR as absent. Before
      // this, ANY failure set `sourcePrExists = false` and the route reason read
      // "source PR !<id> not found in this repository" — which is what a 404 from a
      // non-existent endpoint looked like, all the way into the `review_path` column.
      sourcePrExists = !source.prMissing;
      sourceDiffError = source.error;
      console.log(`[backport] source PR !${cherryPick.originalPrId} diff unavailable: ${source.error}`);
    }
  }

  // This PR's own branches. REST wins over argv here — the opposite precedence from
  // resolvedTitle/resolvedDescription above — because `chooseReviewPath` and the
  // checkout that follows need the CURRENT branch, and `fetchPRMetadata` always is
  // (its doc: "Reading over REST is always current"), while argv is a snapshot the
  // watcher forwards from the webhook payload. Computed once and reused for the route
  // decision, the checkout, and the staleness check below, so all three agree.
  const effectiveSourceBranch = prMetadata?.sourceBranch ?? sourceBranch ?? '';
  const effectiveTargetBranch = prMetadata?.targetBranch ?? targetBranch ?? '';

  let route = chooseReviewPath({
    cherryPick,
    sourceBranch: effectiveSourceBranch,
    sourcePrExists,
    sourceDiffFetchable: sourceDiff.length > 0,
    sourceDiffError,
    forceFull,
  });
  console.log(route.path === 'sanity'
    ? `[backport] sanity path — ported from !${route.sourcePrId}`
    : `[backport] full path — ${route.reason}`);
  // Kept in sync with `route` below (the checkout-failure fallback reassigns both
  // together) so a run that errors before `save()` still persists which path it
  // took — a cheap review and a failed detection must stay distinguishable in the
  // data even when the run itself blows up.
  let reviewPath = route.path === 'sanity' ? `sanity:${route.sourcePrId}` : `full:${route.reason}`;

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
    let result: AgentResult<PRReviewResult> | AgentResult<BackportReview>;

    // A failed checkout falls back to the full review: at this point the diffs
    // above are already fetched but no agent has run, so falling back is still
    // free — see the brief's note on why this ordering is the one that matters.
    if (route.path === 'sanity') {
      const checkout = await checkoutBranch(repoDir, effectiveSourceBranch);
      if (!checkout.ok) {
        console.log(`[backport] checkout of ${effectiveSourceBranch} failed, using the full review: ${checkout.error}`);
        route = { path: 'full', reason: `checkout of ${effectiveSourceBranch} failed: ${checkout.error}` };
        reviewPath = `full:${route.reason}`;
      }
    }

    // Same "still free" reasoning as the checkout above: no agent has run yet,
    // so a transient failure here falls back rather than failing the whole
    // review with no review at all. `fetchPRDiff` returns a result instead of
    // throwing, so this is an `if`, not a try/catch — but the fallback it guards
    // is the same one, and it is still the thing that must not be dropped.
    let portDiff: FileDiff[] = [];
    if (route.path === 'sanity') {
      const port = await fetchPRDiff(prId, repoDir, config);
      if (port.ok && port.files.length === 0) {
        // Symmetry with the source side, which already refuses to route `sanity` on
        // an empty diff. An empty PORT diff would compare cleanly and report every
        // source file as missing — technically the safe direction, but it presents a
        // computation failure as a damning finding about the port.
        console.log('[backport] port diff is empty, using the full review');
        route = { path: 'full', reason: 'port PR changed no comparable files' };
        reviewPath = `full:${route.reason}`;
      } else if (port.ok) {
        portDiff = port.files;
      } else {
        console.log(`[backport] port diff unavailable, using the full review: ${port.error}`);
        // Capped like the source-side reason in `chooseReviewPath`, for the same
        // reason: this string is persisted to `review_path` and read by a human.
        route = { path: 'full', reason: `port diff could not be computed: ${port.error.slice(0, 200)}` };
        reviewPath = `full:${route.reason}`;
      }
    }

    if (route.path === 'sanity') {
      const diffComparison = renderDiffComparison(compareDiffs(sourceDiff, portDiff));

      // Surfaced, not gated on (design decision M3): a change never deep-reviewed
      // anywhere still takes the cheap path, but the output says so, so a human
      // reading an approval can ask for /review-full.
      let sourceReviewStatus: 'reviewed' | 'not-reviewed' = 'not-reviewed';
      let sourceRecommendation: string | null = null;
      if (prReviewStore) {
        try {
          const sourceReview = await prReviewStore.findLatestByPrId(route.sourcePrId);
          if (sourceReview?.recommendation) {
            sourceReviewStatus = 'reviewed';
            sourceRecommendation = sourceReview.recommendation;
          }
        } catch (err) {
          console.log(`[backport] could not look up source PR !${route.sourcePrId}'s review status, reporting not-reviewed: ${err}`);
        }
      }

      // Stale when the target branch has moved past the commit ADO last computed
      // this PR's merge preview against. An unresolvable comparison counts as stale
      // too (see `resolveRef`'s doc) — "I could not check" must never read as "it's
      // current".
      const targetRefName = effectiveTargetBranch.replace(/^refs\/heads\//, '');
      const targetTip = targetRefName ? await resolveRef(repoDir, `origin/${targetRefName}`) : null;
      const mergePreviewStale = !prMetadata?.lastMergeTargetCommit || !targetTip || targetTip !== prMetadata.lastMergeTargetCommit;

      const backportResult = await runBackportReview(
        {
          prId,
          sourcePrId: route.sourcePrId,
          // The folder name (`config.repoKey`, same value `repoDir` is built from),
          // NOT the registry key (`repo.key`) the `save()` calls below persist —
          // the prompt now names this directly as the checkout subdirectory, so
          // the wrong string here would tell the agent to look in a directory
          // that does not exist.
          repoKey: config.repoKey,
          sourceBranch: effectiveSourceBranch,
          targetBranch: effectiveTargetBranch,
          diffComparison,
          sourceReviewStatus,
          sourceRecommendation,
          mergePreviewStale,
          checkoutOk: true,
          noPost,
          priorFindingsBlock,
        },
        config,
        logger,
      );

      // `sourcePrId`, `sourceReviewStatus`, `sourceRecommendation`, `checkoutOk` and
      // `mergePreviewStale` are already known to TypeScript before the agent ran —
      // overwrite the model's echo of them rather than trust it. A transcription
      // slip on any of the first four is cosmetic; a slip on `mergePreviewStale`
      // flips the verdict on its own (it is read inverted from the prompt's `Merge
      // preview current` line — see cherry-pick-reviewer/CLAUDE.md).
      //
      // The overwrite below is silent by construction — logged here instead, since
      // it is the only thing that would ever tell anyone the model misread that
      // inverted line. `checkoutOk` can only ever mismatch as `false` (this branch
      // is unreachable otherwise), so it is a weaker signal than `mergePreviewStale`,
      // but cheap to log alongside it.
      if (backportResult.output.mergePreviewStale !== mergePreviewStale) {
        console.warn(`[backport] model reported mergePreviewStale=${backportResult.output.mergePreviewStale} but the computed value is ${mergePreviewStale} — likely misread the inverted "Merge preview current" prompt line. Using the computed value.`);
      }
      if (backportResult.output.checkoutOk !== true) {
        console.warn(`[backport] model reported checkoutOk=${backportResult.output.checkoutOk}, but checkout had already succeeded by construction to reach this branch. Using true.`);
      }
      result = {
        ...backportResult,
        output: {
          ...backportResult.output,
          sourcePrId: route.sourcePrId,
          sourceReviewStatus,
          sourceRecommendation,
          checkoutOk: true,
          mergePreviewStale,
        },
      };
    } else {
      result = await runPRReview(
        { prId, repoKey: repo.key, repoUrl: repo.config.url, repositoryId: repoId, project: repo.config.azureDevOps.project, sourceBranch, targetBranch, prUrl, prTitle: resolvedTitle, prDescription: resolvedDescription, noPost, priorFindingsBlock },
        config,
        logger,
      );
    }

    // The likeliest way this feature silently does nothing on a real PR: the
    // model reports findings in its counts but leaves findingsList empty (or
    // omits it), which is otherwise indistinguishable in the logs from a
    // genuinely findings-free review. Naming both numbers turns that into a log
    // read instead of a database query.
    if ((result.output?.findingsCount ?? 0) > 0 && !result.output?.findingsList?.length) {
      console.warn(`[inline] findingsCount=${result.output?.findingsCount} but findingsList has 0 entries — inline posting will not run`);
    }

    // `noPost` is read above and already suppresses the agent's own summary
    // comment. Inline threads MUST honour it too — see applyInlineFindings' doc.
    // `null` means "not attempted" (noPost, or no findings) — kept distinct from
    // an all-zero result, which means it ran and found nothing to anchor.
    // The sanity path deliberately never examines style, performance or security, so
    // it has no basis to declare a full-review finding "not detected" — suppress the
    // stale notice there. The full path passes `{}`, identical to passing nothing,
    // and keeps today's stale-marking behaviour.
    let inlineThreads: { created: number; updated: number; stale: number; failed: number } | null = null;
    if (!noPost && result.output?.findingsList?.length) {
      inlineThreads = await applyInlineFindings(prId, result.output.findingsList, config, route.path === 'sanity' ? { suppressStale: true } : {});
    }

    if (prReviewStore) {
      try {
        await prReviewStore.save({
          prId,
          repoKey: repo.key,
          sourceBranch: shortBranch,
          targetBranch: shortTarget,
          title: resolvedTitle || `PR #${prId}`,
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
          reviewPath: reviewPath,
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
        title: resolvedTitle || `PR #${prId}`,
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
        reviewPath: reviewPath,
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
