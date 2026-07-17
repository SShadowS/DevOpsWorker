import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { runPRReview } from '../agents/pr-reviewer/config.ts';
import { findRepoByRepositoryId } from '../config/repos.ts';
import { assertRealAdoConfig } from '../sdk/config-sanity.ts';
import { connectStores } from '../db/connect-stores.ts';
import { notifyPipelineError } from '../sdk/discord-notify.ts';
import { PipelineLogger } from '../sdk/pipeline-logger.ts';

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

  try {
    const result = await runPRReview(
      { prId, repoKey: repo.key, repoUrl: repo.config.url, repositoryId: repoId, project: repo.config.azureDevOps.project, sourceBranch, targetBranch, prUrl, prTitle, prDescription, noPost },
      config,
      logger,
    );

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
          sessionId: result.sessionId,
          error: null,
          reviewBody: result.output.reviewBody,
          createdAt: new Date().toISOString(),
          actionId: actionId ?? null,
          reviewRunId,
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
        sessionId: null,
        error: errorMsg,
        reviewBody: null,
        createdAt: new Date().toISOString(),
        actionId: actionId ?? null,
        reviewRunId,
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
