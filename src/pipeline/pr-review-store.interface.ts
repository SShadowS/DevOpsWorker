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
  sessionId: string | null;
  error: string | null;
  reviewBody: string | null;
  createdAt: string;
  actionId: number | null;
}

export interface IPRReviewStore {
  save(row: Omit<PRReviewRow, 'id'>): Promise<number>;
  listRecent(limit?: number): Promise<PRReviewRow[]>;
  findByActionId(actionId: number): Promise<PRReviewRow | null>;
}
