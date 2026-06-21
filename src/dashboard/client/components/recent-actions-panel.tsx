import { useSignal, useComputed } from '@preact/signals';
import { actions } from '../store.ts';
import { formatRelativeTime } from '../format.ts';
import type { DashboardAction } from '../../types.ts';

interface Props {
  workItemId: number;
}

const STATUS_BADGE: Record<DashboardAction['status'], { label: string; cls: string }> = {
  pending: { label: 'queued', cls: 'badge--info' },
  running: { label: 'running', cls: 'badge--running' },
  completed: { label: 'completed', cls: 'badge--success' },
  failed: { label: 'failed', cls: 'badge--error' },
};

const MAX_ITEMS = 10;

export function RecentActionsPanel({ workItemId }: Props) {
  const expanded = useSignal(false);

  const recent = useComputed(() => {
    const all = Array.from(actions.value.values())
      .filter(a => a.workItemId === workItemId)
      .sort((a, b) => b.id - a.id);
    return all.slice(0, MAX_ITEMS);
  });

  if (recent.value.length === 0) return null;

  const inFlight = recent.value.filter(a => a.status === 'pending' || a.status === 'running').length;
  const lastFailed = recent.value.find(a => a.status === 'failed');

  return (
    <div class="recent-actions">
      <button
        type="button"
        class="recent-actions__toggle"
        onClick={() => { expanded.value = !expanded.value; }}
        aria-expanded={expanded.value}
        title="Show recent dashboard actions and their outcomes"
      >
        <span>Recent actions ({recent.value.length})</span>
        {inFlight > 0 && <span class="badge badge--running">{inFlight} in-flight</span>}
        {!inFlight && lastFailed && <span class="badge badge--error">last: failed</span>}
        <span class="recent-actions__caret">{expanded.value ? '▾' : '▸'}</span>
      </button>
      {expanded.value && (
        <ul class="recent-actions__list">
          {recent.value.map(a => {
            const badge = STATUS_BADGE[a.status];
            const ts = a.completedAt ?? a.startedAt ?? a.createdAt;
            return (
              <li key={a.id} class={`recent-actions__item recent-actions__item--${a.status}`}>
                <span class="recent-actions__type">{a.type}</span>
                <span class={`badge ${badge.cls}`}>{badge.label}</span>
                <span class="recent-actions__time" title={new Date(ts).toLocaleString()}>
                  {formatRelativeTime(ts)}
                </span>
                {a.error && (
                  <span class="recent-actions__error" title={a.error}>{a.error}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
