import type { SubAgentUsage, StageModelUsage } from '../types/pipeline.types.ts';

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
}

export interface IPRReviewStore {
  save(row: Omit<PRReviewRow, 'id'>): Promise<number>;
  listRecent(limit?: number): Promise<PRReviewRow[]>;
  findByActionId(actionId: number): Promise<PRReviewRow | null>;
  findById(id: number): Promise<PRReviewRow | null>;
}
