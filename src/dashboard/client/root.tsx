import { useEffect } from 'preact/hooks';
import { App } from './app.tsx';
import { LoginPage } from './components/login-page.tsx';
import { currentUser } from './store.ts';
import { checkAuth } from './auth-client.ts';
import { connectSSE, loadInitialSessions, loadPRReviews, loadRecentActions, startRunnerPolling } from './sse.ts';

// Safe only because login() and logout() (auth-client.ts) always follow with
// location.reload(): a full reload resets this module, so `booted` naturally
// goes back to false for the next sign-in. If either call ever drops its
// reload, this flag would stay true across the sign-out and the dashboard
// would silently stop re-booting data on the next sign-in.
let booted = false;
function bootData(): void {
  if (booted) return;
  booted = true;
  Promise.all([loadInitialSessions(), loadPRReviews(), loadRecentActions()]).then(() => {
    connectSSE();
    startRunnerPolling();
  });
}

export function Root() {
  useEffect(() => { void checkAuth(); }, []);
  const user = currentUser.value;
  if (user === undefined) return <div class="auth-loading">Checking session…</div>;
  if (user === null) return <LoginPage />;
  bootData();
  return <App />;
}
