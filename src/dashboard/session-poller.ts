import { readAllSessions } from './state-reader.ts';
import { sessionChangeKey } from './session-key.ts';
import type { IStateStore, StateWatermark } from '../pipeline/state-store.interface.ts';

// Evict entries not seen recently once the known-sessions map grows large, so a
// long-lived dashboard process doesn't leak memory over months of history.
const STALE_EVICTION_THRESHOLD = 500;
const STALE_MS = 3_600_000; // 1 hour

interface KnownSessionEntry {
  key: string;
  lastSeen: number;
}

/**
 * Polls the state store for new/changed sessions written by other processes
 * (pipeline containers write directly to the DB) and broadcasts an SSE
 * `session-update` event per changed session.
 *
 * Gated behind a cheap watermark (row count + max(updated_at)) when the store
 * supports it: the expensive `readAllSessions()` scan — listAll() + load() per
 * work item + full JSONB deserialize + stage-progression compute — only runs
 * when the watermark has actually moved since the last poll. Stores without
 * `getWatermark()` (e.g. the legacy file-based StateStore) always scan,
 * preserving prior behavior for them.
 */
export class SessionPoller {
  private readonly knownSessions = new Map<number, KnownSessionEntry>();
  private lastWatermark: StateWatermark | null = null;

  constructor(
    private readonly stateStore: IStateStore,
    private readonly broadcast: (event: string, data: unknown) => void,
  ) {}

  async poll(): Promise<void> {
    try {
      let watermark: StateWatermark | null = null;
      if (this.stateStore.getWatermark) {
        watermark = await Promise.resolve(this.stateStore.getWatermark());
        const unchanged =
          this.lastWatermark !== null &&
          watermark.count === this.lastWatermark.count &&
          watermark.maxUpdatedAt === this.lastWatermark.maxUpdatedAt;
        if (unchanged) return; // nothing changed since last poll — skip the full scan
      }

      const now = Date.now();
      const allSessions = await readAllSessions(this.stateStore);
      for (const session of allSessions) {
        const key = sessionChangeKey(session);
        const existing = this.knownSessions.get(session.workItemId);
        if (existing?.key !== key) {
          this.knownSessions.set(session.workItemId, { key, lastSeen: now });
          this.broadcast('session-update', session);
        } else {
          existing.lastSeen = now;
        }
      }

      // Evict entries not seen in the last hour (stale sessions)
      if (this.knownSessions.size > STALE_EVICTION_THRESHOLD) {
        const staleThreshold = now - STALE_MS;
        for (const [id, entry] of this.knownSessions) {
          if (entry.lastSeen < staleThreshold) this.knownSessions.delete(id);
        }
      }

      // Only latch the watermark once the scan + broadcast above have completed
      // without throwing. If we latched it eagerly (right after fetching it) and
      // the scan then threw, the next poll would see an "unchanged" watermark and
      // skip the retry entirely — silently dropping SSE updates until some
      // unrelated write bumped the watermark again.
      if (watermark !== null) this.lastWatermark = watermark;
    } catch {
      /* non-critical */
    }
  }
}
