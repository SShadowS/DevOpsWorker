import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IPRReviewStore } from '../pipeline/pr-review-store.interface.ts';
import type { IActionStore } from '../pipeline/action-store.interface.ts';
import type { PipelineState, PipelineStatus, PipelineConfig, ActiveAgentMarker } from '../types/pipeline.types.ts';
import type { DashboardSession, DashboardPRReview, DashboardPRReviewDetail, StageProgress } from './types.ts';
import { getAvailableActions } from './actions.ts';
import { getRepoConfig } from '../config/repos.ts';

/**
 * Build the Azure DevOps PR web URL for a repo key, resolved from the live repo
 * registry (overlay-populated at startup). The public core ships no registrations,
 * so this returns null when the key is unknown — the client then renders a plain
 * label instead of a broken placeholder link.
 */
function buildPrWebUrl(repoKey: string, prId: number): string | null {
  let ado: ReturnType<typeof getRepoConfig>['azureDevOps'];
  try {
    ado = getRepoConfig(repoKey).azureDevOps;
  } catch {
    return null;
  }
  const base = ado.orgUrl ?? (ado.organization ? `https://dev.azure.com/${ado.organization}` : null);
  if (!base) return null;
  const seg = (s: string) => encodeURIComponent(s);
  return `${base.replace(/\/$/, '')}/${seg(ado.project)}/_git/${seg(ado.repositoryName)}/pullrequest/${prId}`;
}

// ---------------------------------------------------------------------------
// Stage mapping — mirrors pipeline-definition.ts
// ---------------------------------------------------------------------------

