import { mobileDetailId } from '../store.ts';
import { formatDuration } from '../format.ts';
import { openLogViewer, activeLogViewer } from '../store.ts';
import type { DashboardSession, StageProgress } from '../../types.ts';

function computeProgress(stages: StageProgress[]) {
  const total = stages.length;
  const completed = stages.filter(s => s.status === 'completed').length;
  const active = stages.find(s => s.status === 'active' || s.status === 'waiting');
  const currentName = active?.label ?? stages[stages.length - 1]?.label ?? 'Unknown';
  const currentStatus = active?.status ?? 'pending';
  return { total, completed, currentName, currentStatus };
}

function statusLabel(sessionStatus: string): string {
  const map: Record<string, string> = {
    running: 'RUNNING',
    'checkpoint-waiting': 'WAITING',
    failed: 'ERROR',
    completed: 'DONE',
    stalled: 'STALLED',
  };
  return map[sessionStatus] ?? sessionStatus.toUpperCase();
}

function statusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    active: 'mobile-card__badge--active',
    waiting: 'mobile-card__badge--waiting',
    completed: 'mobile-card__badge--completed',
    error: 'mobile-card__badge--error',
  };
  return map[status] ?? '';
}

function statusBorderClass(status: string): string {
  const map: Record<string, string> = {
    running: 'mobile-card--running',
    'checkpoint-waiting': 'mobile-card--waiting',
    failed: 'mobile-card--failed',
    completed: 'mobile-card--completed',
    stalled: 'mobile-card--stalled',
  };
  return map[status] ?? '';
}

interface Props {
  session: DashboardSession;
}

export function MobileSessionCard({ session }: Props) {
  const { total, completed, currentName, currentStatus } = computeProgress(session.stages);
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div
      class={`mobile-card ${statusBorderClass(session.status)}`}
      role="button"
      tabIndex={0}
      aria-label={`Work item ${session.workItemId}: ${session.title ?? 'Untitled'} — ${session.status}`}
      onClick={() => { mobileDetailId.value = session.workItemId; }}
      onKeyDown={(e) => {
        // Only react when the card itself has focus — descendant inputs own their keystrokes.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          mobileDetailId.value = session.workItemId;
        }
      }}
    >
      <div class="mobile-card__progress">
        <div class="mobile-card__stage-info">
          <span class="mobile-card__stage-count">{session.status === 'completed' ? 'Completed' : `Stage ${Math.min(completed + 1, total)} of ${total}`}</span>
          <span class="mobile-card__stage-name">{currentName}</span>
          <span class={`mobile-card__badge ${statusBadgeClass(currentStatus)}`}>{statusLabel(session.status)}</span>
        </div>
        <span class="mobile-card__duration">{formatDuration(session.telemetry.totalDurationMs)}</span>
      </div>

      <div class="mobile-card__bar">
        <div class="mobile-card__bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div class="mobile-card__meta">
        <div class="mobile-card__meta-left">
          {session.config ? (
            <a
              class="mobile-card__wi-id"
              href={`https://dev.azure.com/${encodeURIComponent(session.config.organization)}/${encodeURIComponent(session.config.project)}/_workitems/edit/${session.workItemId}`}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
              title={`Open work item #${session.workItemId} in Azure DevOps`}
            >
              #{session.workItemId}
            </a>
          ) : (
            <span class="mobile-card__wi-id" title={`Work item #${session.workItemId}`}>#{session.workItemId}</span>
          )}
          <span class="mobile-card__title">{session.title ?? `Work Item ${session.workItemId}`}</span>
        </div>
        <div class="mobile-card__meta-right">
          {session.environment && (
            <a
              class="mobile-card__env"
              href={session.environment.url}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
              title="BC Environment"
            >
              Env
            </a>
          )}
          <button
            type="button"
            class={`mobile-card__logs ${activeLogViewer.value?.kind === 'session' && activeLogViewer.value.workItemId === session.workItemId ? 'mobile-card__logs--active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              openLogViewer(session.workItemId);
            }}
            title="View stage logs"
          >
            Logs
          </button>
        </div>
      </div>
    </div>
  );
}
