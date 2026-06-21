import './styles/dashboard.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { connectSSE, loadInitialSessions, loadPRReviews, loadRecentActions, startRunnerPolling } from './sse.ts';

Promise.all([loadInitialSessions(), loadPRReviews(), loadRecentActions()]).then(() => {
  connectSSE();
  startRunnerPolling();
});

render(<App />, document.getElementById('app')!);
