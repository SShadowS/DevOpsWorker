import { useEffect, useRef } from 'preact/hooks';
import {
  activeLogViewer,
  logStages,
  logEntries,
  logHasMoreBefore,
  logLoadingOlder,
  selectLogStage,
  loadOlderLogEntries,
  closeLogViewer,
} from '../store.ts';
import type { LogEntry } from '../../../pipeline/log-sink.interface.ts';

function entryClass(type: string): string {
  const map: Record<string, string> = {
    header: 'log-entry--header',
    prompt: 'log-entry--prompt',
    log: 'log-entry--log',
    json: 'log-entry--json',
    complete: 'log-entry--complete',
    error: 'log-entry--error',
  };
  return map[type] ?? 'log-entry--log';
}

function formatTimestamp(entry: LogEntry, firstTimestamp: string | null): string {
  if (!firstTimestamp) return '';
  const diff = new Date(entry.createdAt).getTime() - new Date(firstTimestamp).getTime();
  if (isNaN(diff)) return '';
  const secs = (diff / 1000).toFixed(1);
  return `+${secs}s`;
}

export function LogViewer() {
  const viewer = activeLogViewer.value;
  if (!viewer) return null;

  const stages = logStages.value;
  const entries = logEntries.value;
  const hasMoreBefore = logHasMoreBefore.value;
  const loadingOlder = logLoadingOlder.value;
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstTimestamp = entries.length > 0 ? entries[0]!.createdAt : null;

  // Whether the user is parked at (near) the bottom — gates auto-scroll.
  const pinnedRef = useRef(true);
  // When prepending older entries, the distance-from-bottom to restore after render.
  const prependAnchorRef = useRef<number | null>(null);
  // Reset the pin when switching stages so a fresh tail scrolls to bottom.
  const lastStageRef = useRef<string | null>(null);
  if (lastStageRef.current !== viewer.selectedStage) {
    lastStageRef.current = viewer.selectedStage;
    pinnedRef.current = true;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependAnchorRef.current != null) {
      // Older entries were just prepended — keep the viewport visually stable.
      el.scrollTop = el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const onLoadOlder = (): void => {
    const el = scrollRef.current;
    prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    void loadOlderLogEntries();
  };

  return (
    <div class="log-viewer">
      <div class="log-viewer__header">
        <h2>Logs — #{viewer.workItemId}</h2>
        <button class="log-viewer__close" onClick={closeLogViewer} title="Close">✕</button>
      </div>
      <div class="log-viewer__body">
        <div class="log-viewer__sidebar">
          {stages.map((stage) => (
            <button
              key={stage}
              class={`log-viewer__stage ${viewer.selectedStage === stage ? 'log-viewer__stage--active' : ''}`}
              onClick={() => selectLogStage(stage)}
            >
              {stage}
            </button>
          ))}
          {stages.length === 0 && <span class="log-viewer__empty">No stages</span>}
        </div>
        <div class="log-viewer__content" ref={scrollRef} onScroll={onScroll}>
          {hasMoreBefore && (
            <button class="log-viewer__load-older" onClick={onLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load older entries'}
            </button>
          )}
          {entries.map((entry) => (
            <div key={entry.id} class={`log-entry ${entryClass(entry.entryType)}`}>
              <span class="log-entry__time">{formatTimestamp(entry, firstTimestamp)}</span>
              <pre class="log-entry__content">{entry.content}</pre>
            </div>
          ))}
          {entries.length === 0 && viewer.selectedStage && (
            <span class="log-viewer__empty">No log entries for this stage.</span>
          )}
        </div>
      </div>
    </div>
  );
}
