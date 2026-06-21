import { describe, test, expect, afterEach } from 'bun:test';
import { readSession, readAllSessions } from '../../src/dashboard/state-reader.ts';
import { StateStore } from '../../src/pipeline/state-store.ts';
import type { PipelineState, PipelineConfig } from '../../src/types/pipeline.types.ts';
import type { StageProgress } from '../../src/dashboard/types.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function setup(): StateStore {
  tempDir = mkdtempSync(join(tmpdir(), 'state-reader-test-'));
  return new StateStore(tempDir);
}

function cleanup(): void {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function freshState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    currentStage: 'analyzer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function freshConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'example-org', orgUrl: 'https://dev.azure.com/example-org', project: 'Proj',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'A', iterationPath: 'I', pat: 'secret',
    },
    paths: { sessionRoot: '/tmp/session', targetRepo: '/tmp/doc', stateDir: tempDir },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 24 },
      prPublished: { fixCommand: '/fix', timeoutHours: 48 },
      pollIntervalMinutes: 5,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

/** Helper: read a session after saving state, return the session */
async function saveAndRead(store: StateStore, workItemId: number, state: PipelineState, config?: PipelineConfig) {
  store.save(workItemId, state);
  if (config) store.saveConfig(workItemId, config);
  return (await readSession(workItemId, store))!;
}

function stageNames(stages: StageProgress[]): string[] {
  return stages.map((s) => s.name);
}

function stageStatuses(stages: StageProgress[]): string[] {
  return stages.map((s) => s.status);
}

// ---------------------------------------------------------------------------
// deriveStatus (tested via session.status)
// ---------------------------------------------------------------------------

describe('state-reader: deriveStatus', () => {
  afterEach(cleanup);

  test('running pipeline → status "running"', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      startedAt: new Date().toISOString(),
    }));
    expect(session.status).toBe('running');
  });

  test('stalled pipeline → status "stalled" when no activity for 30+ minutes', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    expect(session.status).toBe('stalled');
  });

  test('completed pipeline → status "completed"', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'documenter',
      completedAt: '2024-01-01T01:00:00.000Z',
    }));
    expect(session.status).toBe('completed');
  });

  test('failed pipeline → status "failed"', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'boom', timestamp: '2024-01-01T00:30:00.000Z' },
    }));
    expect(session.status).toBe('failed');
  });

  test('checkpoint waiting → status "checkpoint-waiting"', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
    }));
    expect(session.status).toBe('checkpoint-waiting');
  });
});

// ---------------------------------------------------------------------------
// computeStageProgression (tested via session.stages)
// ---------------------------------------------------------------------------

describe('state-reader: stage progression', () => {
  afterEach(cleanup);

  test('all 12 stages are present with correct names', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState());
    expect(stageNames(session.stages)).toEqual([
      'analyzer', 'planning', 'checkpoint:plan-approved', 'env-provision',
      'coding', 'test-cases', 'draft-pr', 'checkpoint:pr-published',
      'test-case-activation', 'checkpoint:pr-completed', 'documenter', 'docs-writer',
    ]);
  });

  test('stage labels are human-readable', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState());
    expect(session.stages.map((s) => s.label)).toEqual([
      'Analyze', 'Plan', 'Plan Approval', 'Environment',
      'Code', 'Tests', 'Draft PR', 'PR Published',
      'Activate Tests', 'PR Completed', 'Document', 'Docs Drafts',
    ]);
  });

  test('loop and checkpoint flags are set correctly', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState());
    const byName = Object.fromEntries(session.stages.map((s) => [s.name, s]));

    expect(byName['planning']!.isLoop).toBe(true);
    expect(byName['coding']!.isLoop).toBe(true);
    expect(byName['test-cases']!.isLoop).toBe(true);
    expect(byName['checkpoint:plan-approved']!.isCheckpoint).toBe(true);
    expect(byName['checkpoint:pr-published']!.isCheckpoint).toBe(true);
    expect(byName['checkpoint:pr-completed']!.isCheckpoint).toBe(true);

    // Regular agent stages have neither flag
    expect(byName['analyzer']!.isLoop).toBeUndefined();
    expect(byName['analyzer']!.isCheckpoint).toBeUndefined();
    expect(byName['draft-pr']!.isLoop).toBeUndefined();
    expect(byName['draft-pr']!.isCheckpoint).toBeUndefined();
    expect(byName['env-provision']!.isLoop).toBeUndefined();
    expect(byName['env-provision']!.isCheckpoint).toBeUndefined();
  });

  test('pipeline at first stage → first active, rest pending', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'analyzer' }));
    expect(stageStatuses(session.stages)).toEqual([
      'active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  test('pipeline at coding → earlier stages completed, coding active, rest pending', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'coding' }));
    // coding is at index 4: analyzer, planning, checkpoint:plan-approved, env-provision completed; coding active; rest pending
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'active', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  test('pipeline at draft-pr → stages 0-5 completed, draft-pr active', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'draft-pr' }));
    // draft-pr is at index 6
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'active', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  test('pipeline at documenter → all prior completed, documenter active', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'documenter' }));
    // documenter is at index 10
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'active', 'pending',
    ]);
  });

  test('completed pipeline → all stages completed', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'documenter',
      completedAt: '2024-01-01T01:00:00.000Z',
    }));
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed',
    ]);
  });

  test('error at coding → coding shows error, prior completed, rest pending', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'fail', timestamp: '2024-01-01T00:30:00.000Z' },
    }));
    // coding is at index 4
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'error', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint stage name matching (the bug we fixed)
// ---------------------------------------------------------------------------

