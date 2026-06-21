import { signal, computed } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { dispatchAction } from '../actions.ts';
import { actions } from '../store.ts';
import type { ActionType, DashboardSession, DashboardAction } from '../../types.ts';

interface TrackedAction {
  workItemId: number;
  type: ActionType;
  actionId?: number;
}

const trackedAction = signal<TrackedAction | null>(null);
const actionError = signal<{ workItemId: number; message: string } | null>(null);
const feedbackTarget = signal<{ workItemId: number; type: ActionType } | null>(null);
const feedbackText = signal('');

/** Lifecycle status of the currently-tracked action, derived from the live actions Map.
 *  Returns 'submitting' before SSE has surfaced the row, then the server-side status. */
const trackedStatus = computed<'idle' | 'submitting' | DashboardAction['status']>(() => {
  const t = trackedAction.value;
  if (!t) return 'idle';
  if (t.actionId == null) return 'submitting';
  const action = actions.value.get(t.actionId);
  if (!action) return 'submitting';
  return action.status;
});

interface Props {
  session: DashboardSession;
  rewindStage: Signal<string | null>;
}

const ACTION_LABELS: Record<string, { label: string; variant: string; tooltip: string }> = {
  'approve-plan': { label: 'Approve Plan', variant: 'btn--success', tooltip: 'Approve the dev plan and proceed to coding' },
  'rerun-plan': { label: 'Rerun Plan', variant: 'btn--warning', tooltip: 'Rewind to planning with feedback for the planner' },
  'fix': { label: 'Fix Code', variant: 'btn--warning', tooltip: 'Rewind to coding with feedback for the coder' },
  'continue': { label: 'Continue', variant: 'btn--info', tooltip: 'Resume pipeline from the failed stage' },
  'reprovision-env': { label: 'Reprovision Env', variant: 'btn--info', tooltip: 'Delete and recreate the BC environment' },
};

const FEEDBACK_ACTIONS = new Set<string>(['rerun-plan', 'fix']);

const ACTION_REWIND_TARGETS: Record<string, string> = {
  'rerun-plan': 'planning',
  'fix': 'coding',
  'continue': '',
  'approve-plan': '',
};

/** When an action reaches a terminal status, clear the tracker after a brief delay
 *  so the next click starts clean. Failures surface their error and clear sooner. */
function scheduleClear(actionId: number, delay: number) {
  setTimeout(() => {
    if (trackedAction.value?.actionId === actionId) {
      trackedAction.value = null;
    }
  }, delay);
}

