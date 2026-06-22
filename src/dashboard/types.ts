import type { PipelineStatus, TelemetryData, ActiveAgentMarker } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Action types — shared between dashboard server and watch process
// ---------------------------------------------------------------------------

export type ActionType =
  | 'approve-plan'
  | 'rerun-plan'
  | 'fix'
  | 'fix-test'
  | 'continue'
  | 'env-start'
  | 'env-stop'
  | 'env-delete'
  | 'env-share'
  | 'reprovision-env'
  | 'review-pr'
  | 'force-poll';

// ---------------------------------------------------------------------------
// Dashboard DTOs — sent to the browser via JSON API / SSE
// ---------------------------------------------------------------------------

export interface DashboardSession {
  workItemId: number;
  title?: string;
  status: PipelineStatus;
  currentStage: string;
  startedAt: string;
  lastActivityAt?: string;
  completedAt?: string;
  stages: StageProgress[];
  telemetry: TelemetryData;
  error?: { type: string; stage: string; message: string; timestamp: string };
  checkpoint?: { name: string; enteredAt: string; lastPolledAt?: string };
  revisionFeedback?: { source: string; feedback: string; targetStage: string };
  config?: { organization: string; project: string; sessionRoot: string };
  availableActions?: ActionType[];
  activeAgent?: ActiveAgentMarker;

  // Agent output pass-through (raw JSON blobs rendered by the frontend)
  readiness?: any;
  devPlan?: any;
  planReviews?: any[];
  changeset?: any;
  codeReviews?: any[];
  draftPR?: any;
  workItemUpdate?: any;
  learnedRules?: any;
  testCases?: any;
  testCaseReviews?: any[];
  docsWriterDrafts?: any;
  environment?: {
    envId: string;
    url: string;
    description: string;
    profileId: string;
    createdAt: string;
  };
  humanFeedback?: {
    rerunComment?: string;
    source?: string;
    prReviewComments?: any[];
    commentSummary?: string;
  };
  activeStages?: string[];
  legacySkipped?: string[];
}

export interface DashboardAction {
  id: number;
  workItemId: number;
  type: ActionType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  feedback?: string;
  email?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
}

export interface DashboardPRReview {
  id: number;
  prId: number;
  repoKey: string;
  sourceBranch: string;
  targetBranch: string;
  title: string | null;
  recommendation: string | null;
  findings: { critical: number; major: number; minor: number; nitpick: number } | null;
  findingsCount: number | null;
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  toolCalls: Record<string, number> | null;
  error: string | null;
  createdAt: string;
  /** Full Azure DevOps PR web URL, resolved server-side from the repo registry.
   *  null when the repo key isn't registered (registry not loaded / unknown key). */
  webUrl: string | null;
  /** Set for queued/in-progress reviews that haven't completed yet */
  pendingStatus?: 'queued' | 'reviewing';
}

export interface StageProgress {
  name: string;
  label: string;
  status: 'completed' | 'active' | 'waiting' | 'error' | 'pending' | 'skipped';
  isLoop?: boolean;
  isCheckpoint?: boolean;
  iterations?: number;
  activePhase?: 'producer' | 'reviewer';
  reviewer?: {
    label: string;
    status: 'completed' | 'active' | 'waiting' | 'error' | 'pending' | 'skipped';
  };
}
