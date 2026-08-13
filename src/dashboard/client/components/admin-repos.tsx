import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { adminFetch } from '../admin-fetch.ts';
import type { AdminFieldError } from '../admin-fetch.ts';
import type { RepoConfig, RepoRegistry } from '../../../config/repo-config.ts';

/**
 * The Repos admin screen: list every registered repo, register a new one,
 * edit or delete an existing one. Talks to `/api/admin/repos[/:key]`
 * (src/dashboard/admin-api.ts) exclusively through `adminFetch`.
 *
 * Deleting a repo here has a LIVE effect, not just a database edit: the
 * watcher (`pipeline watch`) rereads the registry and stops dispatching work
 * for that repo within one polling tick. The delete confirmation says this
 * in the sentence a person reads before clicking, not just in this comment.
 */

// ---------------------------------------------------------------------------
// List state — same loading/error/empty/ready shape as stats-store.ts's
// FetchState, kept local rather than imported: this screen isn't windowed
// stats, and duplicating a 4-line union is cheaper than coupling the two.
// ---------------------------------------------------------------------------

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; repos: RepoRegistry };

const listState = signal<ListState>({ status: 'loading' });

// ---------------------------------------------------------------------------
// Panel state — which secondary panel (the create/edit form, or a row's
// delete confirmation) is open right now. Exactly one of these is ever open
// at a time: the editor takes over the whole screen and the delete
// confirmation sits above the table, so they already render mutually
// exclusively. This signal is the only place that decides which one that
// is, and every opener goes through `reduceRepoPanel` below rather than
// setting its own flag directly — "open B" then also closes A for free,
// with no separate clear-call to remember at each call site, and nothing
// for a third panel added later to forget.
// ---------------------------------------------------------------------------

export type RepoPanel =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; key: string }
  | { kind: 'confirmDelete'; key: string };

export type RepoPanelAction =
  | { type: 'openCreate' }
  | { type: 'openEdit'; key: string }
  | { type: 'requestDelete'; key: string }
  | { type: 'close' };

/** Pure transition: given whatever panel is currently open, decides the
 *  next one. Every branch fully replaces the panel rather than patching a
 *  field on it — that is what makes the result mutually exclusive. There is
 *  no way to "open edit" and leave a stale delete confirmation behind,
 *  because the value this returns has no field left to hold one. */
export function reduceRepoPanel(_current: RepoPanel, action: RepoPanelAction): RepoPanel {
  switch (action.type) {
    case 'openCreate':
      return { kind: 'create' };
    case 'openEdit':
      return { kind: 'edit', key: action.key };
    case 'requestDelete':
      return { kind: 'confirmDelete', key: action.key };
    case 'close':
      return { kind: 'closed' };
  }
}

const panel = signal<RepoPanel>({ kind: 'closed' });

/**
 * Every input in the form, as strings/booleans a `<input>` can bind to
 * directly. Numbers and JSON stay as raw text until submit — parsing them on
 * every keystroke would either reject a number mid-type or need a second,
 * separate "last known good" value, and JSON in particular is not valid
 * while the admin is still typing it.
 */
export interface RepoFormState {
  active: boolean;
  autoReview: boolean;
  reviewDrafts: boolean;
  testCases: boolean;
  url: string;
  branch: string;
  repoKey: string;
  organization: string;
  orgUrl: string;
  project: string;
  repositoryId: string;
  repositoryName: string;
  areaPath: string;
  iterationPath: string;
  ciPipelineId: string;
  cdPipelineId: string;
  docsRepoUrl: string;
  companionsJson: string;
  envProvisionJson: string;
  appRoot: string;
  source: string;
  testAppRoot: string;
  test: string;
}

const form = signal<RepoFormState>(emptyFormState());
/** Registration key — only editable in 'create' mode; 'edit' mode takes it
 *  from the URL and never lets it change (renaming would mean delete + recreate). */
const keyInput = signal('');
const formErrors = signal<AdminFieldError[]>([]);
const formMessage = signal<string | null>(null);
const saving = signal(false);

// ---------------------------------------------------------------------------
// Delete-confirmation state — busy/error only; which row it's for lives in
// `panel` above.
// ---------------------------------------------------------------------------

