import type { ILogSink, LogEntry } from '../pipeline/log-sink.interface.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';

const POLL_INTERVAL_MS = 2000;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const MAX_POLL_BATCH = 500;

interface PollerState {
  timer: Timer;
  lastId: number;
  lastAccess: number;
  /** Poll is a no-op until lastId is seeded to the current latest id. */
  initialized: boolean;
}

export class LogPoller {
  private pollers = new Map<number, PollerState>();

  constructor(
    private readonly logSink: (workItemId: number) => ILogSink,
    private readonly stateStore: IStateStore,
    private readonly broadcast: (event: string, data: unknown) => void,
  ) {}

  startOrRefresh(workItemId: number): void {
    const existing = this.pollers.get(workItemId);
    if (existing) {
      existing.lastAccess = Date.now();
      return;
    }

    const state: PollerState = {
      timer: setInterval(() => this.poll(workItemId), POLL_INTERVAL_MS),
      lastId: 0,
      lastAccess: Date.now(),
      initialized: false,
    };
    this.pollers.set(workItemId, state);

    // Seed lastId to the current latest so we only stream entries created AFTER
    // the viewer opened — never replay the (potentially huge) backlog over SSE.
    const sink = this.logSink(workItemId);
    if (sink.readLatestLogId) {
      Promise.resolve(sink.readLatestLogId())
        .then((latest) => {
          const p = this.pollers.get(workItemId);
          if (p && !p.initialized) {
            p.lastId = latest;
            p.initialized = true;
          }
        })
        .catch(() => {
          const p = this.pollers.get(workItemId);
          if (p) p.initialized = true; // fail open — start streaming from 0
        });
    } else {
      state.initialized = true;
    }
  }

  stopPolling(workItemId: number): void {
    const p = this.pollers.get(workItemId);
    if (p) {
      clearInterval(p.timer);
      this.pollers.delete(workItemId);
    }
  }

  private async poll(workItemId: number): Promise<void> {
    const p = this.pollers.get(workItemId);
    if (!p) return;
    if (!p.initialized) return; // wait until lastId is seeded

    try {
      const state = await this.stateStore.load(workItemId);
      const isRunning = state && !state.completedAt && !state.error && !state.checkpoint;

      const inactive = Date.now() - p.lastAccess > INACTIVITY_TIMEOUT_MS;
      if (!isRunning || inactive) {
        this.stopPolling(workItemId);
        return;
      }

      const sink = this.logSink(workItemId);
      if (!sink.readNewEntries) return;
      const entries: LogEntry[] = await sink.readNewEntries(p.lastId, MAX_POLL_BATCH);

      for (const entry of entries) {
        this.broadcast('log-entry', {
          workItemId,
          stageName: entry.stage_name,
          entry,
        });
        if (entry.id > p.lastId) p.lastId = entry.id;
      }
    } catch {
      // Polling errors are non-fatal — retry next interval
    }
  }
}
