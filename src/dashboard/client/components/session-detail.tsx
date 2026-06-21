import type { DashboardSession } from '../../types.ts';

import { EnvironmentPanel } from './environment-panel.tsx';
import { ErrorPanel } from './error-panel.tsx';
import { AgentOutputTabs } from './agent-output-tabs.tsx';
import { TimelineView } from './timeline-view.tsx';
import { ToolUsage } from './tool-usage.tsx';
import { TelemetryTable } from './telemetry-table.tsx';
import { RecentActionsPanel } from './recent-actions-panel.tsx';
import { signal } from '@preact/signals';

type DetailTab = 'outputs' | 'timeline' | 'tools' | 'telemetry';
const activeDetailTab = signal<DetailTab>('outputs');

const DETAIL_TAB_TOOLTIPS: Record<DetailTab, string> = {
  outputs: 'Agent outputs: readiness, plan, code, reviews',
  timeline: 'Stage execution timeline and durations',
  tools: 'Tool usage breakdown by stage',
  telemetry: 'Token usage, costs, and timing per stage',
};

interface Props {
  session: DashboardSession;
}

export function SessionDetail({ session }: Props) {
  return (
    <div class="session-detail">
      {session.environment && <EnvironmentPanel session={session} />}

      <RecentActionsPanel workItemId={session.workItemId} />

      {session.error && <ErrorPanel error={session.error} />}

      {session.revisionFeedback && (
        <div class="revision-info">
          <span class="revision-info__label">Revision feedback ({session.revisionFeedback.source}):</span>
          <pre class="revision-info__text">{session.revisionFeedback.feedback}</pre>
        </div>
      )}

      <div class="detail-tabs">
        <div class="detail-tabs__nav">
          {(['outputs', 'timeline', 'tools', 'telemetry'] as DetailTab[]).map((tab) => (
            <button
              type="button"
              key={tab}
              class={`detail-tabs__tab ${activeDetailTab.value === tab ? 'detail-tabs__tab--active' : ''}`}
              onClick={() => { activeDetailTab.value = tab; }}
              title={DETAIL_TAB_TOOLTIPS[tab]}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div class="detail-tabs__content">
          {activeDetailTab.value === 'outputs' && <AgentOutputTabs session={session} />}
          {activeDetailTab.value === 'timeline' && <TimelineView session={session} />}
          {activeDetailTab.value === 'tools' && <ToolUsage session={session} />}
          {activeDetailTab.value === 'telemetry' && <TelemetryTable session={session} />}
        </div>
      </div>
    </div>
  );
}
