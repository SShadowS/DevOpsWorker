import type { SubAgentUsage, StageModelUsage } from '../types/pipeline.types.ts';
import type { PRFinding } from '../agents/pr-reviewer/schema.ts';

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
