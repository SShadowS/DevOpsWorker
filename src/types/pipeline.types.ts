import type { z } from 'zod';
import type { AgentConfig } from './agent.types.ts';
import type { ReadinessReport } from '../agents/analyzer/schema.ts';
import type { DevPlan } from '../agents/planner/schema.ts';
import type { Changeset } from '../agents/coder/schema.ts';
import type { DraftPullRequest } from '../agents/draft-pr/schema.ts';
import type { WorkItemUpdate } from '../agents/documenter/schema.ts';
import type { TestCasesOutput } from '../agents/test-cases/schema.ts';
import type { DocsWriterOutput } from '../agents/docs-writer/schema.ts';
import type { PipelineLogger } from '../sdk/pipeline-logger.ts';
import type { PRReviewComment } from '../sdk/azure-devops-client.ts';
import type { OverlayManifest } from '../overlay/types.ts';

// ---------------------------------------------------------------------------
// PipelineConfig — loaded from env + CLI flags at startup
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  azureDevOps: {
    organization: string;
    orgUrl: string;
    project: string;
    repositoryId: string;
    repositoryName: string;
    ciPipelineId: number;
    cdPipelineId: number;
    areaPath: string;
    iterationPath: string;
    pat: string;
  };

  paths: {
    /** Root of the session (e.g. /path/to/session-wi-12345) */
    sessionRoot: string;
    /** Path to the target extension repo within the session */
    targetRepo: string;
    /** Directory for pipeline state JSON files */
    stateDir: string;
  };

  checkpoints: {
    planApproval: {
      tag: string;
      rerunCommand: string;
      timeoutHours: number;
    };
    prPublished: {
      fixCommand: string;
      timeoutHours: number;
    };
    pollIntervalMinutes: number;
  };

  revisionLoops: {
    maxAttempts: number;
  };

  models: {
    default: string;
    /** Per-agent model overrides. Key = agent name. */
    perAgent?: Record<string, string>;
  };

  costs: {
    maxBudgetPerAgentUsd?: number;
    maxBudgetPerRunUsd?: number;
  };

  /** Private overlay manifest, loaded once at startup (empty `{}` when no overlay
   *  is installed). Carries proprietary pipeline edits, repo/companion additions,
   *  model overrides, etc. See src/overlay. */
  overlay?: OverlayManifest;

  environment?: {
    /** BC version profile ID. Optional: when undefined, env-provision's resolver
     *  reads source app.json platform + queries the environment profile portal to pick a profile. */
    profileId?: string;
    /** Apps in dependency order for installing deps */
    appPaths: string[];
    /** Path to the environment CLI relative to session root (default: '.tools/env-cli.exe') */
    envCli: string;
  };

  /** Target repo directory name (e.g., 'YourApp') */
  repoKey: string;
  /** Directory layout within the target repo */
  layout: { appRoot: string; source: string; testAppRoot: string; test: string };
  /** Companion repo names for preflight validation */
  companions?: Record<string, { branch?: string; readOnly?: boolean }>;
  /** Stage names active in this pipeline run (used by dashboard to distinguish skipped vs pending) */
  activeStages?: string[];
}

// ---------------------------------------------------------------------------
// PipelineContext — immutable context for a single pipeline run
// ---------------------------------------------------------------------------

/**
 * Transient liveness marker for the agent currently executing inside a revision loop.
 * Persisted to the DB for the dashboard, but NON-DURABLE: the orchestrator strips it on
 * load and never threads it into the carried state object.
 */
export interface ActiveAgentMarker {
  name: string;                       // the running Stage.name, e.g. 'plan-reviewer'
  loop: string;                       // owning loop stage name, e.g. 'planning'
  role: 'producer' | 'reviewer';
  iteration: number;                  // current attempt, 1-based
  startedAt: string;                  // ISO timestamp when this sub-step began
}

export interface PipelineContext {
  workItemId: number;
  workItem: WorkItem;
  workItemType: 'Bug' | 'User Story';
  config: PipelineConfig;
  logger?: PipelineLogger;
  /**
   * Best-effort callback to report the agent currently running inside a stage.
   * Provided per-stage by the orchestrator; only revisionLoop calls it. Never throws.
   */
  reportActiveAgent?: (state: PipelineState, marker: ActiveAgentMarker | null) => Promise<void>;
}

