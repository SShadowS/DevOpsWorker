import type { AgentConfig } from './agent.types.ts';
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
    /**
     * Reasoning effort passed to the SDK. `undefined` leaves the SDK default
     * (`'high'`), which is what every run before this knob existed used.
     *
     * Thinking tokens bill at OUTPUT rates, so this is a cost lever that keeps the
     * model — a different trade from switching to a cheaper model, which was measured
     * to downgrade the review verdict.
     *
     * The SDK SILENTLY DOWNGRADES a level the model does not support, so a run using
     * this must verify what actually applied rather than trust what was requested.
     */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };

  costs: {
    maxBudgetPerAgentUsd?: number;
    maxBudgetPerRunUsd?: number;
  };

  /**
   * The raw database `settings` rows this config was built from (see
   * `readAllSettingsSafely` / `buildModelsAndCosts` in `src/cli/config.ts`).
   * `undefined`/`{}` when the settings table had nothing stored, was
   * unreachable, or this config was built by a path that predates settings
   * (e.g. a bare test fixture) — same fallback contract as every other
   * settings consumer.
   *
   * Carried through so `resolveDbAgentKnobs` (`src/cli/config.ts`) can look up
   * ONE agent's database override at the `runAgent` chokepoint without a second
   * database round-trip. Deliberately NOT the same thing as `models.perAgent`
   * above: that field already falls back to a hardcoded per-agent default map
   * when no database row exists, so treating it as "the database said so" would
   * let a checked-in default outrank an overlay override or the agent's own
   * config — exactly backwards for `resolveAgentKnobs`'s database-wins
   * precedence. This field is the untouched settings snapshot, so a lookup
   * against it is `undefined` unless an operator actually set something.
   */
  settingsApplied?: Record<string, unknown>;

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

/**
 * An image from a work item, already downloaded to local disk.
 *
 * Work item descriptions embed screenshots as `<img>` tags pointing at Azure
 * DevOps attachment URLs. Those URLs need PAT authentication, and the reading
 * agents have no tool that can fetch one — so the URL alone tells an agent that
 * a picture exists and nothing about what is in it. Downloading first turns it
 * into a file path the `Read` tool can open and actually look at.
 */
export interface WorkItemImage {
  /** Absolute path of the downloaded file. */
  path: string;
  /** File name as Azure DevOps named it (often just `image.png`). */
  fileName: string;
  /** The attachment URL it came from — the same string that appears in the description HTML. */
  sourceUrl: string;
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
  /**
   * Images embedded in the description, downloaded to local disk.
   *
   * Absent when nothing has downloaded them yet; empty when the work item has
   * none, or when every download failed (a failure is logged, never fatal).
   */
  images?: WorkItemImage[];
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
// PipelineStateSlices — agent-owned extension points for PipelineState
// ---------------------------------------------------------------------------

/**
 * Open interface each agent augments with the state field it OWNS (its output
 * slice). Core deliberately leaves this empty so it never imports agent schemas
 * — inverting the old god-type coupling where `PipelineState` imported all 7
 * agent output schemas and every new agent meant editing core.
 *
 * Each agent registers its slice next to its schema via TS module augmentation:
 *
 * ```ts
 * // src/agents/planner/schema.ts
 * declare module '../../types/pipeline.types.ts' {
 *   interface PipelineStateSlices {
 *     devPlan?: DevPlan;
 *   }
 * }
 * ```
 *
 * `PipelineState extends Partial<PipelineStateSlices>`, so the augmented fields
 * appear on `state` with the same names + optionality they had inline. The
 * augmenting files live under `src/agents/**`, which every tsconfig include glob
 * pulls in (core `tsconfig.json` and the composed `tsconfig.private.json`), so
 * the fields stay visible to core, tests, AND the private overlay.
 */
export interface PipelineStateSlices {}

// ---------------------------------------------------------------------------
// PipelineState — mutable bag of accumulated stage results
// ---------------------------------------------------------------------------

export interface PipelineState extends Partial<PipelineStateSlices> {
  currentStage: string;
  /** Transient liveness marker (see ActiveAgentMarker). Non-durable — stripped on load. */
  activeAgent?: ActiveAgentMarker;

  // Stage outputs owned by agents are contributed via PipelineStateSlices
  // augmentation (see above): readiness (analyzer), devPlan (planner),
  // changeset (coder), draftPR (draft-pr), testCases (test-cases),
  // workItemUpdate (documenter), docsWriterDrafts (docs-writer).
  //
  // The remaining stage outputs below are core frame fields (shared
  // ReviewVerdict shape or plain inline types), NOT agent output schemas.
  planReviews?: ReviewVerdict[];
  codeReviews?: ReviewVerdict[];
  testCaseReviews?: ReviewVerdict[];
  testCaseActivation?: { activatedAt: string };
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

