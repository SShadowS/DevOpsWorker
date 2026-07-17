import { signal, computed } from '@preact/signals';
import type { DashboardSession, DashboardPRReview, DashboardAction } from '../types.ts';
import type { LogEntry, LogPage } from '../../pipeline/log-sink.interface.ts';

export const sessions = signal<Map<number, DashboardSession>>(new Map());

// Actions keyed by actionId — single source of truth for action lifecycle in the UI.
export const actions = signal<Map<number, DashboardAction>>(new Map());

/** Look up an action by id (helper for computed signals in components). */
export function getAction(id: number | null | undefined): DashboardAction | null {
  if (id == null) return null;
  return actions.value.get(id) ?? null;
}
export const selectedSessionId = signal<number | null>(null);
export const connectionStatus = signal<'connected' | 'reconnecting' | 'disconnected'>('disconnected');

export const selectedSession = computed(() =>
  selectedSessionId.value != null ? sessions.value.get(selectedSessionId.value) ?? null : null,
);

export const sessionList = computed(() =>
  Array.from(sessions.value.values()).sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  ),
);

export interface ProcessHeartbeat {
  updatedAt: string;
  online: boolean;
}

export interface RunnerStatus {
  active: number;
  max: number;
  workItemIds: number[];
  updatedAt: string | null;
  processes?: Record<string, ProcessHeartbeat>;
}

export const runners = signal<RunnerStatus>({ active: 0, max: 0, workItemIds: [], updatedAt: null });

export const prReviews = signal<DashboardPRReview[]>([]);
export const selectedPRReviewId = signal<number | null>(null);

export const isMobile = signal(
  typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
);
export const mobileDetailId = signal<number | null>(null);

// Keep isMobile in sync with viewport changes
if (typeof window !== 'undefined') {
  window.matchMedia('(max-width: 767px)').addEventListener('change', (e) => {
    isMobile.value = e.matches;
    if (!e.matches) mobileDetailId.value = null;
  });
}

export type ActiveLogViewer =
  | { kind: 'session'; workItemId: number; logsBase: string; title: string; selectedStage: string | null }
  | { kind: 'pr-review'; reviewId: number; logsBase: string; title: string; selectedStage: string | null };

export const activeLogViewer = signal<ActiveLogViewer | null>(null);
export const logStages = signal<string[]>([]);
export const logEntries = signal<LogEntry[]>([]);
/** True when older entries exist before the first rendered one ("Load older"). */
export const logHasMoreBefore = signal(false);
export const logLoadingOlder = signal(false);

/** Initial tail size + max we ever keep rendered/in-memory. */
const LOG_PAGE_SIZE = 500;
const MAX_RENDERED_LOG_ENTRIES = 2000;
/** Monotonically increasing token to discard stale stage fetches (race guard). */
let logRequestToken = 0;

export async function openLogViewer(workItemId: number): Promise<void> {
  await openViewer({ kind: 'session', workItemId, logsBase: `/api/sessions/${workItemId}`, title: `#${workItemId}`, selectedStage: null });
}

export async function openPrReviewLogViewer(reviewId: number, prId: number): Promise<void> {
  await openViewer({ kind: 'pr-review', reviewId, logsBase: `/api/pr-reviews/${reviewId}`, title: `PR #${prId}`, selectedStage: null });
}

async function openViewer(viewer: ActiveLogViewer): Promise<void> {
  const token = ++logRequestToken; // invalidate any in-flight fetch from a prior open
  activeLogViewer.value = viewer;
  logStages.value = [];
  logEntries.value = [];
  logHasMoreBefore.value = false;
  logLoadingOlder.value = false;
  try {
    const res = await fetch(`${viewer.logsBase}/logs`);
    if (token !== logRequestToken) return;
    if (!res.ok) { logStages.value = []; return; }
    const stages: unknown = await res.json();
    if (token !== logRequestToken) return;
    if (!Array.isArray(stages)) { logStages.value = []; return; }
    logStages.value = stages as string[];
    if (stages.length > 0) await selectLogStage(stages[stages.length - 1] as string);
  } catch {
    if (token !== logRequestToken) return;
    logStages.value = [];
  }
}

export async function selectLogStage(stageName: string): Promise<void> {
  const viewer = activeLogViewer.value;
  if (!viewer) return;
  const token = ++logRequestToken;
  activeLogViewer.value = { ...viewer, selectedStage: stageName } as ActiveLogViewer;
  logEntries.value = [];
  logHasMoreBefore.value = false;
  try {
    const res = await fetch(`${viewer.logsBase}/logs/${encodeURIComponent(stageName)}?limit=${LOG_PAGE_SIZE}`);
    if (token !== logRequestToken) return;
    if (!res.ok) { logEntries.value = []; logHasMoreBefore.value = false; return; }
    const page = await res.json() as LogPage;
    if (token !== logRequestToken) return;
    if (!page || !Array.isArray(page.entries)) { logEntries.value = []; logHasMoreBefore.value = false; return; }
    logEntries.value = page.entries;
    logHasMoreBefore.value = !!page.hasMoreBefore;
  } catch {
    if (token !== logRequestToken) return;
    logEntries.value = [];
    logHasMoreBefore.value = false;
  }
}

/** Prepend the page of entries immediately older than the first rendered one. */
export async function loadOlderLogEntries(): Promise<void> {
  const viewer = activeLogViewer.value;
  if (!viewer || !viewer.selectedStage) return;
  if (logLoadingOlder.value || !logHasMoreBefore.value) return;
  const oldest = logEntries.value[0];
  if (!oldest) return;

  logLoadingOlder.value = true;
  const token = logRequestToken;
  try {
    const res = await fetch(
      `${viewer.logsBase}/logs/${encodeURIComponent(viewer.selectedStage)}` +
        `?limit=${LOG_PAGE_SIZE}&beforeId=${oldest.id}`,
    );
    if (token !== logRequestToken) return;
    if (!res.ok) return;
    const page = await res.json() as LogPage;
    if (token !== logRequestToken) return;
    if (!page || !Array.isArray(page.entries)) return;
    // Cap total rendered: dropping from the tail keeps the just-loaded older context.
    const merged = [...page.entries, ...logEntries.value];
    logEntries.value = merged.slice(0, MAX_RENDERED_LOG_ENTRIES);
    logHasMoreBefore.value = !!page.hasMoreBefore;
  } catch {
    /* leave current entries intact */
  } finally {
    logLoadingOlder.value = false;
  }
}

/** Append a live-streamed entry: dedupe by id, keep only the newest N. */
export function appendLogEntry(entry: LogEntry): void {
  const current = logEntries.value;
  if (current.length > 0 && entry.id <= current[current.length - 1]!.id) {
    if (current.some((e) => e.id === entry.id)) return; // already have it
  }
  logEntries.value = [...current, entry].slice(-MAX_RENDERED_LOG_ENTRIES);
}

export function closeLogViewer(): void {
  logRequestToken++; // invalidate any in-flight fetches
  activeLogViewer.value = null;
  logStages.value = [];
  logEntries.value = [];
  logHasMoreBefore.value = false;
  logLoadingOlder.value = false;
}