const deleteError = signal<string | null>(null);
const deleting = signal(false);

// ---------------------------------------------------------------------------
// Pure helpers — no signals, no network. Kept separate from the component
// bodies below so they are unit-testable without rendering anything (repo
// convention — see tests/dashboard/stats-config.test.ts).
// ---------------------------------------------------------------------------

export function emptyFormState(): RepoFormState {
  return {
    active: true,
    autoReview: true,
    reviewDrafts: false,
    testCases: false,
    url: '',
    branch: 'main',
    repoKey: '',
    organization: '',
    orgUrl: '',
    project: '',
    repositoryId: '',
    repositoryName: '',
    areaPath: '',
    iterationPath: '',
    ciPipelineId: '',
    cdPipelineId: '',
    docsRepoUrl: '',
    companionsJson: '{}',
    envProvisionJson: '',
    appRoot: '',
    source: '',
    testAppRoot: '',
    test: '',
  };
}

/** Populates the form from a fetched config, for the "edit" path. The
 *  inverse of `buildRepoConfigFromForm`, though not a perfect round trip:
 *  `active`/`autoReview` normalise an absent flag to its documented default
 *  (see repo-config.ts) rather than leaving the box in a tri-state. */
export function repoConfigToFormState(config: RepoConfig): RepoFormState {
  return {
    active: !!config.active,
    autoReview: config.autoReview !== false,
    reviewDrafts: !!config.reviewDrafts,
    testCases: !!config.testCases,
    url: config.url,
    branch: config.branch,
    repoKey: config.repoKey,
    organization: config.azureDevOps.organization ?? '',
    orgUrl: config.azureDevOps.orgUrl ?? '',
    project: config.azureDevOps.project,
    repositoryId: config.azureDevOps.repositoryId,
    repositoryName: config.azureDevOps.repositoryName,
    areaPath: config.azureDevOps.areaPath,
    iterationPath: config.azureDevOps.iterationPath ?? '',
    ciPipelineId: config.azureDevOps.ciPipelineId != null ? String(config.azureDevOps.ciPipelineId) : '',
    cdPipelineId: config.azureDevOps.cdPipelineId != null ? String(config.azureDevOps.cdPipelineId) : '',
    docsRepoUrl: config.docsWriter?.docsRepoUrl ?? '',
    companionsJson: JSON.stringify(config.companions ?? {}, null, 2),
    envProvisionJson: config.envProvision ? JSON.stringify(config.envProvision, null, 2) : '',
    appRoot: config.layout.appRoot,
    source: config.layout.source,
    testAppRoot: config.layout.testAppRoot,
    test: config.layout.test,
  };
}

/** Parses one JSON textarea. Deliberately shallow — this only needs to say
 *  "that is not valid JSON" before a network round trip; the server's zod
 *  schema (repoConfigSchema) is the real, deep validator either way. */
export function parseJsonField(text: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses an optional integer field (the two pipeline ids), appending a
 *  field error rather than throwing. Returns `undefined` for a blank field
 *  (the id is genuinely absent) and for an invalid one (the caller has
 *  already recorded why). */
export function parseOptionalInt(text: string, path: string, errors: AdminFieldError[]): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) {
    errors.push({ path, message: 'Must be a whole number.' });
    return undefined;
  }
  return n;
}

/**
 * Builds a `RepoConfig` ready to PUT, or the client-side errors that stopped
 * it — rendered through the same "list of path — message" convention as a
 * 400 from the server (admin-fetch.ts), so a JSON typo and a server
 * rejection read identically to the admin.
 */
