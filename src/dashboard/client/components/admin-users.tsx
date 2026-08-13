import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { adminFetch } from '../admin-fetch.ts';
import type { AdminFieldError } from '../admin-fetch.ts';
import { currentUser } from '../store.ts';
import type { AuthUser, Role } from '../../../auth/types.ts';

/**
 * The Users admin screen: list every account, add a new one, change a role,
 * disable/re-enable an account, and reset a password. Talks to
 * `/api/admin/users[...]` (src/dashboard/admin-api.ts) exclusively through
 * `adminFetch`, mirroring admin-repos.tsx's list/form/row-action shape so
 * this reads as the same system rather than a second design.
 *
 * `IUserStore.list()` (src/auth/user-store.interface.ts) returns a plain
 * `AuthUser[]`, not an object keyed by email — confirmed by reading the
 * interface rather than trusting the plan, which got the repos list's shape
 * wrong in exactly this way.
 *
 * There is deliberately no delete action here: `/api/admin/users` has no
 * DELETE route and `IUserStore` has no delete method (Task 6 shipped
 * create/list/setRole/setDisabled/setPassword only), and nothing in this
 * screen's brief asks for one. A throwaway account created while verifying
 * this screen in a browser is removed with a direct SQL delete afterwards,
 * the same way tests/dashboard/admin-users-api.test.ts cleans up its own
 * fixtures.
 */

// ---------------------------------------------------------------------------
// List state — loading/error/empty/ready, the same shape admin-repos.tsx
// uses for its own list. Kept local rather than shared: not worth coupling
// two 4-line unions over.
// ---------------------------------------------------------------------------

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; users: AuthUser[] };

const listState = signal<ListState>({ status: 'loading' });

// ---------------------------------------------------------------------------
// Create-user form state
// ---------------------------------------------------------------------------

export interface CreateUserFormState {
  email: string;
  displayName: string;
  role: Role;
  password: string;
}

export function emptyCreateUserFormState(): CreateUserFormState {
  return { email: '', displayName: '', role: 'operator', password: '' };
}

// Mirrors MIN_PASSWORD_LENGTH in admin-api.ts and readPassword() in
// src/cli/admin.ts — every path that sets a password agrees on this number.
// Duplicated rather than imported, for the same reason admin-repos.tsx
// duplicates CLIENT_DANGEROUS_KEYS: the server module pulls in server-only
// dependencies that must never reach the browser bundle. This only buys a
// faster, friendlier error before the round trip; the server enforces it
// regardless.
export const MIN_PASSWORD_LENGTH = 8;

export interface CreateUserPayload {
  email: string;
  displayName: string;
  role: Role;
  password: string;
}

/** Client-side mirror of the checks `createUser` (admin-api.ts) makes. */
export function buildCreateUserPayload(form: CreateUserFormState): { ok: true; payload: CreateUserPayload } | { ok: false; errors: AdminFieldError[] } {
  const errors: AdminFieldError[] = [];
  const email = form.email.trim();
  if (email === '') errors.push({ path: 'email', message: 'An email address is required.' });
  if (form.password.length < MIN_PASSWORD_LENGTH) {
    errors.push({ path: 'password', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      email,
      displayName: form.displayName.trim(),
      role: form.role,
      password: form.password,
    },
  };
}

// ---------------------------------------------------------------------------
// Panel state — which secondary panel (the create-user form, or a row's
// password-reset form) is open right now. Mirrors admin-repos.tsx's `panel`
// signal, and for the same reason: exactly one of these is ever open at a
// time, and routing every opener through `reduceUserPanel` means "open B"
// also closes A — there is no separate clear-call to remember at each call
// site, and nothing for a third panel added later to forget.
// ---------------------------------------------------------------------------

export type UserPanel =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'passwordReset'; email: string };

export type UserPanelAction =
  | { type: 'openCreate' }
  | { type: 'openPasswordReset'; email: string }
  | { type: 'close' };

/** Pure transition — same shape and reasoning as `reduceRepoPanel` in
 *  admin-repos.tsx: every branch fully replaces the panel, so there is no
 *  field left over for a previous panel to linger in. */
export function reduceUserPanel(_current: UserPanel, action: UserPanelAction): UserPanel {
  switch (action.type) {
    case 'openCreate':
      return { kind: 'create' };
    case 'openPasswordReset':
      return { kind: 'passwordReset', email: action.email };
    case 'close':
      return { kind: 'closed' };
  }
}

const panel = signal<UserPanel>({ kind: 'closed' });
const createForm = signal<CreateUserFormState>(emptyCreateUserFormState());
const createFormErrors = signal<AdminFieldError[]>([]);
const createFormMessage = signal<string | null>(null);
const creating = signal(false);

