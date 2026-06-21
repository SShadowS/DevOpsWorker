import type { DashboardSession } from './types.ts';

/**
 * Change-detection key for the cross-process session poll. When this string changes,
 * the dashboard re-broadcasts the session. Includes the full activeAgent marker so
 * producer/reviewer/iteration transitions (and marker clears) trigger a broadcast.
 */
export function sessionChangeKey(session: DashboardSession): string {
  const a = session.activeAgent;
  const activeAgentKey = a ? `${a.loop}:${a.name}:${a.role}:${a.iteration}:${a.startedAt}` : '';
  return `${session.currentStage}:${session.status}:${session.lastActivityAt ?? ''}:${activeAgentKey}`;
}
