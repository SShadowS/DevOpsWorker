import { describe, test, expect } from 'bun:test';
import { SessionPoller } from '../../src/dashboard/session-poller.ts';
import type { IStateStore, StateWatermark } from '../../src/pipeline/state-store.interface.ts';
import type { PipelineConfig, PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Fake IStateStore — counts full-scan calls (listAll) so tests can assert
// whether SessionPoller actually paid for the expensive readAllSessions() path.
// ---------------------------------------------------------------------------

class FakeStateStore implements IStateStore {
  listAllCalls = 0;
  private readonly states = new Map<number, PipelineState>();
  private watermark: StateWatermark = { count: 0, maxUpdatedAt: null };

  setState(workItemId: number, state: PipelineState): void {
    this.states.set(workItemId, state);
  }

  setWatermark(watermark: StateWatermark): void {
    this.watermark = watermark;
  }

  async exists(workItemId: number): Promise<boolean> {
    return this.states.has(workItemId);
  }

  async load(workItemId: number): Promise<PipelineState | null> {
    return this.states.get(workItemId) ?? null;
  }

  async save(): Promise<void> {}

  async saveConfig(): Promise<void> {}

  async loadConfig(): Promise<PipelineConfig | null> {
    return null;
  }

  async listAll(): Promise<number[]> {
    this.listAllCalls++;
    return [...this.states.keys()];
  }

  async getWatermark(): Promise<StateWatermark> {
    return this.watermark;
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

describe('SessionPoller', () => {
  test('skips the full scan when the watermark is unchanged', async () => {
    const store = new FakeStateStore();
    store.setState(1, freshState());
    store.setWatermark({ count: 1, maxUpdatedAt: '2024-01-01T00:00:00.000Z' });

    const broadcasts: Array<[string, unknown]> = [];
    const poller = new SessionPoller(store, (event, data) => broadcasts.push([event, data]));

    // First poll: no prior watermark recorded, so it always scans.
    await poller.poll();
    expect(store.listAllCalls).toBe(1);
    expect(broadcasts.length).toBe(1);

    // Second poll: watermark identical to last time -> full scan must be skipped.
    await poller.poll();
    expect(store.listAllCalls).toBe(1);
    expect(broadcasts.length).toBe(1);

    // Third poll, still unchanged -> still skipped.
    await poller.poll();
    expect(store.listAllCalls).toBe(1);
  });

  test('runs the full scan and broadcasts when the watermark advances', async () => {
    const store = new FakeStateStore();
    store.setState(1, freshState());
    store.setWatermark({ count: 1, maxUpdatedAt: '2024-01-01T00:00:00.000Z' });

    const broadcasts: Array<[string, unknown]> = [];
    const poller = new SessionPoller(store, (event, data) => broadcasts.push([event, data]));

    await poller.poll();
    expect(store.listAllCalls).toBe(1);
    expect(broadcasts.length).toBe(1);

    // A new session was written by another process: count advances.
    store.setState(2, freshState({ currentStage: 'planning' }));
    store.setWatermark({ count: 2, maxUpdatedAt: '2024-01-02T00:00:00.000Z' });

    await poller.poll();
    expect(store.listAllCalls).toBe(2);
    // Session 1 is unchanged (same change-key) so it does not re-broadcast;
    // session 2 is new, so exactly one additional broadcast fires.
    expect(broadcasts.length).toBe(2);
  });

  test('runs the full scan and broadcasts when an existing session updates (count unchanged)', async () => {
    const store = new FakeStateStore();
    store.setState(1, freshState());
    store.setWatermark({ count: 1, maxUpdatedAt: '2024-01-01T00:00:00.000Z' });

    const broadcasts: Array<[string, unknown]> = [];
    const poller = new SessionPoller(store, (event, data) => broadcasts.push([event, data]));

    await poller.poll();
    expect(store.listAllCalls).toBe(1);

    // Same session mutates (e.g. stage advances) -> count is unchanged but
    // maxUpdatedAt moves. The watermark must still catch this.
    store.setState(1, freshState({ currentStage: 'planning' }));
    store.setWatermark({ count: 1, maxUpdatedAt: '2024-01-01T00:05:00.000Z' });

    await poller.poll();
    expect(store.listAllCalls).toBe(2);
    expect(broadcasts.length).toBe(2);
  });

  test('always scans when the store has no getWatermark support', async () => {
    // A store without getWatermark (e.g. the legacy file-based StateStore)
    // must fall back to scanning on every poll.
    const store = new FakeStateStore();
    store.setState(1, freshState());
    (store as unknown as { getWatermark?: unknown }).getWatermark = undefined;

    const poller = new SessionPoller(store, () => {});

    await poller.poll();
    await poller.poll();
    await poller.poll();

    expect(store.listAllCalls).toBe(3);
  });
});
