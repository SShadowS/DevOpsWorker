import { sessions, connectionStatus, runners, activeLogViewer, appendLogEntry, prReviews, actions } from './store.ts';
import type { RunnerStatus } from './store.ts';
import type { DashboardSession, DashboardPRReview, DashboardAction } from '../types.ts';
import type { LogEntry } from '../../pipeline/log-sink.interface.ts';

export function connectSSE(): void {
  const es = new EventSource('/api/events');

  es.onopen = () => {
    connectionStatus.value = 'connected';
  };

  es.addEventListener('session-update', (e: MessageEvent) => {
    const session: DashboardSession = JSON.parse(e.data);
    const next = new Map(sessions.value);
    next.set(session.workItemId, session);
    sessions.value = next;
  });

  es.addEventListener('log-entry', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as { workItemId: number; stageName: string; entry: LogEntry };
    const viewer = activeLogViewer.value;
    if (!viewer || viewer.kind !== 'session' || viewer.workItemId !== data.workItemId) return;
    if (viewer.selectedStage && viewer.selectedStage !== data.stageName) return;
    appendLogEntry(data.entry);
  });

  es.addEventListener('pr-review-update', (e: MessageEvent) => {
    prReviews.value = JSON.parse(e.data) as DashboardPRReview[];
  });

  es.addEventListener('action-update', (e: MessageEvent) => {
    const list = JSON.parse(e.data) as DashboardAction[];
    const map = new Map<number, DashboardAction>();
    for (const a of list) map.set(a.id, a);
    actions.value = map;
  });

  es.onerror = () => {
    connectionStatus.value = 'reconnecting';
  };
}

export async function loadPRReviews(): Promise<void> {
  try {
    const res = await fetch('/api/pr-reviews');
    prReviews.value = await res.json() as DashboardPRReview[];
  } catch { /* ignore */ }
}

export async function loadRecentActions(): Promise<void> {
  try {
    const res = await fetch('/api/actions/recent?limit=100');
    const list = await res.json() as DashboardAction[];
    const map = new Map<number, DashboardAction>();
    for (const a of list) map.set(a.id, a);
    actions.value = map;
  } catch { /* ignore */ }
}

export async function loadInitialSessions(): Promise<void> {
  const res = await fetch('/api/sessions');
  const list: DashboardSession[] = await res.json();
  const map = new Map<number, DashboardSession>();
  for (const s of list) map.set(s.workItemId, s);
  sessions.value = map;
}

async function pollRunners(): Promise<void> {
  try {
    const res = await fetch('/api/runners');
    runners.value = await res.json() as RunnerStatus;
  } catch { /* ignore */ }
}

export function startRunnerPolling(intervalMs = 10_000): void {
  pollRunners();
  setInterval(pollRunners, intervalMs);
}

export async function forcePull(): Promise<void> {
  await fetch('/api/force-poll', { method: 'POST' });
  await Promise.all([loadInitialSessions(), loadPRReviews(), pollRunners()]);
}
