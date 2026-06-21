import { useSignal } from '@preact/signals';
import { selectedSessionId, openLogViewer, activeLogViewer } from '../store.ts';
import { formatDuration, formatCost, formatRelativeTime } from '../format.ts';
import { StageProgression } from './stage-progression.tsx';
import { ActionBar } from './action-bar.tsx';
import type { DashboardSession } from '../../types.ts';

function statusBorderClass(status: string): string {
  const map: Record<string, string> = {
    running: 'session-card--running',
    'checkpoint-waiting': 'session-card--waiting',
    failed: 'session-card--failed',
    completed: 'session-card--completed',
    stalled: 'session-card--stalled',
  };
  return map[status] ?? '';
}

interface Props {
  session: DashboardSession;
}

export function SessionCard({ session }: Props) {
  const isSelected = selectedSessionId.value === session.workItemId;
  /** Per-card rewind target stage name (set by ActionBar on hover, read by StageProgression). */
  const rewindStage = useSignal<string | null>(null);

  return (
    <div
      class={`session-card ${statusBorderClass(session.status)} ${isSelected ? 'session-card--selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={isSelected}
      aria-label={`Work item ${session.workItemId}: ${session.title ?? 'Untitled'} — ${session.status}`}
      onClick={() => {
        selectedSessionId.value = isSelected ? null : session.workItemId;
      }}
      onKeyDown={(e) => {
        // Only react when the card itself has focus — descendant inputs (textarea, input,
        // buttons) own their own keystrokes. Without this guard, Space inside the feedback
        // textarea bubbles here and gets preventDefault'd before it can type.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectedSessionId.value = isSelected ? null : session.workItemId;
        }
      }}
    >
      <div class="session-card__row">
        <StageProgression stages={session.stages} rewindStage={rewindStage} />
        <div class="session-card__right">
          {session.telemetry.totalCostUsd > 0 && (
            <span class="session-card__cost">{formatCost(session.telemetry.totalCostUsd)}</span>
          )}
          <span class="session-card__duration">{formatDuration(session.telemetry.totalDurationMs)}</span>
          <ActionBar session={session} rewindStage={rewindStage} />
          <span class="session-card__time" title={new Date(session.lastActivityAt ?? session.startedAt).toLocaleString()}>
            {formatRelativeTime(session.lastActivityAt ?? session.startedAt)}
          </span>
        </div>
      </div>

      <div class="session-card__meta">
        {session.config ? (
          <a
            class="session-card__wi-id"
            href={`https://dev.azure.com/${encodeURIComponent(session.config.organization)}/${encodeURIComponent(session.config.project)}/_workitems/edit/${session.workItemId}`}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            title={`Open work item #${session.workItemId} in Azure DevOps`}
          >
            #{session.workItemId}
          </a>
        ) : (
          <span class="session-card__wi-id" title={`Work item #${session.workItemId}`}>#{session.workItemId}</span>
        )}
        <span class="session-card__title">
          {session.title ?? `Work Item ${session.workItemId}`}
        </span>
        {session.legacySkipped && session.legacySkipped.length > 0 && (
          <span
            class="session-card__legacy"
            title={`Skipped stages: ${session.legacySkipped.join(', ')}`}
          >
            Legacy
          </span>
        )}
        {session.environment && (
          <a
            class="session-card__env"
            href={session.environment.url}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            title={`BC Environment: ${session.environment.envId}`}
          >
            Env
          </a>
        )}
        <button
          type="button"
          class={`session-card__logs-btn ${activeLogViewer.value?.workItemId === session.workItemId ? 'session-card__logs-btn--active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            openLogViewer(session.workItemId);
          }}
          title="View logs"
        >
          Logs
        </button>
      </div>
    </div>
  );
}
