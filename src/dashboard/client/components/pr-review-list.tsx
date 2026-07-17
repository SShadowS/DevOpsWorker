import { prReviews, selectedPRReviewId } from '../store.ts';
import { formatDuration, formatCost, formatRelativeTime } from '../format.ts';
import { RecommendationBadge, FindingsPills } from './pr-review-bits.tsx';
import { PRReviewDetail } from './pr-review-detail.tsx';

function togglePR(id: number): void {
  selectedPRReviewId.value = selectedPRReviewId.value === id ? null : id;
}

export function PRReviewList() {
  const reviews = prReviews.value;

  if (reviews.length === 0) {
    return <p class="empty-state">No PR reviews found.</p>;
  }

  return (
    <div class="pr-review-list">
      {reviews.map((r) => {
        const interactive = r.id >= 0;
        const expanded = selectedPRReviewId.value === r.id;
        return (
          <div key={r.id}>
            <div
              class={`pr-review-row ${r.error ? 'pr-review-row--error' : ''} ${r.pendingStatus ? 'pr-review-row--pending' : ''} ${interactive ? 'pr-review-row--clickable' : ''}`}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-expanded={interactive ? expanded : undefined}
              onClick={interactive ? () => togglePR(r.id) : undefined}
              onKeyDown={interactive ? (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePR(r.id); } } : undefined}
            >
              <div class="pr-review-row__main">
                {r.webUrl ? (
                  <a
                    class="pr-review-row__pr"
                    href={r.webUrl}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                    title={`Open PR #${r.prId} in Azure DevOps`}
                  >
                    PR #{r.prId}
                  </a>
                ) : (
                  <span class="pr-review-row__pr" title={`PR #${r.prId} (repo "${r.repoKey}" not registered)`}>PR #{r.prId}</span>
                )}
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
            {interactive && expanded && <PRReviewDetail review={r} />}
          </div>
        );
      })}
    </div>
  );
}