// ---------------------------------------------------------------------------
// Row-level action state — role toggle, disable toggle, password reset. One
// busy/error slot each is enough: an admin acts on one row at a time. Which
// row's password-reset form is open lives in `panel` above.
// ---------------------------------------------------------------------------

const busyEmail = signal<string | null>(null);
const rowActionError = signal<{ email: string; message: string } | null>(null);

const passwordResetValue = signal('');
const passwordResetError = signal<string | null>(null);
const resettingPassword = signal(false);

// ---------------------------------------------------------------------------
// Pure helpers — no signals, no network. Kept separate from the component
// bodies below so they are unit-testable without rendering anything (repo
// convention — see tests/dashboard/admin-repos.test.ts).
// ---------------------------------------------------------------------------

export function listUserRows(users: AuthUser[]): AuthUser[] {
  return [...users].sort((a, b) => a.email.localeCompare(b.email));
}

/** How many accounts are both an admin AND not disabled right now — the same
 *  count `lockTargetAndActiveAdmins` (admin-api.ts) computes server-side.
 *  Used only to decide which controls to grey out BEFORE a click; the
 *  server's own count, taken under a row lock at the moment of the request,
 *  is what actually enforces the guardrail. */
export function countActiveAdmins(users: AuthUser[]): number {
  return users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

/**
 * Why the "make operator" action on this row is currently blocked, or
 * `null` if it isn't. Mirrors the two demotion guardrails in `putUserRole`
 * (admin-api.ts): an admin cannot remove their own admin role, and the last
 * remaining active admin cannot be demoted by anyone. Promoting an operator
 * to admin has no guardrail at all, so this only ever returns non-null for
 * a row that is currently an admin.
 */
export function getRoleGuardReason(target: AuthUser, actorEmail: string, activeAdminCount: number): string | null {
  if (target.role !== 'admin') return null;
  if (target.email === actorEmail) return 'You cannot remove your own admin role.';
  if (!target.disabled && activeAdminCount <= 1) {
    return 'This is the last remaining admin. Promote another admin before removing this one.';
  }
  return null;
}

/** Why the "disable" action on this row is currently blocked, or `null` if
 *  it isn't. Mirrors `putUserDisabled`'s guardrails: an admin cannot disable
 *  their own account, and the last remaining active admin cannot be
 *  disabled by anyone. Re-enabling an already-disabled account is never
 *  guarded. */
export function getDisableGuardReason(target: AuthUser, actorEmail: string, activeAdminCount: number): string | null {
  if (target.disabled) return null;
  if (target.email === actorEmail) return 'You cannot disable your own account.';
  if (target.role === 'admin' && activeAdminCount <= 1) {
    return 'This is the last remaining admin. Promote another admin before disabling this one.';
  }
  return null;
}

/** The sentence an admin reads before a password reset lands. The server
 *  really does revoke every session for this person (see `putUserPassword`
 *  in admin-api.ts) — this says so before the click, not after. */
export function buildPasswordResetWarning(target: AuthUser): string {
  return `This immediately signs ${target.displayName} out of every device and browser they're currently logged into.`;
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function loadUsers(): Promise<void> {
  listState.value = { status: 'loading' };
  const result = await adminFetch<AuthUser[]>('/api/admin/users');
  if (!result.ok) {
    listState.value = { status: 'error', message: result.message };
    return;
  }
  listState.value = result.data.length === 0 ? { status: 'empty' } : { status: 'ready', users: result.data };
}

function openCreateForm(): void {
  panel.value = reduceUserPanel(panel.value, { type: 'openCreate' });
  createForm.value = emptyCreateUserFormState();
  createFormErrors.value = [];
  createFormMessage.value = null;
}

function closeCreateForm(): void {
  panel.value = reduceUserPanel(panel.value, { type: 'close' });
}

async function submitCreate(): Promise<void> {
  createFormMessage.value = null;
  createFormErrors.value = [];

  const built = buildCreateUserPayload(createForm.value);
  if (!built.ok) {
    createFormMessage.value = 'Fix the errors below and try again.';
    createFormErrors.value = built.errors;
    return;
  }

  creating.value = true;
  try {
    const result = await adminFetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.payload),
    });
    if (!result.ok) {
      createFormMessage.value = result.message;
      createFormErrors.value = result.errors;
      return;
    }
    panel.value = reduceUserPanel(panel.value, { type: 'close' });
    await loadUsers();
  } finally {
    creating.value = false;
  }
}