describe('state-reader: checkpoint stage names', () => {
  afterEach(cleanup);

  test('checkpoint:plan-approved → plan-approved shows waiting, prior completed', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:20:00.000Z' },
    }));
    // checkpoint:plan-approved is at index 2
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'waiting', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  test('checkpoint:pr-published → stages through draft-pr completed, pr-published waiting', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
    }));
    // checkpoint:pr-published is at index 7
    expect(stageStatuses(session.stages)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'waiting', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  test('checkpoint stage name includes prefix in session data', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
    }));
    expect(session.currentStage).toBe('checkpoint:pr-published');
    expect(session.checkpoint!.name).toBe('pr-published');
  });
});

// ---------------------------------------------------------------------------
// Revision iteration counting
// ---------------------------------------------------------------------------

describe('state-reader: revision iterations', () => {
  afterEach(cleanup);

  test('plan reviews counted as iterations on planning stage', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      planReviews: [
        { verdict: 'revise', feedback: 'fix it', issues: [], strengths: [] } as any,
        { verdict: 'approve', feedback: 'good', issues: [], strengths: [] } as any,
      ],
    }));
    const planning = session.stages.find((s) => s.name === 'planning')!;
    expect(planning.iterations).toBe(2);
  });

  test('code reviews counted as iterations on coding stage', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'draft-pr',
      codeReviews: [
        { verdict: 'revise', feedback: 'change x', issues: [], strengths: [] } as any,
        { verdict: 'revise', feedback: 'change y', issues: [], strengths: [] } as any,
        { verdict: 'approve', feedback: 'ok', issues: [], strengths: [] } as any,
      ],
    }));
    const coding = session.stages.find((s) => s.name === 'coding')!;
    expect(coding.iterations).toBe(3);
  });

  test('no reviews → no iterations field', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'coding' }));
    const planning = session.stages.find((s) => s.name === 'planning')!;
    expect(planning.iterations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toSession: pass-through and config stripping
// ---------------------------------------------------------------------------

describe('state-reader: session structure', () => {
  afterEach(cleanup);

  test('agent outputs are passed through to session', async () => {
    const store = setup();
    const readiness = { verdict: 'proceed', enrichedContext: {} as any, gaps: [], summary: 'ok' };
    const devPlan = { summary: 'plan', objects: [], testScenarios: [] };
    const draftPR = { title: 'PR', sourceBranch: 'feat', targetBranch: 'master', linkedWorkItemId: 1, isDraft: true };

    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:pr-published',
      checkpoint: { name: 'pr-published', enteredAt: '2024-01-01T00:30:00.000Z' },
      readiness: readiness as any,
      devPlan: devPlan as any,
      draftPR: draftPR as any,
    }));

    expect(session.readiness).toEqual(readiness);
    expect(session.devPlan).toEqual(devPlan);
    expect(session.draftPR).toEqual(draftPR);
  });

  test('config is stripped to safe fields (no PAT)', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState(), freshConfig());

    expect(session.config).toBeDefined();
    expect(session.config!.organization).toBe('example-org');
    expect(session.config!.project).toBe('Proj');
    expect(session.config!.sessionRoot).toBe('/tmp/session');
    // PAT must NOT leak to the dashboard
    expect((session.config as any).pat).toBeUndefined();
  });

  test('error data is included in session', async () => {
    const store = setup();
    const err = { type: 'AgentExecutionError', stage: 'coding', message: 'crash', timestamp: '2024-01-01T00:30:00.000Z' };
    const session = await saveAndRead(store, 1, freshState({ currentStage: 'coding', error: err }));
    expect(session.error).toEqual(err);
  });

  test('checkpoint data is included in session', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:20:00.000Z', lastPolledAt: '2024-01-01T00:25:00.000Z' },
    }));
    expect(session.checkpoint).toEqual({
      name: 'plan-approved',
      enteredAt: '2024-01-01T00:20:00.000Z',
      lastPolledAt: '2024-01-01T00:25:00.000Z',
    });
  });

  test('revision feedback is included in session', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'planning',
      revisionFeedback: { source: 'work-item-comment', feedback: 'redo it', targetStage: 'planning' },
    }));
    expect(session.revisionFeedback).toEqual({
      source: 'work-item-comment',
      feedback: 'redo it',
      targetStage: 'planning',
    });
  });
});

// ---------------------------------------------------------------------------
// readSession / readAllSessions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// availableActions
// ---------------------------------------------------------------------------