export function buildRepoConfigFromForm(form: RepoFormState): { ok: true; config: RepoConfig } | { ok: false; errors: AdminFieldError[] } {
  const errors: AdminFieldError[] = [];

  const companionsSource = form.companionsJson.trim() === '' ? '{}' : form.companionsJson;
  const companionsParsed = parseJsonField(companionsSource, 'companions');
  let companions: RepoConfig['companions'] = {};
  if (!companionsParsed.ok) {
    errors.push({ path: 'companions', message: companionsParsed.error });
  } else if (!isPlainObject(companionsParsed.value)) {
    errors.push({ path: 'companions', message: 'companions must be a JSON object mapping a companion key to its overrides.' });
  } else {
    companions = companionsParsed.value as RepoConfig['companions'];
  }

  let envProvision: RepoConfig['envProvision'] | undefined;
  if (form.envProvisionJson.trim() !== '') {
    const envParsed = parseJsonField(form.envProvisionJson, 'envProvision');
    if (!envParsed.ok) {
      errors.push({ path: 'envProvision', message: envParsed.error });
    } else if (!isPlainObject(envParsed.value)) {
      errors.push({ path: 'envProvision', message: 'envProvision must be a JSON object.' });
    } else {
      envProvision = envParsed.value as RepoConfig['envProvision'];
    }
  }

  const ciPipelineId = parseOptionalInt(form.ciPipelineId, 'azureDevOps.ciPipelineId', errors);
  const cdPipelineId = parseOptionalInt(form.cdPipelineId, 'azureDevOps.cdPipelineId', errors);

  if (errors.length > 0) return { ok: false, errors };

  const azureDevOps: RepoConfig['azureDevOps'] = {
    project: form.project.trim(),
    repositoryId: form.repositoryId.trim(),
    repositoryName: form.repositoryName.trim(),
    areaPath: form.areaPath.trim(),
  };
  if (form.organization.trim()) azureDevOps.organization = form.organization.trim();
  if (form.orgUrl.trim()) azureDevOps.orgUrl = form.orgUrl.trim();
  if (form.iterationPath.trim()) azureDevOps.iterationPath = form.iterationPath.trim();
  if (ciPipelineId !== undefined) azureDevOps.ciPipelineId = ciPipelineId;
  if (cdPipelineId !== undefined) azureDevOps.cdPipelineId = cdPipelineId;

  const config: RepoConfig = {
    active: form.active,
    autoReview: form.autoReview,
    reviewDrafts: form.reviewDrafts,
    testCases: form.testCases,
    url: form.url.trim(),
    branch: form.branch.trim(),
    azureDevOps,
    repoKey: form.repoKey.trim(),
    companions,
    layout: {
      appRoot: form.appRoot.trim(),
      source: form.source.trim(),
      testAppRoot: form.testAppRoot.trim(),
      test: form.test.trim(),
    },
  };
  if (form.docsRepoUrl.trim()) config.docsWriter = { docsRepoUrl: form.docsRepoUrl.trim() };
  if (envProvision) config.envProvision = envProvision;

  return { ok: true, config };
}

export interface RepoRow {
  key: string;
  name: string;
  active: boolean;
  autoReview: boolean;
}

/** `name` has no literal field in `RepoConfig` — `azureDevOps.repositoryName`
 *  is the closest human-readable identifier for a row, so that is what
 *  renders under "Name". `active`/`autoReview` are normalised to the
 *  behaviour an absent flag actually has (repo-config.ts's own doc
 *  comments): an absent `active` is NOT active (src/config/repos.ts's
 *  `getActiveAreaPaths` filters on plain truthiness), while an absent
 *  `autoReview` DOES auto-review. Showing the raw `undefined` as "No" for
 *  autoReview would be a readable lie. */
export function describeRepoRow(key: string, config: RepoConfig): RepoRow {
  return {
    key,
    name: config.azureDevOps.repositoryName,
    active: !!config.active,
    autoReview: config.autoReview !== false,
  };
}

