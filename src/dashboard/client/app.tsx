import { signal } from '@preact/signals';
import { sessionList, connectionStatus, selectedSession, selectedSessionId, runners, isMobile, mobileDetailId, currentUser } from './store.ts';
import { SessionCard } from './components/session-card.tsx';
import { SessionDetail } from './components/session-detail.tsx';
import { MobileSessionCard } from './components/mobile-session-card.tsx';
import { MobileSessionDetail } from './components/mobile-session-detail.tsx';
import { LogViewer } from './components/log-viewer.tsx';
import { PRReviewList } from './components/pr-review-list.tsx';
import { StatsView } from './components/stats-view.tsx';
import { AdminView } from './components/admin-view.tsx';
import { forcePull } from './sse.ts';
import { logout } from './auth-client.ts';
import { getRouteParams, parseEnumParam, updateRouteParams } from './url-route.ts';

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

// ---------------------------------------------------------------------------
// App-tab routing (arrival-efficiency fix) — which top-level tab is open is
// part of "a pasted link must reproduce the exact view", alongside the
// Stats & Config tab's own section/window/population (stats-view.tsx,
// stats-store.ts). `parseView` is total: an absent or unrecognised `view`
// param both fall back to 'sessions' rather than throwing or leaving the
// view undefined.
// ---------------------------------------------------------------------------

const VIEW_NAMES = ['sessions', 'pr-reviews', 'stats', 'admin'] as const;
type ViewName = (typeof VIEW_NAMES)[number];

function parseView(params: URLSearchParams): ViewName {
  return parseEnumParam(params, 'view', VIEW_NAMES) ?? 'sessions';
}

const activeView = signal<ViewName>(parseView(getRouteParams()));

/** Switches the tab and patches the URL's `view` param via `replaceState` —
 *  a tab click is a scope change, not a new page, so it must not spend a
 *  back-button step (see url-route.ts's doc comment). Leaves any
 *  `section`/`window`/`population` params already in the hash untouched,
 *  so switching away from and back to Stats keeps that tab's own state. */
function setActiveView(v: ViewName): void {
  activeView.value = v;
  updateRouteParams({ view: v });
}

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
  const isAdmin = currentUser.value?.role === 'admin';
  // Defence in depth, not the control (see the Admin tab button's and panel's
  // own comments below): a non-admin whose `activeView` signal is somehow
  // 'admin' — a role change mid-session, or a `view=admin` deep link typed
  // by a non-admin — falls back to Sessions rather than rendering no tab as
  // active and no panel at all, which is what `activeView.value === 'admin'`
  // failing every branch below would otherwise produce.
  const view = activeView.value === 'admin' && !isAdmin ? 'sessions' : activeView.value;

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <h1>Pipeline Dashboard</h1>
        <div class="dashboard-header__right">
          {currentUser.value && (
            <span class="user-chip" title={currentUser.value.email}>
              {currentUser.value.displayName}
              <button type="button" class="user-chip__logout" onClick={() => { void logout(); }}>
                Sign out
              </button>
            </span>
          )}
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
            aria-selected={view === 'sessions'}
            aria-controls="panel-sessions"
            class={`view-tabs__tab ${view === 'sessions' ? 'view-tabs__tab--active' : ''}`}
            onClick={() => setActiveView('sessions')}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            id="tab-pr-reviews"
            aria-selected={view === 'pr-reviews'}
            aria-controls="panel-pr-reviews"
            class={`view-tabs__tab ${view === 'pr-reviews' ? 'view-tabs__tab--active' : ''}`}
            onClick={() => setActiveView('pr-reviews')}
          >
            PR Reviews
          </button>
          <button
            type="button"
            role="tab"
            id="tab-stats"
            aria-selected={view === 'stats'}
            aria-controls="panel-stats"
            class={`view-tabs__tab ${view === 'stats' ? 'view-tabs__tab--active' : ''}`}
            onClick={() => setActiveView('stats')}
          >
            Stats & Config
          </button>
          {/* Hiding this tab for non-admins is cosmetic, not the control: the
              server rejects every /api/admin/* request from a non-admin
              (server.ts's requiredAccess() gate) regardless of what this
              button does. This just keeps an operator from opening a screen
              every request from which would come back 403. */}
          {isAdmin && (
            <button
              type="button"
              role="tab"
              id="tab-admin"
              aria-selected={view === 'admin'}
              aria-controls="panel-admin"
              class={`view-tabs__tab ${view === 'admin' ? 'view-tabs__tab--active' : ''}`}
              onClick={() => setActiveView('admin')}
            >
              Admin
            </button>
          )}
        </div>
        {view === 'sessions' ? (
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
        ) : view === 'pr-reviews' ? (
          <div id="panel-pr-reviews" role="tabpanel" aria-labelledby="tab-pr-reviews">
            <PRReviewList />
          </div>
        ) : view === 'stats' ? (
          <div id="panel-stats" role="tabpanel" aria-labelledby="tab-stats">
            <StatsView />
          </div>
        ) : view === 'admin' ? (
          // Defence in depth, not the control: the server rejects every
          // /api/admin/* request from a non-admin regardless (see the tab
          // button's own comment above). `view` above already clamps 'admin'
          // to 'sessions' for a non-admin session — e.g. a role change
          // mid-session, or a `view=admin` deep link typed by a non-admin —
          // so reaching this branch already implies `isAdmin`.
          <div id="panel-admin" role="tabpanel" aria-labelledby="tab-admin">
            <AdminView />
          </div>
        ) : null}
      </main>
      <LogViewer />
    </div>
  );
}