/** Minimal work item shape from Azure DevOps */
export interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string[];
  areaPath: string;
  iterationPath: string;
  assignedTo?: string;
  /** Raw fields map for anything not explicitly modelled */
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test case failure types — used by /fix-test command
// ---------------------------------------------------------------------------

export interface TestCaseFailureStep {
  stepNumber: number;
  action: string;
  expectedResult: string;
  comment: string | null;
}

export interface TestCaseFailure {
  testCaseId: number;
  title: string;
  outcome: string;
  failedSteps: TestCaseFailureStep[];
}

// ---------------------------------------------------------------------------
// PipelineState — mutable bag of accumulated stage results
// ---------------------------------------------------------------------------

export interface PipelineState {
  currentStage: string;
  /** Transient liveness marker (see ActiveAgentMarker). Non-durable — stripped on load. */
  activeAgent?: ActiveAgentMarker;

  // Stage outputs (populated as pipeline progresses)
  readiness?: ReadinessReport;
  devPlan?: DevPlan;
  planReviews?: ReviewVerdict[];
  changeset?: Changeset;
  codeReviews?: ReviewVerdict[];
  draftPR?: DraftPullRequest;
  testCases?: TestCasesOutput;
  testCaseReviews?: ReviewVerdict[];
  testCaseActivation?: { activatedAt: string };
  workItemUpdate?: WorkItemUpdate;
  docsWriterDrafts?: DocsWriterOutput;
  learnedRules?: unknown;

  // Error state
  error?: {
    type: string;
    stage: string;
    message: string;
    timestamp: string;
    /** SDK result subtype (e.g. 'error_max_turns', 'error_max_budget') */
    subtype?: string;
    /** Cost incurred before failure */
    costUsd?: number;
    /** Duration before failure */
    durationMs?: number;
    /** Number of turns completed before failure */
    turns?: number;
  };

  // Checkpoint state (persisted across continue calls)
  checkpoint?: {
    name: string;
    enteredAt: string;
    lastPolledAt?: string;
    reminderSentAt?: string;
  };

  // Human revision feedback (from /rerun-plan or /fix)
  revisionFeedback?: {
    source: 'work-item-comment' | 'pr-comment' | 'dashboard';
    feedback: string;
    targetStage: string;
  };

  // Human feedback content for agents (survives orchestrator rewind, consumed after first iteration)
  humanFeedback?: {
    rerunComment: string;
    source: 'work-item-comment' | 'pr-comment';
    prReviewComments?: PRReviewComment[];
    /** LLM-generated narrative summary of PR review comments (for planner) */
    commentSummary?: string;
    /** Human discussion comments from the work item (since checkpoint entry) */
    workItemComments?: Array<{ author: string; text: string; createdDate: string }>;
    testCaseFailures?: TestCaseFailure[];
  };

  // Rerun mode set by checkpoint commands (e.g., /fix sets 'fix')
  rerunMode?: 'fix' | 'fix-test';

  // Skip resetState on next revision loop entry (set when continuing after revision-exhausted)
  skipResetState?: boolean;

  // Persisted revision-loop attempt budget, keyed by loop name (e.g. 'coding',
  // 'planning'). Survives crashes/resumes so the circuit breaker caps TOTAL
  // attempts, not per-execute() attempts. Reset to 0 on approval or when a human
  // explicitly grants a fresh budget (rerunMode / skipResetState).
  revisionAttempts?: Record<string, number>;

  // BC test environment (provisioned by env-provision stage)
  environment?: {
    envId: string;
    url: string;
    description: string;
    profileId: string;
    createdAt: string;

    // Resolved by env-provision; informational/traceability for dashboard + logs.
    bcVersion?: string;

    // Credentials for bc-mcp; populated by env-provision after fetching from the environment CLI.
    credentials?: {
      username: string;
      password: string;
      tenantId: string;
      selectedBy: 'flag' | 'config-override' | 'fallback-Tll';
    };

    // Staged readiness flags.
    coreActivated?: boolean; // env + baseline app + InternalActivation core activation done
    activated?: boolean;     // bc-activation wizard completed; bc-mcp safe to wire in
    wizardNotes?: string;    // free-form notes from bc-activation agent
  };

