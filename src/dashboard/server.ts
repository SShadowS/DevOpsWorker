import { existsSync } from 'fs';
import { join } from 'path';
import { readAllSessions, readSession, readPRReviews } from './state-reader.ts';
import { SessionPoller } from './session-poller.ts';
import { validateAction } from './actions.ts';
import type { PipelineAction } from './actions.ts';
import type { ActionType } from './types.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IActionStore } from '../pipeline/action-store.interface.ts';
import type { IRunnerStatus } from '../pipeline/runner-status.interface.ts';
import type { ILogSink } from '../pipeline/log-sink.interface.ts';
import type { IPRReviewStore } from '../pipeline/pr-review-store.interface.ts';
import { LogPoller } from './log-poller.ts';

// ---------------------------------------------------------------------------
// Learn-rules in-progress tracking
// ---------------------------------------------------------------------------

const learnRulesInProgress = new Set<number>();

// ---------------------------------------------------------------------------
// SSE client management
// ---------------------------------------------------------------------------

type SSEController = ReadableStreamDefaultController<Uint8Array>;
const clients = new Set<SSEController>();
const encoder = new TextEncoder();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const bytes = encoder.encode(payload);
  for (const controller of clients) {
    try {
      controller.enqueue(bytes);
    } catch {
      clients.delete(controller);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface DashboardOptions {
  port: number;
  stateStore: IStateStore;
  actionStore: IActionStore;
  runnerStatus: IRunnerStatus;
  logSink: (workItemId: number) => ILogSink;
  prReviewStore: IPRReviewStore;
}

export function startDashboard(options: DashboardOptions): void {
  const { port, stateStore, actionStore, runnerStatus, logSink, prReviewStore } = options;

  const logPoller = new LogPoller(logSink, stateStore, broadcastSSE);

  // Write heartbeat on startup and every 30 seconds
  const heartbeat = () => { void Promise.resolve(runnerStatus.writeHeartbeat('dashboard')).catch(() => {}); };
  heartbeat();
  setInterval(heartbeat, 30_000);

  // Wire up SSE broadcasts on state changes (same-process writes)
  stateStore.onChange = async (workItemId) => {
    const session = await readSession(workItemId, stateStore);
    if (session) broadcastSSE('session-update', session);
  };

  // Poll for new/changed sessions from other processes (pipeline containers write directly to DB).
  // Gated behind a cheap watermark inside SessionPoller — the full readAllSessions() scan only
  // runs when pipeline_state's row count or max(updated_at) has moved since the last poll.
  const sessionPoller = new SessionPoller(stateStore, broadcastSSE);
  const sessionPollInterval = setInterval(() => { void sessionPoller.poll(); }, 5_000);

  // Poll for PR review changes (new completions, status transitions)
  let lastPRReviewHash = '';
  const prReviewPollInterval = setInterval(async () => {
    try {
      const reviews = await readPRReviews(prReviewStore, actionStore);
      const hash = JSON.stringify(reviews.map(r => `${r.id}:${r.recommendation}:${r.pendingStatus}`));
      if (hash !== lastPRReviewHash) {
        lastPRReviewHash = hash;
        broadcastSSE('pr-review-update', reviews);
      }
    } catch { /* non-critical */ }
  }, 5_000);

  // Poll for action lifecycle changes (write/claim/complete/fail across watcher process)
  let lastActionsHash = '';
  const actionsPollInterval = setInterval(async () => {
    try {
      const actions = await actionStore.listRecent(100);
      const hash = JSON.stringify(actions.map(a => `${a.id}:${a.status}:${a.completedAt ?? ''}`));
      if (hash !== lastActionsHash) {
        lastActionsHash = hash;
        broadcastSSE('action-update', actions);
      }
    } catch { /* non-critical */ }
  }, 2_000);

  // Clean up on process exit
  process.on('beforeExit', () => {
    clearInterval(sessionPollInterval);
    clearInterval(prReviewPollInterval);
    clearInterval(actionsPollInterval);
  });

  const server = Bun.serve({
    port,
    idleTimeout: 255, // Max value — SSE connections are long-lived
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Action submission endpoint
      if (path === '/api/actions' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { workItemId?: number; type?: string; feedback?: string };
          if (!body.workItemId || !body.type) {
            return Response.json({ error: 'Missing workItemId or type' }, { status: 400 });
          }

          const { workItemId, type, feedback, email } = body as PipelineAction & { email?: string };

          // Validate env-share has email
          if (type === 'env-share' && !email) {
            return Response.json({ error: 'Email is required for env-share' }, { status: 400 });
          }

          const validTypes: ActionType[] = [
            'approve-plan', 'rerun-plan', 'fix', 'continue',
            'env-start', 'env-stop', 'env-delete', 'env-share', 'reprovision-env',
          ];
          if (!validTypes.includes(type as ActionType)) {
            return Response.json({ error: `Invalid action type: ${type}` }, { status: 400 });
          }

          const action: PipelineAction = {
            workItemId,
            type: type as ActionType,
            feedback,
            email,
            createdAt: new Date().toISOString(),
          };

          // Validate against current state
          const state = await stateStore.load(workItemId);
          const validation = validateAction(action, state);
          if (!validation.valid) {
            return Response.json({ error: validation.reason }, { status: 409 });
          }

          const actionId = await actionStore.write(action);
          return Response.json({ ok: true, actionId, action: action.type }, { status: 202 });
        } catch (err) {
          return Response.json({ error: 'Invalid request body' }, { status: 400 });
        }
      }

      // List recent actions (for dashboard initial load)
      if (path === '/api/actions/recent' && req.method === 'GET') {
        const limitParam = url.searchParams.get('limit');
        const limit = Math.min(Math.max(parseInt(limitParam ?? '100', 10) || 100, 1), 500);
        return Response.json(await actionStore.listRecent(limit));
      }

      // Learn-rules endpoint
      if (path === '/api/learn-rules' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { workItemId?: number };
          if (!body.workItemId) {
            return Response.json({ error: 'Missing workItemId' }, { status: 400 });
          }

          const workItemId = body.workItemId;
          const state = await stateStore.load(workItemId);
          if (!state || !state.draftPR?.id) {
            return Response.json({ error: 'No draft PR found for this work item' }, { status: 409 });
          }

          if (learnRulesInProgress.has(workItemId)) {
            return Response.json({ error: 'Learn rules already in progress for this work item' }, { status: 409 });
          }

          const prId = state.draftPR.id as number;
          learnRulesInProgress.add(workItemId);

          // Fire-and-forget: spawn learn-rules subprocess
          (async () => {
            try {
              const proc = Bun.spawn(
                ['bun', 'run', 'pipeline', '--', 'learn-rules', '--pr', String(prId), '--json'],
                { stdout: 'pipe', stderr: 'pipe' },
              );

              const exitCode = await proc.exited;
              const stdout = await new Response(proc.stdout).text();
              const stderr = await new Response(proc.stderr).text();

              if (exitCode === 0 && stdout.trim()) {
                try {
                  const result = JSON.parse(stdout.trim());
                  state.learnedRules = result;
                  await stateStore.save(workItemId, state);
                } catch {
                  state.learnedRules = { error: 'Failed to parse learn-rules output', stderr };
                  await stateStore.save(workItemId, state);
                }
              } else {
                state.learnedRules = { error: `learn-rules exited with code ${exitCode}`, stderr };
                await stateStore.save(workItemId, state);
              }
            } catch (err) {
              state.learnedRules = { error: `Failed to run learn-rules: ${err}` };
              await stateStore.save(workItemId, state);
            } finally {
              learnRulesInProgress.delete(workItemId);
            }
          })();

          return Response.json({ ok: true, prId }, { status: 202 });
        } catch {
          return Response.json({ error: 'Invalid request body' }, { status: 400 });
        }
      }

      // Force-poll: write a force-poll action so the watcher wakes and polls Azure DevOps
      if (path === '/api/force-poll' && req.method === 'POST') {
        try {
          await actionStore.write({
            workItemId: 0,
            type: 'force-poll',
            createdAt: new Date().toISOString(),
          });
          return Response.json({ ok: true }, { status: 202 });
        } catch {
          return Response.json({ error: 'Failed to write force-poll action' }, { status: 500 });
        }
      }

      // SSE endpoint
      if (path === '/api/events') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            clients.add(controller);
            // Send initial heartbeat
            controller.enqueue(encoder.encode(': connected\n\n'));
          },
          cancel(controller) {
            clients.delete(controller);
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      // JSON API: all sessions
      if (path === '/api/sessions') {
        return Response.json(await readAllSessions(stateStore));
      }

      // JSON API: PR reviews
      if (path === '/api/pr-reviews') {
        return Response.json(await readPRReviews(prReviewStore, actionStore));
      }

      // Log API: list stages for a work item
      const logStagesMatch = path.match(/^\/api\/sessions\/(\d+)\/logs$/);
      if (logStagesMatch && req.method === 'GET') {
        const id = parseInt(logStagesMatch[1]!, 10);
        const sink = logSink(id);
        const stages = await sink.readAllStages();
        logPoller.startOrRefresh(id);
        return Response.json(stages);
      }

      // Log API: bounded page of entries for a specific stage
      const logEntriesMatch = path.match(/^\/api\/sessions\/(\d+)\/logs\/(.+)$/);
      if (logEntriesMatch && req.method === 'GET') {
        const id = parseInt(logEntriesMatch[1]!, 10);
        const stageName = decodeURIComponent(logEntriesMatch[2]!);
        const sink = logSink(id);

        const DEFAULT_LOG_LIMIT = 500;
        const MAX_LOG_LIMIT = 1000;
        const reqLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = Number.isFinite(reqLimit)
          ? Math.min(Math.max(reqLimit, 1), MAX_LOG_LIMIT)
          : DEFAULT_LOG_LIMIT;
        const beforeRaw = parseInt(url.searchParams.get('beforeId') ?? '', 10);
        const beforeId = Number.isFinite(beforeRaw) ? beforeRaw : undefined;

        logPoller.startOrRefresh(id);

        if (sink.readStageLogPage) {
          const page = await sink.readStageLogPage(stageName, { limit, beforeId });
          return Response.json(page);
        }
        // Fallback for sinks without paged support: tail the full read.
        const all = await sink.readStageLog(stageName);
        const sliced = beforeId != null ? all.filter((e) => e.id < beforeId) : all;
        const entries = sliced.slice(-limit);
        return Response.json({
          entries,
          hasMoreBefore: sliced.length > entries.length,
          oldestId: entries.length > 0 ? entries[0]!.id : null,
          newestId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
        });
      }

      // JSON API: single session
      const sessionMatch = path.match(/^\/api\/sessions\/(\d+)$/);
      if (sessionMatch) {
        const id = parseInt(sessionMatch[1]!, 10);
        const session = await readSession(id, stateStore);
        if (!session) return Response.json({ error: 'Not found' }, { status: 404 });
        return Response.json(session);
      }

      // JSON API: runner status
      if (path === '/api/runners' && req.method === 'GET') {
        const status = await runnerStatus.readStatus();
        const heartbeats = await runnerStatus.readHeartbeats();
        return Response.json({
          ...(status ?? { active: 0, max: 0, workItemIds: [], updatedAt: null }),
          processes: heartbeats,
        });
      }

      // Set concurrency dynamically
      if (path === '/api/runners' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { maxConcurrency?: number };
          if (!body.maxConcurrency || body.maxConcurrency < 1) {
            return Response.json({ error: 'maxConcurrency must be >= 1' }, { status: 400 });
          }
          await runnerStatus.writeDynamicConcurrency(body.maxConcurrency);
          return Response.json({ ok: true, maxConcurrency: body.maxConcurrency });
        } catch {
          return Response.json({ error: 'Invalid request' }, { status: 400 });
        }
      }

      // Serve built client assets from dist/
      if (path === '/bundle.js' || path === '/index.js') {
        const jsPath = join(import.meta.dir, 'dist', 'index.js');
        if (existsSync(jsPath)) {
          return new Response(Bun.file(jsPath), {
            headers: { 'Content-Type': 'application/javascript' },
          });
        }
      }

      if (path === '/dashboard.css') {
        const cssPath = join(import.meta.dir, 'dist', 'index.css');
        if (existsSync(cssPath)) {
          return new Response(Bun.file(cssPath), {
            headers: { 'Content-Type': 'text/css' },
          });
        }
      }

      // Serve index.html for root
      if (path === '/' || path === '/index.html') {
        return new Response(Bun.file(join(import.meta.dir, 'index.html')), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`Pipeline Dashboard running at http://localhost:${server.port}`);
}
