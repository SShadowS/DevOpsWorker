import type { DashboardSession } from '../../types.ts';
import { formatDurationDetailed as formatDuration } from '../format.ts';

function stageColor(name: string): string {
  if (name.startsWith('checkpoint')) return 'var(--color-warning)';
  if (name.startsWith('env')) return 'var(--color-success)';
  return 'var(--color-info)';
}

interface Props { session: DashboardSession; }

export function TimelineView({ session }: Props) {
  const stages = session.telemetry.stages;
  if (stages.length === 0) return <p class="empty-state">No telemetry data.</p>;

  const maxDuration = Math.max(...stages.map((s) => s.durationMs));
  const totalAgent = stages.reduce((sum, s) => sum + s.durationMs, 0);
  const totalWall = session.completedAt
    ? new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()
    : Date.now() - new Date(session.startedAt).getTime();

  return (
    <div class="timeline">
      <div class="timeline__summary">
        <span>Wall clock: <strong>{formatDuration(totalWall)}</strong></span>
        <span>Agent time: <strong>{formatDuration(totalAgent)}</strong></span>
        <span>Idle/polling: <strong>{formatDuration(Math.max(0, totalWall - totalAgent))}</strong></span>
      </div>
      <div class="timeline__bars">
        {stages.map((stage, i) => {
          const pct = maxDuration > 0 ? (stage.durationMs / maxDuration) * 100 : 0;
          return (
            <div key={`${stage.name}-${i}`} class="timeline__row">
              <span class="timeline__label">{stage.name}</span>
              <div class="timeline__track">
                <div class="timeline__bar" style={{ width: `${pct}%`, backgroundColor: stageColor(stage.name) }} />
              </div>
              <span class="timeline__duration">{formatDuration(stage.durationMs)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
