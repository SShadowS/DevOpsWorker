/** Coarse duration for summaries (e.g., "3h 58m") */
export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

/** Precise duration for telemetry/timeline (e.g., "3m 42s") */
export function formatDurationDetailed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** A fractional rate (0..1) as a percentage, or `'n/a'` for a null rate — the
 *  no-eligible-rows case every Stats & Config rate stat shares (see
 *  `WindowMeta`-derived fields in `src/dashboard/stats.ts`). Promoted here
 *  from `stats-view.tsx` (Task 4) once a second consumer (Task 6's integrity
 *  panel: dispatch mismatch rate, findings mismatch rate) needed the exact
 *  same formatting — see task-4-report.md's deferred note. */
export function formatPct(rate: number | null): string {
  return rate == null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
