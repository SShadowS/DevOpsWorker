import { signal, computed } from '@preact/signals';
import { dispatchAction } from '../actions.ts';
import { actions } from '../store.ts';
import type { ActionType, DashboardSession, DashboardAction } from '../../types.ts';

interface TrackedEnvAction {
  type: ActionType;
  actionId?: number;
}

const trackedEnvAction = signal<TrackedEnvAction | null>(null);
const envError = signal<string | null>(null);
const showShareInput = signal(false);
const shareEmail = signal('');
const confirmingDelete = signal(false);
const showOverflow = signal(false);

const trackedEnvStatus = computed<'idle' | 'submitting' | DashboardAction['status']>(() => {
  const t = trackedEnvAction.value;
  if (!t) return 'idle';
  if (t.actionId == null) return 'submitting';
  const action = actions.value.get(t.actionId);
  if (!action) return 'submitting';
  return action.status;
});

function scheduleClear(actionId: number, delay: number) {
  setTimeout(() => {
    if (trackedEnvAction.value?.actionId === actionId) {
      trackedEnvAction.value = null;
    }
  }, delay);
}

interface Props {
  session: DashboardSession;
}

interface ButtonState {
  label: string;
  disabled: boolean;
  confirmed: boolean;
}

function envButtonState(type: ActionType, defaultLabel: string, pendingLabel: string): ButtonState {
  const t = trackedEnvAction.value;
  if (t?.type !== type) {
    return { label: defaultLabel, disabled: false, confirmed: false };
  }
  const status = trackedEnvStatus.value;
  if (status === 'submitting' || status === 'pending') {
    return { label: pendingLabel, disabled: true, confirmed: false };
  }
  if (status === 'running') {
    return { label: pendingLabel, disabled: true, confirmed: false };
  }
  if (status === 'completed') {
    const actionId = t.actionId;
    if (actionId != null) scheduleClear(actionId, 2500);
    return { label: '✓ Completed', disabled: true, confirmed: true };
  }
  if (status === 'failed') {
    const actionId = t.actionId;
    const action = actionId != null ? actions.value.get(actionId) : null;
    const err = action?.error ?? 'Action failed';
    if (envError.value !== err) envError.value = err;
    if (actionId != null) scheduleClear(actionId, 100);
    return { label: defaultLabel, disabled: false, confirmed: false };
  }
  return { label: defaultLabel, disabled: false, confirmed: false };
}

export function EnvironmentPanel({ session }: Props) {
  if (!session.environment) return null;

  const env = session.environment;
  const envActions = (session.availableActions ?? []).filter(a => a.startsWith('env-'));

  async function handleEnvAction(type: ActionType, email?: string) {
    trackedEnvAction.value = { type };
    envError.value = null;
    try {
      const actionId = await dispatchAction(session.workItemId, type, email ? { email } : undefined);
      trackedEnvAction.value = { type, actionId };
      if (type === 'env-share') {
        showShareInput.value = false;
        shareEmail.value = '';
      }
    } catch (err) {
      envError.value = err instanceof Error ? err.message : String(err);
      trackedEnvAction.value = null;
    }
  }

  function handleShare() {
    if (!shareEmail.value.trim()) return;
    handleEnvAction('env-share', shareEmail.value.trim());
  }

  const startBtn = envButtonState('env-start', 'Start', 'Starting...');
  const stopBtn = envButtonState('env-stop', 'Stop', 'Stopping...');
  const deleteBtn = envButtonState('env-delete', 'Delete', 'Deleting...');
  const shareBtn = envButtonState('env-share', 'Confirm', 'Sharing...');

  return (
    <div class="env-panel">
      <div class="env-panel__header">
        <h3>Environment</h3>
        <a href={env.url} target="_blank" rel="noopener" class="env-panel__url" title="Open BC environment in browser">
          {env.url}
        </a>
      </div>

      <div class="env-panel__meta">
        <span>ID: <code>{env.envId}</code></span>
        <span>Profile: <code>{env.profileId}</code></span>
        <span>Created: {new Date(env.createdAt).toLocaleString()}</span>
      </div>

      <div class="env-panel__actions">
        {envActions.includes('env-start') && (
          <button
            type="button"
            class={`btn ${startBtn.confirmed ? 'btn--confirmed' : 'btn--primary'}${startBtn.disabled ? ' btn--pending' : ''}`}
            disabled={startBtn.disabled}
            onClick={() => handleEnvAction('env-start')}
            title="Start the BC environment"
          >
            {startBtn.label}
          </button>
        )}

        {envActions.includes('env-share') && !showShareInput.value && (
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => { showShareInput.value = true; }}
            title="Share environment access via email"
          >
            Share
          </button>
        )}

        {(envActions.includes('env-stop') || envActions.includes('env-delete')) && !confirmingDelete.value && (
          <div class="env-overflow">
            <button
              type="button"
              class="env-overflow__trigger"
              onClick={() => { showOverflow.value = !showOverflow.value; }}
              title="More actions (Stop, Delete)"
            >
              ···
            </button>
            {showOverflow.value && (
              <div class="env-overflow__menu">
                {envActions.includes('env-stop') && (
                  <button
                    type="button"
                    class="env-overflow__item"
                    disabled={stopBtn.disabled}
                    onClick={() => { showOverflow.value = false; handleEnvAction('env-stop'); }}
                    title="Stop the BC environment"
                  >
                    {stopBtn.label}
                  </button>
                )}
                {envActions.includes('env-delete') && (
                  <button
                    type="button"
                    class="env-overflow__item env-overflow__item--danger"
                    disabled={deleteBtn.disabled}
                    onClick={() => { showOverflow.value = false; confirmingDelete.value = true; }}
                    title="Permanently delete this environment"
                  >
                    {deleteBtn.confirmed ? deleteBtn.label : 'Delete'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {confirmingDelete.value && (
          <>
            <button
              type="button"
              class="btn btn--error"
              disabled={deleteBtn.disabled}
              onClick={() => { confirmingDelete.value = false; handleEnvAction('env-delete'); }}
              title="Confirm environment deletion"
            >
              {deleteBtn.label === 'Delete' ? 'Confirm Delete' : deleteBtn.label}
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => { confirmingDelete.value = false; }}
              title="Cancel deletion"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {showShareInput.value && (
        <div class="env-panel__share">
          <input
            type="email"
            placeholder="Email address"
            value={shareEmail.value}
            onInput={(e) => { shareEmail.value = (e.target as HTMLInputElement).value; }}
            class="input"
          />
          <button
            type="button"
            class="btn btn--info"
            disabled={shareBtn.disabled || !shareEmail.value.trim()}
            onClick={handleShare}
            title="Send environment invite"
          >
            {shareBtn.label}
          </button>
          <button type="button" class="btn" onClick={() => { showShareInput.value = false; }} title="Cancel sharing">Cancel</button>
        </div>
      )}

      {envError.value && (
        <div class="env-panel__error" onClick={() => { envError.value = null; }}>
          {envError.value}
          <span class="env-panel__error-dismiss" title="Dismiss">x</span>
        </div>
      )}
    </div>
  );
}
