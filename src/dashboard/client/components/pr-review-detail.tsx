import { useState, useEffect } from 'preact/hooks';
import type { DashboardPRReview, DashboardPRReviewDetail } from '../../types.ts';
import { RecommendationBadge, FindingsPills } from './pr-review-bits.tsx';
import { openPrReviewLogViewer } from '../store.ts';
import { formatCost, formatDuration } from '../format.ts';

/** Tool→count entries sorted by count descending. Pure; unit-tested. */
export function sortToolCalls(tc: Record<string, number> | null): [string, number][] {
  if (!tc) return [];
  return Object.entries(tc).sort((a, b) => b[1] - a[1]);
}

export function PRReviewDetail({ review }: { review: DashboardPRReview }) {
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setBody(null);
    fetch(`/api/pr-reviews/${review.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d: DashboardPRReviewDetail | null) => { if (alive) { setBody(d?.reviewBody ?? null); setLoading(false); } })
      .catch(() => { if (alive) { setBody(null); setLoading(false); } });
    return () => { alive = false; };
  }, [review.id]);

  const tools = sortToolCalls(review.toolCalls);
  const maxTool = tools.length > 0 ? tools[0]![1] : 0;

  return (
    <div class="pr-review-detail">
      <div class="pr-review-detail__meta">
        <RecommendationBadge rec={review.recommendation} hasError={!!review.error} />
        <FindingsPills findings={review.findings} />
        {review.costUsd != null && <span>{formatCost(review.costUsd)}</span>}
        {review.durationMs != null && <span>{formatDuration(review.durationMs)}</span>}
        {review.turns != null && <span>{review.turns} turns</span>}
      </div>

      {tools.length > 0 && (
        <div class="pr-review-detail__tools">
          <h4>Tool calls</h4>
          {tools.map(([name, count]) => (
            <div key={name} class="pr-review-detail__tool-row">
              <span class="pr-review-detail__tool-name">{name}</span>
              <span class="pr-review-detail__tool-bar-wrap">
                <span class="pr-review-detail__tool-bar" style={{ width: `${maxTool > 0 ? (count / maxTool) * 100 : 0}%` }} />
              </span>
              <span class="pr-review-detail__tool-count">{count}</span>
            </div>
          ))}
        </div>
      )}

      <div class="pr-review-detail__actions">
        <button type="button" class="pr-review-detail__logs-btn" onClick={() => openPrReviewLogViewer(review.id, review.prId)}>
          View logs
        </button>
      </div>

      <div class="pr-review-detail__body">
        <h4>Review</h4>
        {loading
          ? <span class="empty-state">Loading…</span>
          : body
            ? <pre class="pr-review-detail__body-text">{body}</pre>
            : <span class="empty-state">No review body recorded.</span>}
      </div>
    </div>
  );
}
