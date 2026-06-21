import { prReviews } from '../store.ts';
import { formatDuration, formatCost, formatRelativeTime } from '../format.ts';
import type { DashboardPRReview } from '../../types.ts';

// Maps a repo key (as stored on the review record) to its Azure DevOps
// repository name (URL-encoded). Populate with your own repos.
const REPO_NAMES: Record<string, string> = {
  'example-repo': 'Example%20Repo%20-%20Extensions',
};

function buildPRUrl(repoKey: string, prId: number): string {
  const repoName = REPO_NAMES[repoKey] ?? repoKey;
  return `https://dev.azure.com/your-org/your-project/_git/${repoName}/pullrequest/${prId}`;
}

function RecommendationBadge({ rec, hasError, pendingStatus }: { rec: string | null; hasError: boolean; pendingStatus?: string }) {
  if (pendingStatus === 'queued') return <span class="pr-review__badge pr-review__badge--pending">queued</span>;
  if (pendingStatus === 'reviewing') return <span class="pr-review__badge pr-review__badge--pending">reviewing</span>;
  if (!rec && hasError) return <span class="pr-review__badge pr-review__badge--error">failed</span>;
  if (!rec) return null;
  const cls = rec === 'approve' ? 'approve' : rec.includes('discussion') ? 'discussion' : 'changes';
  return <span class={`pr-review__badge pr-review__badge--${cls}`}>{rec}</span>;
}

function FindingsPills({ findings }: { findings: DashboardPRReview['findings'] }) {
  if (!findings) return null;
  const items: { label: string; count: number; cls: string }[] = [
    { label: 'critical', count: findings.critical, cls: 'critical' },
    { label: 'major', count: findings.major, cls: 'major' },
    { label: 'minor', count: findings.minor, cls: 'minor' },
    { label: 'nitpick', count: findings.nitpick, cls: 'nitpick' },
  ].filter(i => i.count > 0);
  if (items.length === 0) return <span class="pr-review__no-findings">No findings</span>;
  return (
    <span class="pr-review__findings">
      {items.map((item, i) => (
        <span key={i} class={`pr-review__pill pr-review__pill--${item.cls}`}>
          {item.count} {item.label}
        </span>
      ))}
    </span>
  );
}

export function PRReviewList() {
  const reviews = prReviews.value;

  if (reviews.length === 0) {
    return <p class="empty-state">No PR reviews found.</p>;
  }

  return (
    <div class="pr-review-list">
      {reviews.map((r) => (
        <div key={r.id} class={`pr-review-row ${r.error ? 'pr-review-row--error' : ''} ${r.pendingStatus ? 'pr-review-row--pending' : ''}`}>
          <div class="pr-review-row__main">
            <a
              class="pr-review-row__pr"
              href={buildPRUrl(r.repoKey, r.prId)}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
              title={`Open PR #${r.prId} in Azure DevOps`}
            >
              PR #{r.prId}
            </a>
            <span class="pr-review-row__repo">{r.repoKey}</span>
            <span class="pr-review-row__branch" title={r.sourceBranch}>{r.sourceBranch}</span>
            <RecommendationBadge rec={r.recommendation} hasError={!!r.error} pendingStatus={r.pendingStatus} />
            <FindingsPills findings={r.findings} />
          </div>
          <div class="pr-review-row__meta">
            {r.costUsd != null && <span class="pr-review-row__cost">{formatCost(r.costUsd)}</span>}
            {r.durationMs != null && <span class="pr-review-row__duration">{formatDuration(r.durationMs)}</span>}
            {r.turns != null && <span class="pr-review-row__turns" title="Conversation turns">{r.turns} turns</span>}
            {r.toolCalls != null && <span class="pr-review-row__tools" title={Object.entries(r.toolCalls).map(([t, n]) => `${t}: ${n}`).join(', ')}>{Object.values(r.toolCalls).reduce((a, b) => a + b, 0)} tool calls</span>}
            <span class="pr-review-row__time" title={new Date(r.createdAt).toLocaleString()}>
              {formatRelativeTime(r.createdAt)}
            </span>
          </div>
          {r.error && <div class="pr-review-row__error" title={r.error}>Failed: {r.error.slice(0, 100)}</div>}
        </div>
      ))}
    </div>
  );
}
