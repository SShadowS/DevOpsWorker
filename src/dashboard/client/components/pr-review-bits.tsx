import type { DashboardPRReview } from '../../types.ts';

export function RecommendationBadge({ rec, hasError, pendingStatus }: { rec: string | null; hasError: boolean; pendingStatus?: string }) {
  if (pendingStatus === 'queued') return <span class="pr-review__badge pr-review__badge--pending">queued</span>;
  if (pendingStatus === 'reviewing') return <span class="pr-review__badge pr-review__badge--pending">reviewing</span>;
  if (!rec && hasError) return <span class="pr-review__badge pr-review__badge--error">failed</span>;
  if (!rec) return null;
  const cls = rec === 'approve' ? 'approve' : rec.includes('discussion') ? 'discussion' : 'changes';
  return <span class={`pr-review__badge pr-review__badge--${cls}`}>{rec}</span>;
}

/**
 * The mark on a review that was read as a cherry-pick.
 *
 * A glyph rather than another word-in-a-box: the row already carries a verdict badge and
 * up to four finding pills, and a fifth one disappeared into the queue however bright it
 * was. It sits next to the PR number so the marked rows line up in a column you can scan
 * down, instead of at the end of a line whose length changes row to row.
 *
 * The drawing is a commit lifted from one branch onto another — the line is the branch it
 * came from, the filled dot is where it landed.
 */
export function CherryPickMark({ sourcePr, missed }: { sourcePr?: number; missed?: boolean }) {
  const label = missed
    ? 'the reviewer found this is a port of an earlier change, but the check that runs first missed it — so it was read in full, at full price'
    : sourcePr != null
      ? `cherry-picked from PR #${sourcePr} — checked against that PR's review instead of read in full`
      : 'cherry-picked from an earlier change';
  return (
    <span
      class={`pr-review-row__cherry-pick ${missed ? 'pr-review-row__cherry-pick--missed' : ''}`}
      title={label}
    >
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        role="img"
        aria-label={label}
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M1.5 13h9" />
        <circle cx="4.5" cy="13" r="1.5" />
        <path d="M6.5 11.5C7.5 8 9.5 6 12 5.5" />
        <circle cx="12.2" cy="4.6" r="2.6" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

export function FindingsPills({ findings }: { findings: DashboardPRReview['findings'] }) {
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
