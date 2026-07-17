import type { DashboardPRReview } from '../../types.ts';

export function RecommendationBadge({ rec, hasError, pendingStatus }: { rec: string | null; hasError: boolean; pendingStatus?: string }) {
  if (pendingStatus === 'queued') return <span class="pr-review__badge pr-review__badge--pending">queued</span>;
  if (pendingStatus === 'reviewing') return <span class="pr-review__badge pr-review__badge--pending">reviewing</span>;
  if (!rec && hasError) return <span class="pr-review__badge pr-review__badge--error">failed</span>;
  if (!rec) return null;
  const cls = rec === 'approve' ? 'approve' : rec.includes('discussion') ? 'discussion' : 'changes';
  return <span class={`pr-review__badge pr-review__badge--${cls}`}>{rec}</span>;
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
