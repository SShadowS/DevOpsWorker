/**
 * The admin config API — `/api/admin/repos`, `/api/admin/companions`,
 * `/api/admin/settings`, `/api/admin/audit`. Every route here needs the
 * `admin` role; `src/auth/route-access.ts` enforces that (and
 * `src/dashboard/server.ts`'s gate rejects before this file is ever reached),
 * so every handler below may assume `user` is an authenticated admin.
 *
 * Reads go through the store abstractions (`registryStore`, `settingsStore`,
 * `auditStore`) — the same ones every other process uses. Writes do NOT: a
 * write must land in the same database transaction as its audit row (see
 * `sql.begin` below), and `IRegistryStore`/`ISettingsStore` have no
 * transaction parameter (only `IAuditStore.write` does, by design — see its
 * jsdoc). So every mutation here runs its own `INSERT`/`DELETE` directly
 * against the transaction handle, mirroring the exact queries
 * `PgRegistryStore`/`PgSettingsStore` use, and passes that same handle to
 * `auditStore.write`. If the audit insert fails, `sql.begin` rolls back the
 * row change with it — that's the whole point.
 */
import type postgres from 'postgres';
import type { AuthUser } from '../auth/types.ts';
import type { IRegistryStore } from '../config/registry-store.interface.ts';
import type { ISettingsStore } from '../config/settings-store.interface.ts';
import type { IAuditStore } from '../config/audit-store.interface.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import type { CompanionDef } from '../config/companions.ts';
import { repoConfigSchema, companionConfigSchema, validateSetting } from '../config/schemas.ts';
import { hydrateRegistryFromDb } from '../config/hydrate.ts';
import { isUniqueViolation } from '../cli/admin.ts';

export interface AdminApiDeps {
  sql: postgres.Sql;
  registryStore: IRegistryStore;
  settingsStore: ISettingsStore;
  auditStore: IAuditStore;
}

// ---------------------------------------------------------------------------
// Dangerous keys — prototype-pollution guard
// ---------------------------------------------------------------------------
//
// A repo/companion/settings key eventually flows into `replaceRepos` /
// `replaceCompanions` (src/config/hydrate.ts), both of which call
// `Object.assign(liveRegistry, next)`. `Object.assign` sets each of `next`'s
// own enumerable keys onto the target with a normal property SET — and a key
// literally named `__proto__` does not become a plain "__proto__" entry, it
// re-points the target's own prototype. `JSON.parse('{"__proto__":{}}')`
// produces exactly such an own enumerable property, so any caller sending
// that as a repo/companion/settings key is one step from swapping the live
// registry's prototype. `constructor` and `prototype` carry no such direct
// exploit through this specific path, but they are the two other keys every
// prototype-pollution payload reaches for, and neither is a coherent
// repo/companion/settings identifier — reject them outright rather than trust
// the case-by-case gadget analysis to stay complete.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

function dangerousKeyResponse(key: string): Response {
  return Response.json({ error: `"${key}" cannot be used as a key` }, { status: 400 });
}

/**
 * The body half of the same guard. The brief's threat model is "a key
 * arrives from an HTTP body OR path" — `isDangerousKey` above only ever sees
 * the URL `:key` segment. `RepoConfig.companions` is `z.record(...)` (an
 * open key set — it cannot be `.strict()`, there is no fixed list of
 * companion names to enumerate) and a settings value such as
 * `models.perAgent` is a record too, so a `__proto__`-named key can arrive
 * nested anywhere inside an otherwise well-formed body.
 *
 * Today, feeding such a body through `z.record(...).safeParse(...)` happens
 * to drop the `__proto__`-named entry silently rather than assigning it — but
 * that is an accident of zod's internals, not something this codebase
 * asserts, and it is exactly the kind of behaviour a dependency bump can
 * change without warning. `replaceRepos`/`replaceCompanions` (hydrate.ts) do
 * a real `Object.assign` one hop downstream of whatever a schema lets
 * through, so this walks the RAW parsed body — before it ever reaches
 * `safeParse` — and rejects outright rather than trusting zod to keep
 * dropping it.
 *
 * Bounded by `MAX_BODY_DEPTH`: this now runs unconditionally on every
 * admin PUT body before any schema check, so an attacker-controlled body
 * nested far deeper than any real config could exhaust the call stack here
 * — turning what `safeParse`/`validateSetting` would otherwise reject
 * cheaply (most schema mismatches don't recurse into the value at all) into
 * a `RangeError`. Treating "too deep to be legitimate" as itself a rejection
 * is simpler and cheaper than making the walk iterative.
 */