  // Cost & telemetry
  telemetry: TelemetryData;

  // Pipeline metadata
  startedAt: string;
  completedAt?: string;
}

export interface TelemetryData {
  totalCostUsd: number;
  totalDurationMs: number;
  stages: StageTelemetry[];
}

export interface StageTelemetry {
  name: string;
  costUsd: number;
  durationMs: number;
  turns: number;
  model: string;
  startedAt?: string;
  timestamp: string;
  toolCalls?: Record<string, number>;
  /** Token usage from the SDK result. Optional — absent on telemetry recorded before this was captured. */
  tokens?: StageTokenUsage;
  /** SDK result subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries' | 'error_during_execution'. */
  subtype?: string;
}

/** Prompt/output token breakdown for a single agent run. */
export interface StageTokenUsage {
  /** Uncached input (prompt) tokens. */
  input: number;
  /** Output (completion) tokens. */
  output: number;
  /** Prompt tokens served from the cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache. */
  cacheCreation: number;
}

// ---------------------------------------------------------------------------
// Review verdict — minimal shared shape for all review agents
// ---------------------------------------------------------------------------

/**
 * Minimal shape that all review agent outputs must satisfy.
 * Individual schemas (PlanReview, CodeReview) extend this
 * with their own issue structures and extra fields.
 */
export interface ReviewVerdict {
  verdict: 'approve' | 'revise';
  feedback: string;
}

// ---------------------------------------------------------------------------
// Stage — the unit of pipeline composition
// ---------------------------------------------------------------------------

export interface Stage {
  readonly name: string;
  canRun(state: PipelineState): boolean;
  execute(state: PipelineState, context: PipelineContext): Promise<PipelineState>;
}

export type PipelineDefinition = Stage[];

// ---------------------------------------------------------------------------
// Checkpoint detection strategies
// ---------------------------------------------------------------------------

export interface TagCheckpoint {
  type: 'tag';
  tag: string;
}

export interface DraftPRCheckpoint {
  type: 'draft-pr';
}

export interface PRCompletedCheckpoint {
  type: 'pr-completed';
}

export type CheckpointDetection = TagCheckpoint | DraftPRCheckpoint | PRCompletedCheckpoint;

// ---------------------------------------------------------------------------
// Checkpoint config
// ---------------------------------------------------------------------------

export interface CheckpointConfig {
  name: string;
  detect: CheckpointDetection;
  /** @deprecated Use rerunCommands instead */
  rerunCommand?: string;
  /** @deprecated Use rerunCommands instead */
  rewindToStage?: string;
  /** Multiple rerun commands this checkpoint can respond to (checked in order, first match wins) */
  rerunCommands?: Array<{
    command: string;
    rewindToStage: string;
    rerunMode?: string;
    /** Tag to remove from work item when this command triggers */
    removeTag?: string;
    /** Whether to generate an LLM summary of PR review comments for the target agent */
    summarizeComments?: boolean;
  }>;
  timeoutHours?: number;
  pollIntervalMinutes?: number;
}

// ---------------------------------------------------------------------------
// Revision loop config
// ---------------------------------------------------------------------------

export interface RevisionLoopConfig {
  name: string;
  producer: Stage;
  reviewer: Stage;
  maxAttempts: number;
  isApproved: (state: PipelineState) => boolean;
  resetState?: (state: PipelineState) => PipelineState;
  /** Optional hook that runs after the producer and before the reviewer on each iteration. */
  postProducer?: (state: PipelineState, context: PipelineContext) => Promise<PipelineState>;
}

// ---------------------------------------------------------------------------
// Pipeline status (for CLI display)
// ---------------------------------------------------------------------------

export type PipelineStatus =
  | 'not-started'
  | 'running'
  | 'checkpoint-waiting'
  | 'failed'
  | 'stalled'
  | 'completed';
