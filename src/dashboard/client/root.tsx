import { useEffect } from 'preact/hooks';
import { App } from './app.tsx';
import { LoginPage } from './components/login-page.tsx';
import { currentUser } from './store.ts';
import { checkAuth } from './auth-client.ts';
import { connectSSE, loadInitialSessions, loadPRReviews, loadRecentActions, startRunnerPolling } from './sse.ts';

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
