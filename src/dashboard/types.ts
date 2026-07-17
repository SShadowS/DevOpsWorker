import type { PipelineStatus, TelemetryData, ActiveAgentMarker, ReviewVerdict, TestCaseFailure } from '../types/pipeline.types.ts';
import type { PRReviewComment } from '../sdk/azure-devops-client.ts';
import type { ReadinessReport } from '../agents/analyzer/schema.ts';
import type { DevPlan } from '../agents/planner/schema.ts';
import type { Changeset } from '../agents/coder/schema.ts';
import type { DraftPullRequest } from '../agents/draft-pr/schema.ts';
import type { WorkItemUpdate } from '../agents/documenter/schema.ts';
import type { TestCasesOutput } from '../agents/test-cases/schema.ts';
import type { DocsWriterOutput } from '../agents/docs-writer/schema.ts';

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

  // Agent output pass-through (schema-typed, straight from the owning agent's
  // Zod schema / core's shared verdict shape — see the agents' schema.ts files
  // and PipelineState in src/types/pipeline.types.ts for the source of truth).
  readiness?: ReadinessReport;
  devPlan?: DevPlan;
  planReviews?: ReviewVerdict[];
  changeset?: Changeset;
  codeReviews?: ReviewVerdict[];
  draftPR?: DraftPullRequest;
  workItemUpdate?: WorkItemUpdate;
  /** Raw learn-rules CLI output: either ProposedRules JSON or an { error, stderr? } shape.
   *  Not schema-validated (comes from a subprocess, not a Zod-checked agent run) — PipelineState
   *  types this the same way (`unknown`), so the dashboard mirrors it rather than inventing a union. */
  learnedRules?: unknown;
  testCases?: TestCasesOutput;
  testCaseReviews?: ReviewVerdict[];
  docsWriterDrafts?: DocsWriterOutput;
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
    prReviewComments?: PRReviewComment[];
    commentSummary?: string;
    /** Human discussion comments from the work item (since checkpoint entry). */
    workItemComments?: Array<{ author: string; text: string; createdDate: string }>;
    testCaseFailures?: TestCaseFailure[];
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