const MAX_BODY_DEPTH = 20;

export function containsDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_BODY_DEPTH) return true; // too deep to be legitimate config — reject rather than recurse further
  if (Array.isArray(value)) {
    return value.some((item) => containsDangerousKey(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isDangerousKey(key)) return true;
      if (containsDangerousKey((value as Record<string, unknown>)[key], depth + 1)) return true;
    }
  }
  return false;
}

function dangerousBodyKeyResponse(): Response {
  return Response.json({ error: 'The request body contains a disallowed key ("__proto__", "constructor", or "prototype")' }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Mirrors `seed.ts`'s `describeIssues` shape rather than importing zod's own
 *  `ZodError` type — this only ever needs `.issues`, and `validateSetting`'s
 *  own return shape (`{ path, message }`) already matches what plan 3's forms
 *  expect, so repo/companion validation is normalised to the same shape. */
function issuesToFieldErrors(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
  }
}

/** Best-effort — a refresh failure must never fail the mutation that
 *  triggered it; the next TTL-gated refresh (or the next mutation) will
 *  catch up. See `DashboardOptions`'s `REGISTRY_TTL_MS` comment in server.ts
 *  for the periodic path this supplements. */
async function refreshRegistryAfterMutation(registryStore: IRegistryStore): Promise<void> {
  try {
    await hydrateRegistryFromDb(registryStore);
  } catch (err) {
    console.warn(`[admin-api] failed to refresh the repo/companion registry after a mutation: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

async function listRepos(deps: AdminApiDeps): Promise<Response> {
  return Response.json(await deps.registryStore.listRepos());
}

async function getRepo(deps: AdminApiDeps, key: string): Promise<Response> {
  const repo = await deps.registryStore.getRepo(key);
  if (!repo) return Response.json({ error: `No repo registered under "${key}"` }, { status: 404 });
  return Response.json(repo);
}

async function putRepo(req: Request, user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  if (containsDangerousKey(parsed.body)) return dangerousBodyKeyResponse();

  const result = repoConfigSchema.safeParse(parsed.body);
  if (!result.success) {
    return Response.json({ errors: issuesToFieldErrors(result.error) }, { status: 400 });
  }
  const config = result.data;

  try {
    await deps.sql.begin(async (tx) => {
      const rows = await tx`SELECT config FROM repo_registry WHERE repo_key = ${key} FOR UPDATE`;
      const before = rows.length > 0 ? (rows[0]!.config as RepoConfig) : null;
      await tx`
        INSERT INTO repo_registry (repo_key, config, updated_at, updated_by)
        VALUES (${key}, ${tx.json(config as unknown as postgres.JSONValue)}, now(), ${user.email})
        ON CONFLICT (repo_key) DO UPDATE
          SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
      await deps.auditStore.write({
        actorEmail: user.email,
        action: before === null ? 'create' : 'update',
        entityType: 'repo',
        entityKey: key,
        beforeValue: before,
        afterValue: config,
      }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json({ error: `A repo is already registered under "${key}"` }, { status: 409 });
    }
    throw err;
  }

  await refreshRegistryAfterMutation(deps.registryStore);
  return Response.json({ ok: true, key, repo: config });
}

async function deleteRepo(user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const before = await deps.sql.begin(async (tx) => {
    const rows = await tx`SELECT config FROM repo_registry WHERE repo_key = ${key} FOR UPDATE`;
    if (rows.length === 0) return null;
    const existing = rows[0]!.config as RepoConfig;
    await tx`DELETE FROM repo_registry WHERE repo_key = ${key}`;
    await deps.auditStore.write({
      actorEmail: user.email,
      action: 'delete',
      entityType: 'repo',
      entityKey: key,
      beforeValue: existing,
      afterValue: null,
    }, tx);
    return existing;
  });

  if (before === null) return Response.json({ error: `No repo registered under "${key}"` }, { status: 404 });
  await refreshRegistryAfterMutation(deps.registryStore);
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Companions
// ---------------------------------------------------------------------------

async function listCompanions(deps: AdminApiDeps): Promise<Response> {
  return Response.json(await deps.registryStore.listCompanions());
}

async function getCompanion(deps: AdminApiDeps, key: string): Promise<Response> {
  const companion = await deps.registryStore.getCompanion(key);
  if (!companion) return Response.json({ error: `No companion registered under "${key}"` }, { status: 404 });
  return Response.json(companion);
}

async function putCompanion(req: Request, user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  if (containsDangerousKey(parsed.body)) return dangerousBodyKeyResponse();

  const result = companionConfigSchema.safeParse(parsed.body);
  if (!result.success) {
    return Response.json({ errors: issuesToFieldErrors(result.error) }, { status: 400 });
  }
  const config = result.data;

  try {
    await deps.sql.begin(async (tx) => {
      const rows = await tx`SELECT config FROM companion_registry WHERE companion_key = ${key} FOR UPDATE`;
      const before = rows.length > 0 ? (rows[0]!.config as CompanionDef) : null;
      await tx`
        INSERT INTO companion_registry (companion_key, config, updated_at, updated_by)
        VALUES (${key}, ${tx.json(config as unknown as postgres.JSONValue)}, now(), ${user.email})
        ON CONFLICT (companion_key) DO UPDATE
          SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
      await deps.auditStore.write({
        actorEmail: user.email,
        action: before === null ? 'create' : 'update',
        entityType: 'companion',
        entityKey: key,
        beforeValue: before,
        afterValue: config,
      }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json({ error: `A companion is already registered under "${key}"` }, { status: 409 });
    }
    throw err;
  }

  await refreshRegistryAfterMutation(deps.registryStore);
  return Response.json({ ok: true, key, companion: config });
}

async function deleteCompanion(user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const before = await deps.sql.begin(async (tx) => {
    const rows = await tx`SELECT config FROM companion_registry WHERE companion_key = ${key} FOR UPDATE`;
    if (rows.length === 0) return null;
    const existing = rows[0]!.config as CompanionDef;
    await tx`DELETE FROM companion_registry WHERE companion_key = ${key}`;
    await deps.auditStore.write({
      actorEmail: user.email,
      action: 'delete',
      entityType: 'companion',
      entityKey: key,
      beforeValue: existing,
      afterValue: null,
    }, tx);
    return existing;
  });

  if (before === null) return Response.json({ error: `No companion registered under "${key}"` }, { status: 404 });
  await refreshRegistryAfterMutation(deps.registryStore);
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
//
// Settings never touch the repo/companion registry, so unlike the two
// sections above, no post-mutation refresh is needed: every reader
// (`readAllSettingsSafely`) queries the `settings` table fresh on each call.

async function listSettings(deps: AdminApiDeps): Promise<Response> {
  return Response.json(await deps.settingsStore.getAll());
}

/** Wire shape: `PUT` body is `{ "value": <the setting's own value shape> }` —
 *  e.g. `{ "value": 40 }` for `agents.coder.maxTurns`, or
 *  `{ "value": { "coder": "claude-sonnet-5" } }` for `models.perAgent`. The
 *  route is generic (`/api/admin/settings/:key`), so there is no per-key
 *  field name to hang the value off; `value` wraps whatever
 *  `validateSetting(key, ...)` expects for that key. */
async function putSetting(req: Request, user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  if (containsDangerousKey(parsed.body)) return dangerousBodyKeyResponse();

  const value = (parsed.body as { value?: unknown } | null)?.value;
  const result = validateSetting(key, value);
  if (!result.valid) {
    return Response.json({ errors: result.errors }, { status: 400 });
  }

  try {
    await deps.sql.begin(async (tx) => {
      const rows = await tx`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`;
      const before = rows.length > 0 ? rows[0]!.value : null;
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by)
        VALUES (${key}, ${tx.json(result.value as postgres.JSONValue)}, now(), ${user.email})
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
      // Finding M-2: this is the OTHER path (besides POST /api/runners) that
      // can write `runner.maxConcurrency` through the settings table. Clear
      // the legacy runner_status "config" key in the SAME transaction, so a
      // later DELETE of this setting reads null (the code default) instead of
      // resurrecting whatever pre-migration value still sat there.
      if (key === 'runner.maxConcurrency') {
        await tx`DELETE FROM runner_status WHERE key = 'config'`;
      }
      await deps.auditStore.write({
        actorEmail: user.email,
        action: before === null ? 'create' : 'update',
        entityType: 'setting',
        entityKey: key,
        beforeValue: before,
        afterValue: result.value,
      }, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json({ error: `Setting "${key}" already exists` }, { status: 409 });
    }
    throw err;
  }

  return Response.json({ ok: true, key, value: result.value });
}

/** Deletes the stored override so the key falls back to its environment
 *  variable or code default — see `readSetting` in `src/cli/config.ts`,
 *  which already treats an absent key exactly like this. */
async function deleteSetting(user: AuthUser, deps: AdminApiDeps, key: string): Promise<Response> {
  const before = await deps.sql.begin(async (tx) => {
    const rows = await tx`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`;
    if (rows.length === 0) return undefined;
    const existing = rows[0]!.value;
    await tx`DELETE FROM settings WHERE key = ${key}`;
    await deps.auditStore.write({
      actorEmail: user.email,
      action: 'delete',
      entityType: 'setting',
      entityKey: key,
      beforeValue: existing,
      afterValue: null,
    }, tx);
    return existing;
  });

  if (before === undefined) return Response.json({ error: `No setting stored under "${key}"` }, { status: 404 });
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function listAudit(deps: AdminApiDeps, url: URL): Promise<Response> {
  const raw = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 50;
  return Response.json(await deps.auditStore.list(limit));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Routes every `/api/admin/*` request. Callers must only invoke this for a
 *  path already known to start with `/api/admin/`, and only once the caller
 *  is a confirmed admin — this function does no authentication or role
 *  checking of its own; `src/dashboard/server.ts`'s gate (backed by
 *  `src/auth/route-access.ts`) does that before dispatch. */
export async function handleAdminApi(req: Request, url: URL, user: AuthUser, deps: AdminApiDeps): Promise<Response> {
  const path = url.pathname;

  try {
    if (path === '/api/admin/repos' && req.method === 'GET') return await listRepos(deps);
    const repoMatch = /^\/api\/admin\/repos\/([^/]+)$/.exec(path);
    if (repoMatch) {
      const key = decodeURIComponent(repoMatch[1]!);
      if (isDangerousKey(key)) return dangerousKeyResponse(key);
      if (req.method === 'GET') return await getRepo(deps, key);
      if (req.method === 'PUT') return await putRepo(req, user, deps, key);
      if (req.method === 'DELETE') return await deleteRepo(user, deps, key);
    }

    if (path === '/api/admin/companions' && req.method === 'GET') return await listCompanions(deps);
    const companionMatch = /^\/api\/admin\/companions\/([^/]+)$/.exec(path);
    if (companionMatch) {
      const key = decodeURIComponent(companionMatch[1]!);
      if (isDangerousKey(key)) return dangerousKeyResponse(key);
      if (req.method === 'GET') return await getCompanion(deps, key);
      if (req.method === 'PUT') return await putCompanion(req, user, deps, key);
      if (req.method === 'DELETE') return await deleteCompanion(user, deps, key);
    }

    if (path === '/api/admin/settings' && req.method === 'GET') return await listSettings(deps);
    const settingMatch = /^\/api\/admin\/settings\/([^/]+)$/.exec(path);
    if (settingMatch) {
      const key = decodeURIComponent(settingMatch[1]!);
      if (isDangerousKey(key)) return dangerousKeyResponse(key);
      if (req.method === 'PUT') return await putSetting(req, user, deps, key);
      if (req.method === 'DELETE') return await deleteSetting(user, deps, key);
    }

    if (path === '/api/admin/audit' && req.method === 'GET') return await listAudit(deps, url);

    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (err) {
    console.error('[admin-api] unexpected error:', err);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
