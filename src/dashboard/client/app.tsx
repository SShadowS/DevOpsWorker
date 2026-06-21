import { signal } from '@preact/signals';
import { sessionList, connectionStatus, selectedSession, selectedSessionId, runners, isMobile, mobileDetailId } from './store.ts';
import { SessionCard } from './components/session-card.tsx';
import { SessionDetail } from './components/session-detail.tsx';
import { MobileSessionCard } from './components/mobile-session-card.tsx';
import { MobileSessionDetail } from './components/mobile-session-detail.tsx';
import { LogViewer } from './components/log-viewer.tsx';
import { PRReviewList } from './components/pr-review-list.tsx';
import { forcePull } from './sse.ts';

const editingConcurrency = signal(false);
const concurrencyInput = signal('');
const pulling = signal(false);

async function handleForcePull() {
  pulling.value = true;
  try {
    await forcePull();
  } finally {
    pulling.value = false;
  }
}
const activeView = signal<'sessions' | 'pr-reviews'>('sessions');

async function updateConcurrency() {
  const val = parseInt(concurrencyInput.value, 10);
  if (isNaN(val) || val < 1) return;
  try {
    await fetch('/api/runners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: val }),
    });
    editingConcurrency.value = false;
  } catch { /* ignore */ }
}

export function App() {
  const status = connectionStatus.value;
  const list = sessionList.value;
  const selected = selectedSession.value;
  const r = runners.value;
  const mobile = isMobile.value;

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <h1>Pipeline Dashboard</h1>
        <div class="dashboard-header__right">
          {r.processes && Object.keys(r.processes).length > 0 && (
            <div class="process-status">
              {Object.entries(r.processes).map(([name, info]) => (
                <span
                  key={name}
                  class={`process-status__item ${info.online ? 'process-status__item--online' : 'process-status__item--offline'}`}
                  title={`${name}: ${info.online ? 'online' : 'offline'} (last seen ${info.updatedAt})`}
                >
                  <span class="process-status__dot" />
                  {name}
                </span>
              ))}
            </div>
          )}
          {r.max > 0 && (
            <div class="runner-status">
              <span class={`runner-status__indicator ${r.active >= r.max ? 'runner-status__indicator--full' : r.active > 0 ? 'runner-status__indicator--partial' : ''}`} />
              <span class="runner-status__text">
                {r.active}/{editingConcurrency.value ? (
                  <span class="runner-status__edit">
                    <input
                      type="number"
                      min="1"
                      value={concurrencyInput.value}
                      onInput={(e) => { concurrencyInput.value = (e.target as HTMLInputElement).value; }}
                      onKeyDown={(e) => { if (e.key === 'Enter') updateConcurrency(); if (e.key === 'Escape') editingConcurrency.value = false; }}
                      class="runner-status__input"
                    />
                  </span>
                ) : (
                  <span
                    class="runner-status__max"
                    onClick={(e) => {
                      e.stopPropagation();
                      concurrencyInput.value = String(r.max);
                      editingConcurrency.value = true;
                    }}
                    title="Click to change max concurrency"
                  >
                    {r.max}
                  </span>
                )} runners
              </span>
            </div>
          )}
          <button
            type="button"
            class={`force-pull-btn ${pulling.value ? 'force-pull-btn--pulling' : ''}`}
            onClick={handleForcePull}
            disabled={pulling.value}
            title="Force pull all data from database"
          >
            {pulling.value ? 'Pulling...' : 'Pull'}
          </button>
          <span class="connection-dot" data-status={status} title={`SSE: ${status}`} />
        </div>
      </header>
      <main>
        <div class="view-tabs" role="tablist" aria-label="Dashboard views">
          <button
            type="button"
            role="tab"
            id="tab-sessions"
            aria-selected={activeView.value === 'sessions'}
            aria-controls="panel-sessions"
            class={`view-tabs__tab ${activeView.value === 'sessions' ? 'view-tabs__tab--active' : ''}`}
            onClick={() => { activeView.value = 'sessions'; }}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            id="tab-pr-reviews"
            aria-selected={activeView.value === 'pr-reviews'}
            aria-controls="panel-pr-reviews"
            class={`view-tabs__tab ${activeView.value === 'pr-reviews' ? 'view-tabs__tab--active' : ''}`}
            onClick={() => { activeView.value = 'pr-reviews'; }}
          >
            PR Reviews
          </button>
        </div>
        {activeView.value === 'sessions' ? (
          <div id="panel-sessions" role="tabpanel" aria-labelledby="tab-sessions">
            {mobile && mobileDetailId.value != null ? (
              <MobileSessionDetail />
            ) : list.length === 0 ? (
              <p class="empty-state">No pipeline sessions found.</p>
            ) : (
              <div class="session-list">
                {list.map((s) => (
                  <div key={s.workItemId}>
                    {mobile ? (
                      <MobileSessionCard session={s} />
                    ) : (
                      <>
                        <SessionCard session={s} />
                        {selectedSessionId.value === s.workItemId && selected && (
                          <SessionDetail session={selected} />
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div id="panel-pr-reviews" role="tabpanel" aria-labelledby="tab-pr-reviews">
            <PRReviewList />
          </div>
        )}
      </main>
      <LogViewer />
    </div>
  );
}