async function toggleRole(target: AuthUser): Promise<void> {
  const role: Role = target.role === 'admin' ? 'operator' : 'admin';
  rowActionError.value = null;
  busyEmail.value = target.email;
  try {
    const result = await adminFetch(`/api/admin/users/${encodeURIComponent(target.email)}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!result.ok) {
      rowActionError.value = { email: target.email, message: result.message };
      return;
    }
    await loadUsers();
  } finally {
    busyEmail.value = null;
  }
}

async function toggleDisabled(target: AuthUser): Promise<void> {
  const disabled = !target.disabled;
  rowActionError.value = null;
  busyEmail.value = target.email;
  try {
    const result = await adminFetch(`/api/admin/users/${encodeURIComponent(target.email)}/disabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    });
    if (!result.ok) {
      rowActionError.value = { email: target.email, message: result.message };
      return;
    }
    await loadUsers();
  } finally {
    busyEmail.value = null;
  }
}

function openPasswordReset(email: string): void {
  panel.value = reduceUserPanel(panel.value, { type: 'openPasswordReset', email });
  passwordResetValue.value = '';
  passwordResetError.value = null;
}

function cancelPasswordReset(): void {
  panel.value = reduceUserPanel(panel.value, { type: 'close' });
  passwordResetValue.value = '';
  passwordResetError.value = null;
}

async function submitPasswordReset(email: string): Promise<void> {
  const password = passwordResetValue.value;
  if (password.length < MIN_PASSWORD_LENGTH) {
    passwordResetError.value = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    return;
  }
  resettingPassword.value = true;
  try {
    const result = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!result.ok) {
      passwordResetError.value = result.message;
      return;
    }
    cancelPasswordReset();
  } finally {
    resettingPassword.value = false;
  }
}

// ---------------------------------------------------------------------------
// The create-user form. Reuses admin-repos.tsx's `.repo-form*` classes
// (field/grid/label/hint/banner/errors/actions) as-is — that visual language
// belongs to "an admin form" generally, not specifically to repos, and a
// second, nearly-identical CSS block for four fields would be the second
// look the brief said not to invent.
// ---------------------------------------------------------------------------

