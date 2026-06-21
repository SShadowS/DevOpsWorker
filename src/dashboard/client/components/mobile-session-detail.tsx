import { mobileDetailId, sessions } from '../store.ts';
import { SessionDetail } from './session-detail.tsx';

export function MobileSessionDetail() {
  const id = mobileDetailId.value;
  if (id == null) return null;

  const session = sessions.value.get(id);
  if (!session) {
    mobileDetailId.value = null;
    return null;
  }

  return (
    <div class="mobile-detail-overlay">
      <div class="mobile-detail-header">
        <button
          type="button"
          class="mobile-detail-back"
          onClick={() => { mobileDetailId.value = null; }}
          aria-label="Back to session list"
          title="Back to session list"
        >
          &larr;
        </button>
        <span class="mobile-detail-title">
          #{session.workItemId} {session.title ?? ''}
        </span>
      </div>
      <div class="mobile-detail-body">
        <SessionDetail session={session} />
      </div>
    </div>
  );
}
