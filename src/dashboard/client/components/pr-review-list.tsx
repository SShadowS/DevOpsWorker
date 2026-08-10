import { prReviews, selectedPRReviewId } from '../store.ts';
import { formatDuration, formatCost, formatRelativeTime } from '../format.ts';
import { RecommendationBadge, FindingsPills, CherryPickMark } from './pr-review-bits.tsx';
import { PRReviewDetail } from './pr-review-detail.tsx';

function togglePR(id: number): void {
  selectedPRReviewId.value = selectedPRReviewId.value === id ? null : id;
}

/**
 * A test run (an A/B arm or an ad-hoc probe) is a fact, not a problem — it is
 * excluded from production statistics elsewhere in this dashboard, but this
 * list still shows every row (per the plan: labelling only, no filtering).
 * `isTest` is optional here even though `DashboardPRReview.isTest` is not:
 * this asymmetry is deliberate. A legacy row (any row from before this field
 * existed) must read as production, not as "unknown" or, worse, as flagged —
 * so a missing field takes the same `false` branch as an explicit `false`.
 */
export function badgeForReview(review: { isTest?: boolean }): 'test' | null {
  return review.isTest === true ? 'test' : null;
}

/**
 * The PR this review was cherry-picked from, or null when it was not reviewed as a
 * cherry-pick. `reviewPath` is written by review-pr.ts in one of two shapes:
 * `sanity:<source pr id>` (sometimes with a `+merge-commit` suffix) when the review
 * compared the change against an already-reviewed PR, and `full:<reason>` otherwise.
 *
 * Only the `sanity:` prefix counts. One of the `full:` reasons is "cherry-pick detected
 * but no source PR id in the trailer" — that review saw a cherry-pick and read the whole
 * change anyway, so matching on the words would badge a review that never took the path.
 *
 * A missing value means the row predates the column (everything before 2026-07-30) or
 * has not run yet. Both return null: no badge, and no claim that it was a full review.
 */
export function cherryPickSourcePr(review: { reviewPath?: string | null }): number | null {
  const path = review.reviewPath;
  if (!path?.startsWith('sanity:')) return null;
  // Stop at the '+' so 'sanity:52117+merge-commit' yields 52117 rather than NaN.
  const id = Number.parseInt(path.slice('sanity:'.length), 10);
  return Number.isFinite(id) ? id : null;
}

/**
 * True when the reviewer said this change is a port of an earlier one and the check that
 * runs before it did not. That check decides which reviewer to spend money on, so a miss
 * costs the difference between a full read and a cheap comparison — around $7 against
 * $0.42 on the reviews that exposed this. The reviewer's own answer arrives far too late
 * to save that, which is exactly why it is worth surfacing: it is the only evidence that
 * the pre-flight check has a blind spot.
 *
 * Requires an explicit `true` — a null means the row predates the field or the review
 * failed, and neither is a claim that the change is not a port.
 */
export function routerMissedCherryPick(review: { observedCherryPick?: boolean | null; reviewPath?: string | null }): boolean {
  // Exactly this one reason, not any `full:`. The router writes several other `full:`
  // reasons AFTER it has already recognised the port — the caller asked for a full read
  // with /review-full, the source PR was not found, its diff would not compute, the
  // trailer named no id. Those rows are not blind spots, and marking them as such would
  // brand the designed "ask for a deeper look" workflow a defect.
  return review.observedCherryPick === true && review.reviewPath === 'full:not a cherry-pick';
}

export function PRReviewList() {
  const reviews = prReviews.value;

  if (reviews.length === 0) {
    return <p class="empty-state">No PR reviews found.</p>;
  }

  const missed = reviews.filter(routerMissedCherryPick).length;

  return (
    <div class="pr-review-list">
      {missed > 0 && (
        <p class="pr-review-list__note">
          {missed} of these {reviews.length} reviews read a change in full that the reviewer
          then recognised as a port of an earlier one. Each is marked below. The check that
          picks the cheap path missed them, so they cost full price.
        </p>
      )}
      {reviews.map((r) => {
        const interactive = r.id >= 0;
        const expanded = selectedPRReviewId.value === r.id;
        return (
          <div key={r.id}>
            <div
              // No modifier for a test run: the row's left edge shows the review's state,
              // and being a test run is a label rather than a state. The `test` badge below
              // carries it. See the stripe vocabulary at the top of dashboard.css.
              class={`pr-review-row ${r.error ? 'pr-review-row--error' : ''} ${r.pendingStatus ? 'pr-review-row--pending' : ''} ${interactive ? 'pr-review-row--clickable' : ''}`}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-expanded={interactive ? expanded : undefined}
              onClick={interactive ? () => togglePR(r.id) : undefined}
              onKeyDown={interactive ? (e: KeyboardEvent) => {
                // Only react when the row itself has focus — descendant links (e.g. the PR#
                // anchor) own their own keystrokes. Without this guard, Enter on the anchor
                // would toggle the row instead of activating the link.
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePR(r.id); }
              } : undefined}
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
                {cherryPickSourcePr(r) != null && <CherryPickMark sourcePr={cherryPickSourcePr(r)!} />}
                {cherryPickSourcePr(r) == null && routerMissedCherryPick(r) && <CherryPickMark missed />}
                <span class="pr-review-row__repo">{r.repoKey}</span>
                <span class="pr-review-row__branch" title={r.sourceBranch}>{r.sourceBranch}</span>
                <RecommendationBadge rec={r.recommendation} hasError={!!r.error} pendingStatus={r.pendingStatus} />
                <FindingsPills findings={r.findings} />
                {badgeForReview(r) && (
                  <span class="pr-review__badge pr-review__badge--test" title="Excluded from production statistics">test</span>
                )}
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
