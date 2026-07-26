import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineLogger } from '../../src/sdk/pipeline-logger.ts';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import type { ILogSink, LogEntry, LogPage } from '../../src/pipeline/log-sink.interface.ts';
import type { Stage, PipelineState, PipelineContext } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Log attribution — which agent produced a log entry
//
// A revision loop runs its producer and its reviewer inside ONE top-level stage,
// so both write under the same `stage_name` ('coding'). Querying stage_logs by
// 'code-reviewer' returned nothing and the reviewer looked like it had never
// run. The stage name is right; the agent axis was the missing one.
// ---------------------------------------------------------------------------

/** Records what each write would persist, including the agent attribution. */
class RecordingSink implements ILogSink {
  readonly rows: Array<{ stage: string; agent: string | null; content: string }> = [];
  private agentName: string | null = null;

  setAgentName(name: string): void {
    this.agentName = name || null;
  }

  write(stageName: string, _entryType: string, content: string): void {
    this.rows.push({ stage: stageName, agent: this.agentName, content: content.trim() });
  }

  readStageLog(): LogEntry[] { return []; }
  readAllStages(): string[] { return []; }
  readStageLogPage(): LogPage {
    return { entries: [], hasMoreBefore: false, oldestId: null, newestId: null };
  }
}

function makeLogger(sink: ILogSink): { logger: PipelineLogger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'log-attr-'));
  return {
    logger: new PipelineLogger(join(dir, 'logs'), 42, sink),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('PipelineLogger agent attribution', () => {
  test('forwards the agent name to the sink without an onAgentName forwarder', () => {
    // The pipeline never registered one — routing attribution *only* through
    // that hook is what made every pipeline row's agent_name NULL.
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);

    logger.stageStart('coding');
    logger.setAgentName('coder');
    logger.log('wrote a codeunit');
    logger.setAgentName('code-reviewer');
    logger.log('found 3 issues');

    expect(sink.rows.map(r => r.agent)).toEqual([null, 'coder', 'code-reviewer']);
    // stage name is unchanged — 'coding' really is the stage
    expect(new Set(sink.rows.map(r => r.stage))).toEqual(new Set(['coding']));
    cleanup();
  });

  test('an empty name clears attribution rather than keeping the last agent', () => {
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);

    logger.stageStart('coding');
    logger.setAgentName('coder');
    logger.log('agent line');
    logger.setAgentName('');
    logger.log('orchestrator line');
    expect(sink.rows.at(-1)!.content).toContain('orchestrator line');

    expect(sink.rows.at(-1)!.agent).toBeNull();
    cleanup();
  });

  test('stageStart resets attribution so a stage never inherits the previous agent', () => {
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);

    logger.stageStart('coding');
    logger.setAgentName('code-reviewer');
    logger.log('reviewed');
    logger.stageStart('draft-pr');
    logger.log('stage bookkeeping');

    const drafts = sink.rows.filter(r => r.stage === 'draft-pr');
    expect(drafts.every(r => r.agent === null)).toBe(true);
    cleanup();
  });

  test('still calls a registered onAgentName forwarder', () => {
    const seen: string[] = [];
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);
    logger.onAgentName(name => seen.push(name));

    logger.stageStart('coding');
    logger.setAgentName('coder');

    expect(seen).toEqual(['', 'coder']);
    cleanup();
  });

  test('a sink without setAgentName is not a crash', () => {
    const rows: string[] = [];
    const bare: ILogSink = {
      write: (_s, _t, c) => { rows.push(c.trim()); },
      readStageLog: () => [],
      readAllStages: () => [],
    };
    const { logger, cleanup } = makeLogger(bare);

    logger.stageStart('coding');
    logger.setAgentName('coder');
    logger.log('fine');

    expect(rows.at(-1)).toContain('fine');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// revisionLoop — its own bookkeeping belongs to no agent
// ---------------------------------------------------------------------------

function loopContext(logger: PipelineLogger): PipelineContext {
  return {
    workItemId: 1,
    workItem: {
      id: 1, title: 'T', type: 'Bug', state: 'Active',
      areaPath: 'A', iterationPath: 'A', fields: {},
    },
    workItemType: 'Bug',
    logger,
    config: {
      azureDevOps: {
        organization: 'o', orgUrl: 'https://o', project: 'P',
        repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
        areaPath: 'A', iterationPath: 'A', pat: 'p',
      },
      paths: { sessionRoot: '/tmp', targetRepo: '/tmp/r', stateDir: '/tmp/s' },
      checkpoints: {
        planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
        prPublished: { fixCommand: '/f', timeoutHours: 1 },
        pollIntervalMinutes: 1,
      },
      revisionLoops: { maxAttempts: 3 },
      models: { default: 'test' },
      costs: {},
      repoKey: 'R',
      layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
    },
  };
}

/** Stand-in for agentStage: claims attribution, logs, leaves it set (as a real run does). */
function attributingStage(name: string, logLine: string, mutate: (s: PipelineState) => PipelineState): Stage {
  return {
    name,
    canRun: () => true,
    execute: async (state, context) => {
      context.logger?.setAgentName(name);
      context.logger?.log(logLine);
      return { state: mutate(state) };
    },
  };
}

describe('revisionLoop log attribution', () => {
  test('producer and reviewer output are separable inside one stage', async () => {
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);
    let approved = false;

    const loop = revisionLoop({
      name: 'coding',
      producer: attributingStage('coder', 'wrote code', s => ({ ...s, changeset: {} as never })),
      reviewer: attributingStage('code-reviewer', 'reviewed code', s => {
        approved = true;
        return s;
      }),
      isApproved: () => approved,
      maxAttempts: 3,
    });

    logger.stageStart('coding');
    await loop.execute(
      { currentStage: 'coding', telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] }, startedAt: '' },
      loopContext(logger),
    );

    // log() prefixes an ISO timestamp; assert on the message, not the prefix.
    const byAgent = (agent: string | null) =>
      sink.rows.filter(r => r.agent === agent).map(r => r.content.replace(/^\[[^\]]+\]\s*/, ''));

    expect(byAgent('coder')).toEqual(['wrote code']);
    expect(byAgent('code-reviewer')).toEqual(['reviewed code']);

    // Everything the loop itself wrote stays unattributed — crediting
    // "Iteration 1/3" to whichever agent last ran would be worse than blank.
    const loopLines = byAgent(null).join('\n');
    expect(loopLines).toContain('Iteration 1/3');
    expect(loopLines).toContain('Running reviewer');
    expect(loopLines).toContain('Reviewer approved on attempt 1');

    // and the stage axis is untouched
    expect(new Set(sink.rows.map(r => r.stage))).toEqual(new Set(['coding']));
    cleanup();
  });

  test('a second iteration attributes each agent again, not just the first round', async () => {
    const sink = new RecordingSink();
    const { logger, cleanup } = makeLogger(sink);
    let reviews = 0;

    const loop = revisionLoop({
      name: 'coding',
      producer: attributingStage('coder', 'wrote code', s => s),
      reviewer: attributingStage('code-reviewer', 'reviewed code', s => { reviews++; return s; }),
      isApproved: () => reviews >= 2,
      maxAttempts: 3,
    });

    logger.stageStart('coding');
    await loop.execute(
      { currentStage: 'coding', telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] }, startedAt: '' },
      loopContext(logger),
    );

    expect(sink.rows.filter(r => r.agent === 'coder')).toHaveLength(2);
    expect(sink.rows.filter(r => r.agent === 'code-reviewer')).toHaveLength(2);
    expect(sink.rows.filter(r => r.agent === null && r.content.includes('Revision 1/3'))).toHaveLength(1);
    cleanup();
  });
});