  /**
   * Why the last revision-loop gate refused an otherwise-approved round — e.g.
   * the reviewer approved but an env conjunct was false. Rendered into the next
   * round's producer prompt; without it the producer gets no signal which
   * conjunct failed (WI 76447's recorded finding, live again on WI 81098 where
   * the env conjuncts made every round unapprovable). Cleared on approval.
   */
  gateFailure?: string;

  /**
   * Issue counts per round, keyed by loop name. The convergence trigger's input.
   * Reset when a human answers an escalation — their input is a new starting
   * condition, and carrying the old plateau forward would re-escalate at once.
   */
  revisionIssueCounts?: Record<string, number[]>;

  /**
   * Set when a revision loop stopped because its findings plateaued rather than
   * because it was approved or out of budget. Drives the escalation comment and
   * is cleared on re-entry so the loop does not immediately pause again.
   */
  convergenceEscalation?: {
    loop: string;
    /** Issue count per round, oldest first. */
    issueCounts: number[];
    /** Findings that recurred across rounds — the ones iteration is not resolving. */
    recurringFindings: string[];
    question: string;
    escalatedAt: string;
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
      selectedBy: 'flag' | 'config-override' | 'fallback-default';
    };

    // Staged readiness flags.
    coreActivated?: boolean; // env + baseline app + overlay activation done
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
  /** SDK session id — the join key back to this run's transcript. `pr_reviews`
   *  has carried this as a column for a while; stage telemetry did not, so a
   *  stage run could not be traced to the session that produced it. Optional:
   *  absent on telemetry recorded before this was captured. */
  sessionId?: string;
  /** Sha of the image this stage ran in, read from the `BUILD_SHA` baked into it.
   *  A spawned container is not handed a BUILD_SHA by `getContainerEnv()`, so
   *  this is the STAGE's own image, not the watcher's — which is the point:
   *  "the container silently ran stale code" is otherwise invisible after the
   *  fact. Absent for local runs and for images built without the build-arg. */
  imageSha?: string;
  /** Per-model cost/token split — separates an orchestrator from its sub-agents. */
  modelUsage?: Record<string, StageModelUsage>;
  /** Per-named-sub-agent usage, keyed by subagent_type. Present only for
   *  orchestrators that dispatched sub-agents. */
  subAgents?: Record<string, SubAgentUsage>;
  /** SDK result subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries' | 'error_during_execution'. */
  subtype?: string;
}

/**
 * Per-model cost and token usage within one agent run.
 *
 * An orchestrator's `costUsd` is a single total covering itself AND every
 * sub-agent it dispatches, so it cannot answer "was the cost the orchestrator or
 * the fan-out?". When the orchestrator and its sub-agents run on different models
 * — which is the normal configuration — this map splits them: the SDK reports
 * usage keyed by model id, so a `code-reviewer` on Opus with eight sub-agents on
 * Sonnet yields one entry each.
 *
 * Keyed by the raw model id the SDK reports.
 */
export interface StageModelUsage {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Usage for one *named* sub-agent within an orchestrator's run.
 *
 * `StageModelUsage` splits by model, which cannot separate sub-agents that share
 * one — the eight `code-reviewer` sub-agents all run on the same model, so a
 * model-keyed split lumps them together. Attribution here is per dispatch: the
 * SDK tags each assistant message with the `subagent_type` that produced it.
 *
 * `apportionedCostUsd` is DERIVED, not reported by the SDK: the model's total
 * cost shared out by each sub-agent's token count. Treat it as an estimate — it
 * assumes uniform per-token pricing within a model, which holds today but is not
 * guaranteed. `tokens`, `turns` and `toolCalls` are measured.
 */
export interface SubAgentUsage {
  /** The `subagent_type` dispatched, e.g. 'security-reviewer'. */
  name: string;
  turns: number;
  tokens: StageTokenUsage;
  toolCalls: Record<string, number>;
  /** Model this sub-agent ran on, as reported on its assistant messages.
   *  Undefined for `background_task` entries — the SDK's task messages do not
   *  report a model, so absence here is "not reported", never "inherited". */
  model?: string;
  /**
   * Where this entry came from, because the two sources know different things.
   *
   * `stream` — reconstructed from the sub-agent's own assistant messages: turns,
   * the input/output/cache token split, per-tool counts and the model are all
   * measured.
   *
   * `background_task` — the sub-agent ran as a background task and never streamed
   * into the parent, so only the coarse per-task usage the SDK reports is known.
   * `turns`, `tokens` and `toolCalls` stay ZERO on these entries and that is NOT
   * a claim the sub-agent did nothing — read `totalTokens` / `toolUseCount`
   * instead. Before these entries existed the sub-agent was absent entirely,
   * which is how a stage could dispatch four and record one.
   */
  source?: 'stream' | 'background_task';
  /** Total tokens for a `background_task` entry. The SDK reports one figure per
   *  task with no input/output/cache split, so it is deliberately NOT folded into
   *  `tokens` — doing that would silently corrupt every consumer of the split. */
  totalTokens?: number;
  /** Tool-use COUNT for a `background_task` entry. The SDK reports a count per
   *  task, not the per-tool breakdown `toolCalls` carries for streamed entries. */
  toolUseCount?: number;
  /** Wall-clock duration for a `background_task` entry, as reported by the SDK. */
  durationMs?: number;
  /**
   * DERIVED, not SDK-reported. The SDK bills one total per run and splits it only
   * by model, so eight sub-agents sharing Sonnet share one number. This estimates
   * each one's share of its model's cost by token count. Treat it as an
   * attribution estimate for comparing sub-agents, not as a billed figure —
   * per-token prices differ between input/output/cache, so a sub-agent that is
   * output-heavy is under-counted relative to a cache-read-heavy one.
   */
  apportionedCostUsd?: number;
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
  /** Instructions for the producer when `verdict === 'revise'`. */
  revisionInstructions?: string;
  // NOTE: `issues` is deliberately absent. PlanReview and CodeReview findings do
  // not share a shape — one carries `description` + `relatedObject`, the other
  // `comment` + `filePath` — and this file must not import agent output schemas
  // (see the note on `planReviews`/`codeReviews` above). An agent that needs to
  // read back its own findings narrows at the read site instead.
}

// ---------------------------------------------------------------------------
// Stage — the unit of pipeline composition
// ---------------------------------------------------------------------------

/**
 * Explicit control-flow signal a stage returns to the orchestrator.
 *
 * This is how a stage tells the orchestrator to halt or rewind — replacing the
 * old implicit channel where the orchestrator sniffed `state.checkpoint` /
 * `state.revisionFeedback` off the returned state. Those state fields are still
 * set + persisted (external observers — the watcher, dashboard, and resume path
 * read them), but they no longer drive the orchestrator's in-loop decision.
 *
 * - `pause`  — the pipeline should stop and wait for human action (a checkpoint
 *   that isn't satisfied yet). The checkpoint stage also sets `state.checkpoint`.
 * - `rewind` — the pipeline should jump back to `targetStage` (a checkpoint that
 *   detected a `/rerun-*` command). The checkpoint stage also sets
 *   `state.revisionFeedback` (persisted, so a later resume can rewind too).
 */
export type StageSignal =
  | { kind: 'pause' }
  | { kind: 'rewind'; targetStage: string };

/**
 * Return value of `Stage.execute`. Carries the (possibly mutated) state plus an
 * optional control-flow signal. Absent `signal` means "continue to the next
 * stage" — the common case for agent stages.
 */
export interface StageResult {
  state: PipelineState;
  signal?: StageSignal;
}

export interface Stage {
  readonly name: string;
  canRun(state: PipelineState): boolean;
  execute(state: PipelineState, context: PipelineContext): Promise<StageResult>;
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
  /**
   * When `isApproved` refuses a round, name why — but only when the refusal
   * would otherwise be invisible (e.g. the reviewer approved and a non-review
   * conjunct failed). Return undefined when the reviewer's own revision
   * instructions already carry the reason. Stored as `state.gateFailure` for
   * the next round's producer prompt; cleared on approval.
   */
  explainGate?: (state: PipelineState) => string | undefined;
  resetState?: (state: PipelineState) => PipelineState;
  /** Optional hook that runs after the producer and before the reviewer on each iteration. */
  postProducer?: (state: PipelineState, context: PipelineContext) => Promise<PipelineState>;
  /**
   * Total findings the reviewer reported this round, or undefined if it cannot be
   * determined. Supplied per-loop because only the pipeline definition knows which
   * state field holds a given loop's reviews — the loop itself stays generic.
   *
   * Feeds the convergence trigger below. Without it the loop only ever stops on
   * approval or budget exhaustion.
   */
  countIssues?: (state: PipelineState) => number | undefined;
  /**
   * Finding texts per round, oldest first — used to name what keeps recurring in
   * the escalation comment. Same reason as `countIssues`: only the definition
   * knows where a loop's reviews live. Optional; omitting it just yields a less
   * specific comment.
   */
  collectFindingTexts?: (state: PipelineState) => string[][];
  /**
   * Stop iterating when the issue count stops falling, instead of burning the
   * remaining budget. Omit to disable.
   *
   * The count failing to decrease is the only measured signal that separated both
   * observed non-convergence failures from the one success: a loop whose findings
   * plateau is not converging, and further rounds spend money to confirm it.
   * WI 63396 ran 8 rounds into three figures of spend and 0 merges.
   */
  convergence?: {
    /**
     * Rounds of flat-or-rising issue count that trigger escalation. 3 means "by
     * the third round with no decrease, stop". Counted raw, not severity-weighted
     * — weight only if raw misfires (a round trading 3 minors for 1 critical is
     * worse, not better, but that has not been observed to matter yet).
     */
    window: number;
    /** Question posted to the work item when the loop escalates. */
    question: string;
  };
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