export function listRepoRows(repos: RepoRegistry): RepoRow[] {
  return Object.entries(repos)
    .map(([key, config]) => describeRepoRow(key, config))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The sentence a person reads before deleting a repo. Names the repo (not
 *  just the key) and states the live consequence — this is a running
 *  process noticing a row disappeared, not a database edit with no other
 *  effect. */
export function buildDeleteConfirmationText(key: string, config: RepoConfig): string {
  return `Delete "${config.azureDevOps.repositoryName}" (key "${key}")? `
    + 'The watcher stops seeing it on its next poll — this takes effect immediately, not just in the database.';
}

/** Mirrors `isDangerousKey` in admin-api.ts. Duplicated on purpose rather
 *  than imported: that module pulls in server-only dependencies (a
 *  PostgreSQL client, the registry hydrator) that must never reach the
 *  browser bundle. This only buys a friendlier, immediate error — the
 *  server rejects the same three keys regardless. */
const CLIENT_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

async function loadRepos(): Promise<void> {
  listState.value = { status: 'loading' };
  const result = await adminFetch<RepoRegistry>('/api/admin/repos');
  if (!result.ok) {
    listState.value = { status: 'error', message: result.message };
    return;
  }
  listState.value = Object.keys(result.data).length === 0
    ? { status: 'empty' }
    : { status: 'ready', repos: result.data };
}

function openCreate(): void {
  panel.value = reduceRepoPanel(panel.value, { type: 'openCreate' });
  keyInput.value = '';
  form.value = emptyFormState();
  formErrors.value = [];
  formMessage.value = null;
}

function openEdit(key: string, config: RepoConfig): void {
  panel.value = reduceRepoPanel(panel.value, { type: 'openEdit', key });
  form.value = repoConfigToFormState(config);
  formErrors.value = [];
  formMessage.value = null;
}

function closeEditor(): void {
  panel.value = reduceRepoPanel(panel.value, { type: 'close' });
}

async function submitForm(): Promise<void> {
  const p = panel.value;
  if (p.kind !== 'create' && p.kind !== 'edit') return;

  formMessage.value = null;
  formErrors.value = [];

  let key: string;
  if (p.kind === 'create') {
    key = keyInput.value.trim();
    if (key === '') {
      formErrors.value = [{ path: 'key', message: 'A key is required.' }];
      return;
    }
    if (CLIENT_DANGEROUS_KEYS.has(key)) {
      formErrors.value = [{ path: 'key', message: `"${key}" cannot be used as a key.` }];
      return;
    }
  } else {
    key = p.key;
  }

  const built = buildRepoConfigFromForm(form.value);
  if (!built.ok) {
    formMessage.value = 'Fix the errors below and try again.';
    formErrors.value = built.errors;
    return;
  }

  saving.value = true;
  try {
    const result = await adminFetch(`/api/admin/repos/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.config),
    });
    if (!result.ok) {
      formMessage.value = result.message;
      formErrors.value = result.errors;
      return;
    }
    panel.value = reduceRepoPanel(panel.value, { type: 'close' });
    await loadRepos();
  } finally {
    saving.value = false;
  }
}

function requestDelete(key: string): void {
  panel.value = reduceRepoPanel(panel.value, { type: 'requestDelete', key });
  deleteError.value = null;
}

function cancelDelete(): void {
  panel.value = reduceRepoPanel(panel.value, { type: 'close' });
}

async function confirmDelete(key: string): Promise<void> {
  deleting.value = true;
  try {
    const result = await adminFetch(`/api/admin/repos/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!result.ok) {
      deleteError.value = result.message;
      return;
    }
    panel.value = reduceRepoPanel(panel.value, { type: 'close' });
    await loadRepos();
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Small field renderers — one form with ~20 inputs is worth this much
// abstraction; anything smaller wouldn't be.
// ---------------------------------------------------------------------------

interface TextFieldProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
}

function TextField({ label, value, onInput, type = 'text', required = false, hint }: TextFieldProps) {
  return (
    <label class="repo-form__field">
      <span class="repo-form__field-label">{label}{required ? ' *' : ''}</span>
      <input
        class="input"
        type={type}
        value={value}
        required={required}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
      {hint && <span class="repo-form__hint">{hint}</span>}
    </label>
  );
}

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}

function CheckboxField({ label, checked, onChange, hint }: CheckboxFieldProps) {
  return (
    <label class="repo-form__checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span>{label}</span>
      {hint && <span class="repo-form__hint">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// The editor panel
// ---------------------------------------------------------------------------

function RepoEditorPanel() {
  const p = panel.value;
  if (p.kind !== 'create' && p.kind !== 'edit') return null;
  const f = form.value;
  const isCreate = p.kind === 'create';
  const editKey = p.kind === 'edit' ? p.key : null;

  function set<K extends keyof RepoFormState>(key: K, value: RepoFormState[K]): void {
    form.value = { ...form.value, [key]: value };
  }

  return (
    <div class="repo-form">
      <h3>{isCreate ? 'Register a new repo' : `Edit "${editKey}"`}</h3>

      <fieldset class="repo-form__section">
        <legend>Registration</legend>
        <div class="repo-form__grid">
          {isCreate ? (
            <TextField
              label="Key"
              value={keyInput.value}
              onInput={(v) => { keyInput.value = v; }}
              required
              hint="Used in the address for this repo. Cannot be changed after it's created."
            />
          ) : (
            <div class="repo-form__field">
              <span class="repo-form__field-label">Key</span>
              <code class="config-mono">{editKey}</code>
            </div>
          )}
        </div>
      </fieldset>

      <fieldset class="repo-form__section">
        <legend>Repo</legend>
        <div class="repo-form__grid">
          <TextField label="Clone URL" value={f.url} onInput={(v) => set('url', v)} required />
          <TextField label="Branch" value={f.branch} onInput={(v) => set('branch', v)} required />
          <TextField
            label="Session key"
            value={f.repoKey}
            onInput={(v) => set('repoKey', v)}
            required
            hint="The directory name this repo's session uses, and the key any companion override targets. Usually the same as the key above."
          />
        </div>
      </fieldset>

      <fieldset class="repo-form__section">
        <legend>Azure DevOps</legend>
        <div class="repo-form__grid">
          <TextField label="Project" value={f.project} onInput={(v) => set('project', v)} required />
          <TextField label="Repository ID (GUID)" value={f.repositoryId} onInput={(v) => set('repositoryId', v)} required />
          <TextField label="Repository name" value={f.repositoryName} onInput={(v) => set('repositoryName', v)} required />
          <TextField label="Area path" value={f.areaPath} onInput={(v) => set('areaPath', v)} required />
          <TextField
            label="Iteration path"
            value={f.iterationPath}
            onInput={(v) => set('iterationPath', v)}
            hint="Leave blank to use the area path."
          />
          <TextField label="Organization" value={f.organization} onInput={(v) => set('organization', v)} />
          <TextField label="Organization URL" value={f.orgUrl} onInput={(v) => set('orgUrl', v)} />
          <TextField label="CI pipeline ID" value={f.ciPipelineId} onInput={(v) => set('ciPipelineId', v)} type="number" />
          <TextField label="CD pipeline ID" value={f.cdPipelineId} onInput={(v) => set('cdPipelineId', v)} type="number" />
        </div>
      </fieldset>

      <fieldset class="repo-form__section">
        <legend>Directory layout</legend>
        <div class="repo-form__grid">
          <TextField label="App root" value={f.appRoot} onInput={(v) => set('appRoot', v)} required hint="Directory holding app.json, e.g. Cloud" />
          <TextField label="Source path" value={f.source} onInput={(v) => set('source', v)} required hint="e.g. Cloud/Al" />
          <TextField label="Test app root" value={f.testAppRoot} onInput={(v) => set('testAppRoot', v)} required hint="e.g. Test" />
          <TextField label="Test source path" value={f.test} onInput={(v) => set('test', v)} required hint="e.g. Test/Src" />
        </div>
      </fieldset>

      <fieldset class="repo-form__section">
        <legend>Flags</legend>
        <div class="repo-form__checkboxes">
          <CheckboxField label="Active" checked={f.active} onChange={(v) => set('active', v)} hint="Inactive repos are ignored by the watcher." />
          <CheckboxField label="Automatically review new pull requests" checked={f.autoReview} onChange={(v) => set('autoReview', v)} />
          <CheckboxField label="Automatically review draft pull requests" checked={f.reviewDrafts} onChange={(v) => set('reviewDrafts', v)} />
          <CheckboxField label="Run the test-case stages" checked={f.testCases} onChange={(v) => set('testCases', v)} />
        </div>
        <div class="repo-form__grid">
          <TextField
            label="Docs repo URL"
            value={f.docsRepoUrl}
            onInput={(v) => set('docsRepoUrl', v)}
            hint="Leave blank to skip the documentation-writing stage."
          />
        </div>
      </fieldset>

      <fieldset class="repo-form__section">
        <legend>Advanced (JSON)</legend>
        <label class="repo-form__field">
          <span class="repo-form__field-label">Companions</span>
          <textarea
            class="repo-form__textarea"
            rows={4}
            value={f.companionsJson}
            onInput={(e) => set('companionsJson', (e.target as HTMLTextAreaElement).value)}
          />
          <span class="repo-form__hint">
            Maps a companion registry key to overrides, e.g. {'{ "BC": { "branch": "main" } }'}. Leave as {'{}'} for none.
          </span>
        </label>
        <label class="repo-form__field">
          <span class="repo-form__field-label">Environment provisioning</span>
          <textarea
            class="repo-form__textarea"
            rows={4}
            placeholder="Leave blank to skip provisioning a Business Central environment."
            value={f.envProvisionJson}
            onInput={(e) => set('envProvisionJson', (e.target as HTMLTextAreaElement).value)}
          />
        </label>
      </fieldset>

      {formMessage.value && <p class="repo-form__banner">{formMessage.value}</p>}
      {formErrors.value.length > 0 && (
        <ul class="repo-form__errors">
          {formErrors.value.map((e, i) => (
            <li key={i}><code class="config-mono">{e.path}</code> — {e.message}</li>
          ))}
        </ul>
      )}

      <div class="repo-form__actions">
        <button type="button" class="btn btn--primary" disabled={saving.value} onClick={submitForm}>
          {saving.value ? 'Saving…' : isCreate ? 'Create repo' : 'Save changes'}
        </button>
        <button type="button" class="btn" disabled={saving.value} onClick={closeEditor}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list panel
// ---------------------------------------------------------------------------

function RepoListPanel() {
  const state = listState.value;

  return (
    <div class={`stats-slot stats-slot--${state.status}`}>
      <div class="stats-slot__header">
        <span class="stats-slot__title">Registered repos</span>
      </div>

      {(() => {
        const p = panel.value;
        if (p.kind !== 'confirmDelete' || state.status !== 'ready') return null;
        const key = p.key;
        const config = state.repos[key];
        if (!config) return null;
        return (
          <div class="repo-delete-confirm">
            <p>{buildDeleteConfirmationText(key, config)}</p>
            <div class="repo-delete-confirm__actions">
              <button type="button" class="btn btn--error" disabled={deleting.value} onClick={() => confirmDelete(key)}>
                {deleting.value ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button type="button" class="btn" disabled={deleting.value} onClick={cancelDelete}>Cancel</button>
            </div>
            {deleteError.value && <span class="action-error">{deleteError.value}</span>}
          </div>
        );
      })()}

      {state.status === 'loading' && <p class="empty-state">Loading repos…</p>}
      {state.status === 'error' && <p class="empty-state">Could not load repos: {state.message}</p>}
      {state.status === 'empty' && <p class="empty-state">No repos are registered yet.</p>}
      {state.status === 'ready' && (
        <table class="config-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Active</th>
              <th>Auto-review</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {listRepoRows(state.repos).map((row) => {
              const config = state.repos[row.key];
              return (
                <tr key={row.key}>
                  <td><code class="config-table__mono">{row.key}</code></td>
                  <td>{row.name}</td>
                  <td>{row.active ? 'Yes' : 'No'}</td>
                  <td>{row.autoReview ? 'Yes' : 'No'}</td>
                  <td class="config-table__actions">
                    <button type="button" class="btn" onClick={() => config && openEdit(row.key, config)}>Edit</button>
                    <button type="button" class="btn btn--error" onClick={() => requestDelete(row.key)}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function AdminRepos() {
  // Refetch on every mount rather than caching — same reasoning as
  // StatsView: an operate-mode screen showing a stale registry with no
  // "stale" marker is worse than a brief loading flash.
  useEffect(() => { loadRepos(); }, []);

  return (
    <div class="admin-repos">
      {panel.value.kind === 'create' || panel.value.kind === 'edit' ? (
        <RepoEditorPanel />
      ) : (
        <>
          <div class="admin-repos__toolbar">
            <button type="button" class="btn btn--primary" onClick={openCreate}>+ New repo</button>
          </div>
          <RepoListPanel />
        </>
      )}
    </div>
  );
}
