import type { SubAgentUsage, StageModelUsage } from '../types/pipeline.types.ts';
import type { PRFinding } from '../agents/pr-reviewer/schema.ts';

/**
 * Per-eval-lever file-modification counts, one key per `PR_REVIEW_*` hook in
 * `src/cli/review-pr.ts` that was actually ENABLED this run (its own env var
 * set, per that hook's own activation predicate) — a key absent means the
 * lever was off, never that it silently failed.
 *
 * Persisted so `scripts/pr-review-eval/compliance.ts`'s `checkArmCompliance`
 * can verify prompt-CONTENT levers (scoped payload, BC-only security
 * narrowing) actually took effect. Those two edit what an agent is TOLD, not
 * which agents dispatch, so a silent no-op produces `sub_agents` telemetry
 * identical to a working run — the roster/model checks alone cannot see it.
 */
export interface AppliedLevers {
  agentSet?: number;
  routing?: number;
  scopedPayload?: number;
  securityBcOnly?: number;
  subagentModel?: number;
  subagentToolRule?: number;
}

export interface PRReviewRow {
  id: number;
  prId: number;
  repoKey: string;
  sourceBranch: string;
  targetBranch: string;
  title: string | null;
  recommendation: string | null;
  findings: { critical: number; major: number; minor: number; nitpick: number } | null;
  findingsCount: number | null;
  commentId: number | null;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  toolCalls: Record<string, number> | null;
  /** Per-named-sub-agent usage keyed by subagent_type. Null for runs recorded
   *  before this was captured, and for reviews that dispatched no sub-agents. */
  subAgents: Record<string, SubAgentUsage> | null;
  /** Per-model cost/token split keyed by model id. */
  modelUsage: Record<string, StageModelUsage> | null;
  sessionId: string | null;
  error: string | null;
  reviewBody: string | null;
  createdAt: string;
  actionId: number | null;
  reviewRunId: string | null;
  /** Every finding as a structured record. Null for runs recorded before this
   *  was captured, and for reviews that produced no findings. */
  findingsList: PRFinding[] | null;
  /** Counters from posting Critical/Major findings as inline PR threads. Null
   *  when nothing was attempted (noPost mode or no findings) — distinct from
   *  an all-zero result, which means it ran and found nothing to anchor. */
  inlineThreads: { created: number; updated: number; stale: number; failed: number } | null;
  /** Which reviewer ran: `sanity:<sourcePrId>` for the cheap backport path, or
   *  `full:<reason>` naming why the full path was chosen. Null for rows recorded
   *  before this routing existed. */
  reviewPath: string | null;
  /** File-modification counts from the eval-only `PR_REVIEW_*` hooks that were
   *  enabled this run. Null for a production review (no lever env vars set)
   *  or a row recorded before this was captured — never a map of zeros, which
   *  would be indistinguishable from "every enabled lever failed to apply". */
  appliedLevers: AppliedLevers | null;
  /** The core repo's short HEAD sha baked into the image that produced this
   *  review (`process.env.BUILD_SHA`, set from the Dockerfile `ARG`/`ENV` —
   *  see `docker-build.ps1`). Null for rows recorded before this was captured,
   *  and for any container built without the `BUILD_SHA` build-arg (e.g. a
   *  plain `docker compose build`, which bakes the literal string `"unknown"`
   *  rather than leaving the env var unset — that case reads back as the
   *  string `"unknown"`, not null). Answers "which build produced this row",
   *  independent of what HEAD is checked out today. */
  imageSha: string | null;
  /** True when this run must be excluded from production statistics. */
  isTest: boolean;
}

export interface IPRReviewStore {
  save(row: Omit<PRReviewRow, 'id'>): Promise<number>;
  listRecent(limit?: number): Promise<PRReviewRow[]>;
  findByActionId(actionId: number): Promise<PRReviewRow | null>;
  findById(id: number): Promise<PRReviewRow | null>;
  /** Latest recorded review of a given PR id, or null when none exists. Used to
   *  surface a backport's SOURCE PR's own review status — `reviewed` with its
   *  recommendation, or `not-reviewed` when nothing was ever recorded for it. */
  findLatestByPrId(prId: number): Promise<PRReviewRow | null>;
}