const STAGE_DEFS: {
  name: string;
  label: string;
  stateField: keyof PipelineState;
  isLoop?: boolean;
  isCheckpoint?: boolean;
  iterationsField?: keyof PipelineState;
  reviewerLabel?: string;
  reviewerStage?: string;
}[] = [
  { name: 'analyzer', label: 'Analyze', stateField: 'readiness' },
  { name: 'planning', label: 'Plan', stateField: 'devPlan', isLoop: true, iterationsField: 'planReviews', reviewerLabel: 'Review', reviewerStage: 'plan-reviewer' },
  { name: 'checkpoint:plan-approved', label: 'Plan Approval', stateField: 'checkpoint', isCheckpoint: true },
  { name: 'env-provision', label: 'Environment', stateField: 'environment' },
  { name: 'coding', label: 'Code', stateField: 'changeset', isLoop: true, iterationsField: 'codeReviews', reviewerLabel: 'Review', reviewerStage: 'code-reviewer' },
  { name: 'test-cases', label: 'Tests', stateField: 'testCases', isLoop: true, iterationsField: 'testCaseReviews', reviewerLabel: 'Review', reviewerStage: 'test-case-reviewer' },
  { name: 'draft-pr', label: 'Draft PR', stateField: 'draftPR' },
  { name: 'checkpoint:pr-published', label: 'PR Published', stateField: 'checkpoint', isCheckpoint: true },
  { name: 'test-case-activation', label: 'Activate Tests', stateField: 'testCaseActivation' },
  { name: 'checkpoint:pr-completed', label: 'PR Completed', stateField: 'checkpoint', isCheckpoint: true },
  { name: 'documenter', label: 'Document', stateField: 'workItemUpdate' },
  { name: 'docs-writer', label: 'Docs Drafts', stateField: 'docsWriterDrafts' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readAllSessions(stateStore: IStateStore): Promise<DashboardSession[]> {
  const sessions: DashboardSession[] = [];

  let workItemIds: number[];
  try {
    workItemIds = await stateStore.listAll();
  } catch {
    return [];
  }

  for (const workItemId of workItemIds) {
    const session = await readSession(workItemId, stateStore);
    if (session) sessions.push(session);
  }

  return sessions;
}

export async function readSession(
  workItemId: number,
  stateStore: IStateStore,
): Promise<DashboardSession | null> {
  const state = await stateStore.load(workItemId);
  if (!state) return null;

  const config = await stateStore.loadConfig(workItemId);

  return toSession(workItemId, state, config);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** How long since last telemetry activity before we consider a pipeline stalled */
const STALLED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function deriveStatus(state: PipelineState): PipelineStatus {
  if (state.completedAt) return 'completed';
  if (state.error) return 'failed';
  if (state.checkpoint) return 'checkpoint-waiting';

  // Detect stalled pipelines: no completion, no error, no checkpoint,
  // and no telemetry activity for a while (container likely crashed)
  const lastActivity = getLastActivityTime(state);
  if (lastActivity && Date.now() - lastActivity > STALLED_THRESHOLD_MS) return 'stalled';

  return 'running';
}

/** Parse a date string to epoch ms, returning null if invalid. */
function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Convert epoch ms to ISO string, returning null if invalid. */
function toISOSafe(ms: number | null): string | null {
  if (ms == null || Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function getLastActivityTime(state: PipelineState): number | null {
  const candidates: number[] = [];

  const started = parseMs(state.startedAt);
  if (started != null) candidates.push(started);

  // Last telemetry entry timestamp
  const lastStage = state.telemetry?.stages?.at(-1);
  const ts = parseMs(lastStage?.timestamp);
  if (ts != null) candidates.push(ts);

  const stageStart = parseMs(lastStage?.startedAt);
  if (stageStart != null) {
    candidates.push(stageStart + lastStage!.durationMs);
  }

  const markerStart = parseMs(state.activeAgent?.startedAt);
  if (markerStart != null) candidates.push(markerStart);

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/** Trust the activeAgent marker only when it is live, shape-valid, and for the current loop. */
function effectiveActiveAgent(state: PipelineState, status: PipelineStatus): ActiveAgentMarker | undefined {
  const a = state.activeAgent;
  if (status !== 'running' || !a) return undefined;
  if (state.currentStage !== a.loop) return undefined;
  if (a.role !== 'producer' && a.role !== 'reviewer') return undefined;
  if (!Number.isInteger(a.iteration) || a.iteration < 1) return undefined;
  if (Number.isNaN(Date.parse(a.startedAt))) return undefined;
  return a;
}

function computeStageProgression(state: PipelineState, status: PipelineStatus, activeStages?: string[]): StageProgress[] {
  const marker = effectiveActiveAgent(state, status);
  const currentIdx = STAGE_DEFS.findIndex((d) => d.name === state.currentStage);

  return STAGE_DEFS.map((def, idx) => {
    // If activeStages is provided and this stage isn't in it, mark as skipped
    if (activeStages && !activeStages.includes(def.name)) {
      return {
        name: def.name,
        label: def.label,
        status: 'skipped' as const,
        isLoop: def.isLoop,
        isCheckpoint: def.isCheckpoint,
      };
    }

    let stageStatus: StageProgress['status'];

    if (status === 'completed') {
      // All stages done
      stageStatus = 'completed';
    } else if (idx < currentIdx) {
      stageStatus = 'completed';
    } else if (idx === currentIdx) {
      if (state.error) {
        stageStatus = 'error';
      } else if (def.isCheckpoint && state.checkpoint) {
        stageStatus = 'waiting';
      } else {
        stageStatus = 'active';
      }
    } else {
      stageStatus = 'pending';
    }

    const progress: StageProgress = {
      name: def.name,
      label: def.label,
      status: stageStatus,
      ...(def.isLoop && { isLoop: true }),
      ...(def.isCheckpoint && { isCheckpoint: true }),
    };

    // Count revision iterations
    if (def.iterationsField) {
      const reviews = state[def.iterationsField];
      if (Array.isArray(reviews) && reviews.length > 0) {
        progress.iterations = reviews.length;
      }
    }

    // Live in-flight iteration + producer/reviewer phase from the marker
    if (marker && def.name === marker.loop) {
      progress.iterations = marker.iteration;
      if (marker.role === 'reviewer') progress.activePhase = 'reviewer';
    }

    // Derive reviewer sub-stage status for revision loops
    if (def.reviewerLabel && def.reviewerStage) {
      let reviewerStatus: StageProgress['status'];
      if (stageStatus === 'completed') {
        reviewerStatus = 'completed';
      } else if (stageStatus === 'pending') {
        reviewerStatus = 'pending';
      } else if (marker && def.name === marker.loop && marker.role === 'reviewer') {
        reviewerStatus = 'active';
      } else if (stageStatus === 'active') {
        // Producer phase (or no marker) — reviewer hasn't started yet
        reviewerStatus = 'pending';
      } else {
        reviewerStatus = stageStatus; // error, etc.
      }
      progress.reviewer = { label: def.reviewerLabel, status: reviewerStatus };
    }

    return progress;
  });
}

function stripConfig(config: PipelineConfig): DashboardSession['config'] {
  return {
    organization: config.azureDevOps.organization,
    project: config.azureDevOps.project,
    sessionRoot: config.paths.sessionRoot,
  };
}

function toSession(
  workItemId: number,
  state: PipelineState,
  config: PipelineConfig | null,
): DashboardSession {
  const status = deriveStatus(state);
  const session: DashboardSession = {
    workItemId,
    status,
    currentStage: state.currentStage,
    startedAt: state.startedAt,
    lastActivityAt: toISOSafe(getLastActivityTime(state)) ?? state.startedAt,
    completedAt: state.completedAt,
    stages: computeStageProgression(state, status, config?.activeStages),
    telemetry: state.telemetry ?? { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
  };

  if (state.activeAgent) session.activeAgent = state.activeAgent;

  if (state.error) session.error = state.error;

  if (state.checkpoint) {
    session.checkpoint = {
      name: state.checkpoint.name,
      enteredAt: state.checkpoint.enteredAt,
      lastPolledAt: state.checkpoint.lastPolledAt,
    };
  }

  if (state.revisionFeedback) session.revisionFeedback = state.revisionFeedback;
  if (config?.azureDevOps) session.config = stripConfig(config);

  const available = getAvailableActions(state);
  if (available.length > 0) session.availableActions = available;

  // Extract title from readiness report if available
  const title = state.readiness?.enrichedContext?.title;
  if (title) session.title = title;

  // Agent outputs (pass-through for frontend rendering)
  if (state.readiness) session.readiness = state.readiness;
  if (state.devPlan) session.devPlan = state.devPlan;
  if (state.planReviews?.length) session.planReviews = state.planReviews;
  if (state.changeset) session.changeset = state.changeset;
  if (state.codeReviews?.length) session.codeReviews = state.codeReviews;
  if (state.draftPR) session.draftPR = state.draftPR;
  if (state.workItemUpdate) session.workItemUpdate = state.workItemUpdate;
  if (state.learnedRules) session.learnedRules = state.learnedRules;
  if (state.testCases) session.testCases = state.testCases;
  if (state.testCaseReviews?.length) session.testCaseReviews = state.testCaseReviews;
  if (state.docsWriterDrafts) session.docsWriterDrafts = state.docsWriterDrafts;
  if (state.environment) session.environment = state.environment;
  if (state.humanFeedback) session.humanFeedback = state.humanFeedback;
  if (config?.activeStages) session.activeStages = config.activeStages;
  if ((state as any).legacySkipped) session.legacySkipped = (state as any).legacySkipped;

  return session;
}

export async function readPRReviews(store: IPRReviewStore, actionStore?: IActionStore): Promise<DashboardPRReview[]> {
  const rows = await store.listRecent(100);
  const completed = rows.map(r => ({
    id: r.id,
    prId: r.prId,
    repoKey: r.repoKey,
    sourceBranch: r.sourceBranch,
    targetBranch: r.targetBranch,
    title: r.title,
    recommendation: r.recommendation,
    findings: r.findings,
    findingsCount: r.findingsCount,
    costUsd: r.costUsd,
    durationMs: r.durationMs,
    turns: r.turns,
    toolCalls: r.toolCalls,
    error: r.error,
    createdAt: r.createdAt,
    webUrl: buildPrWebUrl(r.repoKey, r.prId),
    pendingStatus: undefined as 'queued' | 'reviewing' | undefined,
  }));

  // Merge pending/in-progress reviews from the action queue
  if (actionStore?.listPendingReviews) {
    const pending = await actionStore.listPendingReviews();
    const completedPrIds = new Set(completed.map(r => r.prId));
    for (const p of pending) {
      if (completedPrIds.has(p.prId)) continue; // Already have a completed review
      completed.unshift({
        id: -p.prId, // Negative ID to distinguish from real rows
        prId: p.prId,
        repoKey: p.repoKey,
        sourceBranch: p.sourceBranch,
        targetBranch: '',
        title: null,
        recommendation: null,
        findings: null,
        findingsCount: null,
        costUsd: null,
        durationMs: null,
        turns: null,
        toolCalls: null,
        error: null,
        createdAt: p.createdAt,
        webUrl: buildPrWebUrl(p.repoKey, p.prId),
        pendingStatus: p.status,
      });
    }
  }

  return completed;
}

export async function readPRReviewDetail(store: IPRReviewStore, id: number): Promise<DashboardPRReviewDetail | null> {
  const r = await store.findById(id);
  if (!r) return null;
  return {
    id: r.id, prId: r.prId, repoKey: r.repoKey, sourceBranch: r.sourceBranch,
    targetBranch: r.targetBranch, title: r.title, recommendation: r.recommendation,
    findings: r.findings, findingsCount: r.findingsCount, costUsd: r.costUsd,
    durationMs: r.durationMs, turns: r.turns, toolCalls: r.toolCalls, error: r.error,
    createdAt: r.createdAt, webUrl: buildPrWebUrl(r.repoKey, r.prId),
    pendingStatus: undefined, reviewBody: r.reviewBody,
  };
}
