import { signal } from '@preact/signals';
import { AdminRepos } from './admin-repos.tsx';

type AdminSection = 'repos' | 'users';

const activeSection = signal<AdminSection>('repos');

// ---------------------------------------------------------------------------
// The Admin tab's own content: a Repos/Users sub-navigation reusing the
// top-level `.view-tabs` styling (app.tsx's Sessions/PR Reviews/Stats bar) so
// the dashboard has one tab idiom, not two. Both sections are placeholders —
// the repo table and the user table land in later tasks; this shell just
// gives them somewhere to go.
// ---------------------------------------------------------------------------

export function AdminView() {
  const section = activeSection.value;

  return (
    <div class="admin-view">
      <div class="view-tabs" role="tablist" aria-label="Admin sections">
        <button
          type="button"
          role="tab"
          id="admin-tab-repos"
          aria-selected={section === 'repos'}
          aria-controls="admin-panel-repos"
          class={`view-tabs__tab ${section === 'repos' ? 'view-tabs__tab--active' : ''}`}
          onClick={() => { activeSection.value = 'repos'; }}
        >
          Repos
        </button>
        <button
          type="button"
          role="tab"
          id="admin-tab-users"
          aria-selected={section === 'users'}
          aria-controls="admin-panel-users"
          class={`view-tabs__tab ${section === 'users' ? 'view-tabs__tab--active' : ''}`}
          onClick={() => { activeSection.value = 'users'; }}
        >
          Users
        </button>
      </div>
      {section === 'repos' ? (
        <div id="admin-panel-repos" role="tabpanel" aria-labelledby="admin-tab-repos">
          <AdminRepos />
        </div>
      ) : (
        <div id="admin-panel-users" role="tabpanel" aria-labelledby="admin-tab-users">
          <p class="empty-state">User management isn't built yet. It's coming in a later update.</p>
        </div>
      )}
    </div>
  );
}