describe('state-reader: availableActions', () => {
  afterEach(cleanup);

  test('running pipeline → no availableActions', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      startedAt: new Date().toISOString(),
    }));
    expect(session.availableActions).toBeUndefined();
  });

  test('completed pipeline → no availableActions', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'documenter',
      completedAt: '2024-01-01T01:00:00.000Z',
    }));
    expect(session.availableActions).toBeUndefined();
  });

  test('plan checkpoint → includes approve-plan and rerun-plan', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'checkpoint:plan-approved',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:20:00.000Z' },
    }));
    expect(session.availableActions).toContain('approve-plan');
    expect(session.availableActions).toContain('rerun-plan');
  });

  test('failed pipeline → includes continue', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, freshState({
      currentStage: 'coding',
      error: { type: 'AgentExecutionError', stage: 'coding', message: 'crash', timestamp: '2024-01-01T00:30:00.000Z' },
    }));
    expect(session.availableActions).toContain('continue');
    expect(session.availableActions).toContain('fix');
  });
});

// ---------------------------------------------------------------------------
// readSession / readAllSessions
// ---------------------------------------------------------------------------

describe('state-reader: readSession', () => {
  afterEach(cleanup);

  test('returns null for missing work item', async () => {
    const store = setup();
    const session = await readSession(999, store);
    expect(session).toBeNull();
  });

  test('returns session for valid work item', async () => {
    const store = setup();
    store.save(42, freshState());
    const session = await readSession(42, store);
    expect(session).not.toBeNull();
    expect(session!.workItemId).toBe(42);
  });
});

describe('state-reader: activeAgent phase', () => {
  afterEach(cleanup);

  // A recent startedAt is required, otherwise deriveStatus returns 'stalled' (30-min threshold)
  // and the marker would be ignored for the wrong reason.
  function running(overrides: Partial<PipelineState> = {}): PipelineState {
    return freshState({ startedAt: new Date().toISOString(), ...overrides });
  }

  function planningMarker(role: 'producer' | 'reviewer', iteration = 1) {
    return { name: role === 'reviewer' ? 'plan-reviewer' : 'planner', loop: 'planning', role, iteration, startedAt: new Date().toISOString() };
  }

  test('reviewer phase: parent gets activePhase=reviewer and reviewer dot active', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({ currentStage: 'planning', activeAgent: planningMarker('reviewer') }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.status).toBe('active');
    expect(plan.activePhase).toBe('reviewer');
    expect(plan.reviewer!.status).toBe('active');
  });

  test('producer phase: parent active, no activePhase, reviewer dot pending', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({ currentStage: 'planning', activeAgent: planningMarker('producer') }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.status).toBe('active');
    expect(plan.activePhase).toBeUndefined();
    expect(plan.reviewer!.status).toBe('pending');
  });

  test('iteration count comes live from the marker', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({ currentStage: 'planning', activeAgent: planningMarker('producer', 3) }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.iterations).toBe(3);
  });

  test('marker ignored when status is not running (e.g. checkpoint)', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({
      currentStage: 'planning',
      checkpoint: { name: 'plan-approved', enteredAt: '2024-01-01T00:00:00.000Z' },
      activeAgent: planningMarker('reviewer'),
    }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.activePhase).toBeUndefined();
  });

  test('marker ignored when currentStage != marker.loop (stale)', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({ currentStage: 'coding', activeAgent: planningMarker('reviewer') }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.activePhase).toBeUndefined();
  });

  test('marker ignored when shape is invalid', async () => {
    const store = setup();
    const bad = { name: 'x', loop: 'planning', role: 'bogus', iteration: 0, startedAt: 'not-a-date' } as any;
    const session = await saveAndRead(store, 1, running({ currentStage: 'planning', activeAgent: bad }));
    const plan = session.stages.find((s) => s.name === 'planning')!;
    expect(plan.activePhase).toBeUndefined();
  });

  test('toSession passes the raw activeAgent through', async () => {
    const store = setup();
    const session = await saveAndRead(store, 1, running({ currentStage: 'planning', activeAgent: planningMarker('reviewer') }));
    expect(session.activeAgent?.role).toBe('reviewer');
  });
});

describe('state-reader: readAllSessions', () => {
  afterEach(cleanup);

  test('returns all sessions', async () => {
    const store = setup();
    store.save(42, freshState());
    store.save(100, freshState({ currentStage: 'coding' }));

    const sessions = await readAllSessions(store);
    const ids = sessions.map((s) => s.workItemId).sort((a, b) => a - b);
    expect(ids).toEqual([42, 100]);
  });

  test('returns empty array when no sessions exist', async () => {
    const store = setup();
    const sessions = await readAllSessions(store);
    expect(sessions).toEqual([]);
  });

  test('skips work items with config but no state', async () => {
    const store = setup();
    store.save(42, freshState());
    store.saveConfig(42, freshConfig());
    store.saveConfig(100, freshConfig()); // config only, no state

    const sessions = await readAllSessions(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.workItemId).toBe(42);
  });
});