function CreateUserForm() {
  const f = createForm.value;

  function set<K extends keyof CreateUserFormState>(key: K, value: CreateUserFormState[K]): void {
    createForm.value = { ...createForm.value, [key]: value };
  }

  return (
    <div class="repo-form">
      <h3>Add a user</h3>
      <div class="repo-form__grid">
        <label class="repo-form__field">
          <span class="repo-form__field-label">Email *</span>
          <input
            class="input"
            type="email"
            autocomplete="username"
            value={f.email}
            onInput={(e) => set('email', (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="repo-form__field">
          <span class="repo-form__field-label">Display name</span>
          <input
            class="input"
            type="text"
            value={f.displayName}
            onInput={(e) => set('displayName', (e.target as HTMLInputElement).value)}
          />
          <span class="repo-form__hint">Leave blank to use the email address.</span>
        </label>
        <label class="repo-form__field">
          <span class="repo-form__field-label">Role *</span>
          <select
            class="input"
            value={f.role}
            onChange={(e) => set('role', (e.target as HTMLSelectElement).value as Role)}
          >
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label class="repo-form__field">
          <span class="repo-form__field-label">Password *</span>
          <input
            class="input"
            type="password"
            autocomplete="new-password"
            value={f.password}
            onInput={(e) => set('password', (e.target as HTMLInputElement).value)}
          />
          <span class="repo-form__hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </label>
      </div>

      {createFormMessage.value && <p class="repo-form__banner">{createFormMessage.value}</p>}
      {createFormErrors.value.length > 0 && (
        <ul class="repo-form__errors">
          {createFormErrors.value.map((e, i) => (
            <li key={i}><code class="config-mono">{e.path}</code> — {e.message}</li>
          ))}
        </ul>
      )}

      <div class="repo-form__actions">
        <button type="button" class="btn btn--primary" disabled={creating.value} onClick={submitCreate}>
          {creating.value ? 'Creating…' : 'Create user'}
        </button>
        <button type="button" class="btn" disabled={creating.value} onClick={closeCreateForm}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-row actions — role toggle, disable/enable toggle, password reset.
// Each guarded action shows its blocking reason right under the button
// (via .repo-form__hint) rather than only on a tooltip, so an admin reads
// why before clicking rather than after a 409.
// ---------------------------------------------------------------------------

function UserRowActions({ user, activeAdminCount, actorEmail }: { user: AuthUser; activeAdminCount: number; actorEmail: string }) {
  const roleReason = getRoleGuardReason(user, actorEmail, activeAdminCount);
  const disableReason = getDisableGuardReason(user, actorEmail, activeAdminCount);
  const busy = busyEmail.value === user.email;
  const rowError = rowActionError.value?.email === user.email ? rowActionError.value.message : null;

  return (
    <div class="admin-users__row-actions">
      <div class="admin-users__action">
        <button type="button" class="btn" disabled={busy || !!roleReason} onClick={() => toggleRole(user)}>
          {user.role === 'admin' ? 'Make operator' : 'Make admin'}
        </button>
        {roleReason && <span class="repo-form__hint">{roleReason}</span>}
      </div>
      <div class="admin-users__action">
        <button
          type="button"
          class={`btn ${user.disabled ? 'btn--success' : 'btn--warning'}`}
          disabled={busy || !!disableReason}
          onClick={() => toggleDisabled(user)}
        >
          {user.disabled ? 'Enable' : 'Disable'}
        </button>
        {disableReason && <span class="repo-form__hint">{disableReason}</span>}
      </div>
      <div class="admin-users__action">
        <button type="button" class="btn" disabled={busy} onClick={() => openPasswordReset(user.email)}>
          Reset password
        </button>
      </div>
      {rowError && (
        <button type="button" class="action-error" onClick={() => { rowActionError.value = null; }}>
          {rowError}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list panel, plus the password-reset panel it hosts when a row's
// "Reset password" button is clicked — same above-the-table placement as
// admin-repos.tsx's delete confirmation.
// ---------------------------------------------------------------------------

function PasswordResetPanel({ target }: { target: AuthUser }) {
  return (
    <div class="repo-form">
      <h3>Reset password for {target.displayName}</h3>
      <p class="repo-form__hint">{buildPasswordResetWarning(target)}</p>
      <label class="repo-form__field">
        <span class="repo-form__field-label">New password</span>
        <input
          class="input"
          type="password"
          autocomplete="new-password"
          value={passwordResetValue.value}
          onInput={(e) => { passwordResetValue.value = (e.target as HTMLInputElement).value; }}
        />
        <span class="repo-form__hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
      </label>
      {passwordResetError.value && <p class="repo-form__banner">{passwordResetError.value}</p>}
      <div class="repo-form__actions">
        <button
          type="button"
          class="btn btn--primary"
          disabled={resettingPassword.value}
          onClick={() => submitPasswordReset(target.email)}
        >
          {resettingPassword.value ? 'Resetting…' : 'Reset password'}
        </button>
        <button type="button" class="btn" disabled={resettingPassword.value} onClick={cancelPasswordReset}>Cancel</button>
      </div>
    </div>
  );
}

function UserListPanel() {
  const state = listState.value;
  const actorEmail = currentUser.value?.email ?? '';

  return (
    <div class={`stats-slot stats-slot--${state.status}`}>
      <div class="stats-slot__header">
        <span class="stats-slot__title">Users</span>
      </div>

      {(() => {
        const p = panel.value;
        if (p.kind !== 'passwordReset' || state.status !== 'ready') return null;
        const target = state.users.find((u) => u.email === p.email);
        return target ? <PasswordResetPanel target={target} /> : null;
      })()}

      {state.status === 'loading' && <p class="empty-state">Loading users…</p>}
      {state.status === 'error' && <p class="empty-state">Could not load users: {state.message}</p>}
      {state.status === 'empty' && <p class="empty-state">No users exist yet.</p>}
      {state.status === 'ready' && (() => {
        const activeAdminCount = countActiveAdmins(state.users);
        return (
          <table class="config-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listUserRows(state.users).map((user) => (
                <tr key={user.email}>
                  <td>{user.email}</td>
                  <td>{user.displayName}</td>
                  <td><strong>{user.role === 'admin' ? 'Admin' : 'Operator'}</strong></td>
                  <td><span class={`badge badge--${user.disabled ? 'error' : 'success'}`}>{user.disabled ? 'Disabled' : 'Active'}</span></td>
                  <td class="config-table__actions">
                    <UserRowActions user={user} activeAdminCount={activeAdminCount} actorEmail={actorEmail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function AdminUsers() {
  // Refetch on every mount rather than caching — same reasoning as
  // AdminRepos: a stale user list with no "stale" marker is worse than a
  // brief loading flash, and this list changes exactly when an admin acts
  // on it from this same screen.
  useEffect(() => { loadUsers(); }, []);

  return (
    <div class="admin-users">
      {panel.value.kind === 'create' ? (
        <CreateUserForm />
      ) : (
        <>
          <div class="admin-users__toolbar">
            <button type="button" class="btn btn--primary" onClick={openCreateForm}>+ New user</button>
          </div>
          <UserListPanel />
        </>
      )}
    </div>
  );
}