export function ActionBar({ session, rewindStage }: Props) {
  const pipelineActions = (session.availableActions ?? []).filter(a => !a.startsWith('env-'));

  if (pipelineActions.length === 0) return null;

  const showingFeedback =
    feedbackTarget.value?.workItemId === session.workItemId
      ? feedbackTarget.value
      : null;

  async function handleAction(type: ActionType, feedback?: string) {
    const id = session.workItemId;
    trackedAction.value = { workItemId: id, type };
    actionError.value = null;
    try {
      const actionId = await dispatchAction(id, type, feedback ? { feedback } : undefined);
      trackedAction.value = { workItemId: id, type, actionId };
    } catch (err) {
      actionError.value = { workItemId: id, message: err instanceof Error ? err.message : String(err) };
      trackedAction.value = null;
    }
  }

  function openFeedback(type: ActionType) {
    feedbackTarget.value = { workItemId: session.workItemId, type };
    feedbackText.value = '';
    actionError.value = null;
  }

  function closeFeedback() {
    feedbackTarget.value = null;
    feedbackText.value = '';
    rewindStage.value = null;
  }

  async function submitFeedback() {
    if (!showingFeedback) return;
    const text = feedbackText.value.trim();
    if (!text) return;
    rewindStage.value = null;
    await handleAction(showingFeedback.type, text);
    closeFeedback();
  }

  function setHoverTarget(type: string) {
    const target = ACTION_REWIND_TARGETS[type];
    rewindStage.value = target || null;
  }

  function clearHoverTarget() {
    rewindStage.value = null;
  }

  /** True when the action button for (workItemId, type) is the one being tracked. */
  function isTracked(type: ActionType): boolean {
    const t = trackedAction.value;
    return t?.workItemId === session.workItemId && t?.type === type;
  }

  /** Display state for a button: in-flight, finished, errored, or normal. */
  function buttonState(type: ActionType): {
    label: string;
    disabled: boolean;
    extraClass: string;
  } {
    if (!isTracked(type)) {
      return { label: ACTION_LABELS[type]?.label ?? type, disabled: false, extraClass: '' };
    }
    const status = trackedStatus.value;
    const baseLabel = ACTION_LABELS[type]?.label ?? type;
    if (status === 'submitting' || status === 'pending') {
      return { label: 'Sending...', disabled: true, extraClass: 'btn--pending' };
    }
    if (status === 'running') {
      return { label: 'Running...', disabled: true, extraClass: 'btn--pending' };
    }
    if (status === 'completed') {
      const actionId = trackedAction.value?.actionId;
      if (actionId != null) scheduleClear(actionId, 2500);
      return { label: '✓ Completed', disabled: true, extraClass: 'btn--confirmed' };
    }
    if (status === 'failed') {
      const actionId = trackedAction.value?.actionId;
      const action = actionId != null ? actions.value.get(actionId) : null;
      const err = action?.error ?? 'Action failed';
      if (!actionError.value || actionError.value.workItemId !== session.workItemId) {
        actionError.value = { workItemId: session.workItemId, message: err };
      }
      if (actionId != null) scheduleClear(actionId, 100);
      return { label: baseLabel, disabled: false, extraClass: '' };
    }
    return { label: baseLabel, disabled: false, extraClass: '' };
  }

  if (showingFeedback) {
    const config = ACTION_LABELS[showingFeedback.type];
    const state = buttonState(showingFeedback.type);
    const target = ACTION_REWIND_TARGETS[showingFeedback.type];
    if (target) rewindStage.value = target;
    return (
      <div class="feedback-form" onClick={(e) => e.stopPropagation()}>
        <textarea
          class="feedback-form__input"
          placeholder={`What should be changed? (required)`}
          rows={2}
          value={feedbackText.value}
          onInput={(e) => { feedbackText.value = (e.target as HTMLTextAreaElement).value; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submitFeedback();
            }
            if (e.key === 'Escape') closeFeedback();
          }}
          autoFocus
        />
        <div class="feedback-form__buttons">
          <button
            class={`btn ${state.extraClass || config?.variant || ''}`}
            disabled={state.disabled || !feedbackText.value.trim()}
            onClick={submitFeedback}
            title="Submit feedback and trigger action"
          >
            {state.label}
          </button>
          <button class="btn" onClick={closeFeedback} disabled={state.disabled} title="Discard feedback">Cancel</button>
          <span class="feedback-form__hint">Ctrl+Enter to submit · Esc to cancel</span>
        </div>
        {actionError.value?.workItemId === session.workItemId && <span class="action-error">{actionError.value.message}</span>}
      </div>
    );
  }

  return (
    <div class="action-bar">
      {pipelineActions.map((type) => {
        const config = ACTION_LABELS[type];
        if (!config) return null;
        const state = buttonState(type);
        const needsFeedback = FEEDBACK_ACTIONS.has(type);
        const hasRewindTarget = !!ACTION_REWIND_TARGETS[type];
        return (
          <button
            key={type}
            class={`btn ${state.extraClass || config.variant}`}
            disabled={state.disabled}
            title={config.tooltip}
            onMouseEnter={hasRewindTarget ? () => setHoverTarget(type) : undefined}
            onMouseLeave={hasRewindTarget ? clearHoverTarget : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (needsFeedback) {
                openFeedback(type);
              } else {
                clearHoverTarget();
                handleAction(type);
              }
            }}
          >
            {state.label}
          </button>
        );
      })}
      {actionError.value?.workItemId === session.workItemId && (
        <span class="action-error" onClick={() => { actionError.value = null; }}>{actionError.value.message}</span>
      )}
    </div>
  );
}
