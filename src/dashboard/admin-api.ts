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
import type { AuthUser, Role } from '../auth/types.ts';
import type { IUserStore } from '../auth/user-store.interface.ts';
import type { ISessionStore } from '../auth/session-store.interface.ts';
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
  /** Backing store for `/api/admin/users` — the SAME instance the dashboard
   *  authenticates against (see `DashboardOptions.userStore` in server.ts),
   *  never a second, independent one: disabling or re-roling a user through
   *  this API must take effect for that user's very next login/session
   *  check, not just in some parallel copy of the table. */
  userStore: IUserStore;
  /** Used only to revoke sessions on a password change — see `putUserPassword`. */
  sessionStore: ISessionStore;
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
// Users
// ---------------------------------------------------------------------------
//
// Onboarding a colleague without a shell is the entire point of this section
// — before it, changing a role or disabling an account meant raw SQL on the
// host. Every mutation below runs the exact `UPDATE`/`INSERT` PgUserStore
// would run, directly against a transaction handle, and writes its audit row
// in that same transaction — same reasoning as the module comment at the top
// of this file. `IUserStore.setRole`/`setDisabled` exist for callers who
// don't need that atomicity (e.g. future CLI use); they hold their own
// connection from the pool, so calling them from inside `sql.begin(...)`
// would NOT participate in that transaction, and the audit row could commit
// while the actual change rolled back (or vice versa) — the one guarantee
// this whole feature exists to give up. So these routes never call them.
//
// No response, audit row, or log line here may ever contain a password or
// its hash — every audit entry below is built by hand from named fields,
// never by spreading the request body or a raw row, so a `password` field
// slipping in unnoticed is not possible.

/** A lockout guard tripped — thrown only inside a `sql.begin` callback below.
 *  The dispatcher turns this into a 409 with the message as-is; every
 *  message here is written for the admin who tripped it, not a log. */
class GuardrailViolation extends Error {}

// Mirrors readPassword() in src/cli/admin.ts — the CLI and the API must
// agree on what "too short to be a real password" means.
const MIN_PASSWORD_LENGTH = 8;

function rowToAuthUser(row: postgres.Row): AuthUser {
  return {
    id: row.id as number,
    email: row.email as string,
    displayName: row.display_name as string,
    role: row.role as Role,
    disabled: row.disabled as boolean,
  };
}

async function listUsers(deps: AdminApiDeps): Promise<Response> {
  return Response.json(await deps.userStore.list());
}

/**
 * Locks the target user's row plus every currently-active admin
 * (`role = 'admin' AND disabled = false`) in one statement, ordered by id.
 * That ordering is what keeps two concurrent requests aimed at two
 * *different* admins from deadlocking on each other's rows: both queries
 * always acquire the overlapping "active admins" locks in the same id order,
 * so the second transaction blocks cleanly on the first rather than each
 * waiting on the other.
 *
 * That lock is also what makes the "last remaining admin" guard immune to
 * the count-then-act race: without it, two concurrent transactions could
 * both read "2 active admins, safe to demote the other one" and both commit,
 * leaving zero. With it, the second transaction cannot even read a count
 * until the first has committed (or rolled back) its own change — so the
 * count it sees already reflects that change.
 */
async function lockTargetAndActiveAdmins(
  tx: postgres.TransactionSql,
  email: string,
): Promise<{ target: AuthUser | null; activeAdminCount: number }> {
  const rows = await tx`
    SELECT id, email, display_name, role, disabled
    FROM users
    WHERE email = ${email} OR (role = 'admin' AND disabled = false)
    ORDER BY id
    FOR UPDATE
  `;
  const users = rows.map(rowToAuthUser);
  const target = users.find((u) => u.email === email) ?? null;
  const activeAdminCount = users.filter((u) => u.role === 'admin' && !u.disabled).length;
  return { target, activeAdminCount };
}

async function createUser(req: Request, actor: AuthUser, deps: AdminApiDeps): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { email?: unknown; displayName?: unknown; role?: unknown; password?: unknown } | null;

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) return Response.json({ error: 'email is required' }, { status: 400 });

  const role = body?.role;
  if (role !== 'admin' && role !== 'operator') {
    return Response.json({ error: 'role must be "admin" or "operator"' }, { status: 400 });
  }

  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  const displayName = typeof body?.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : email;

  const { hashPassword } = await import('../auth/local-provider.ts');
  const passwordHash = await hashPassword(password);

  try {
    const created = await deps.sql.begin(async (tx) => {
      const rows = await tx`
        INSERT INTO users (email, display_name, role, password_hash)
        VALUES (${email}, ${displayName}, ${role}, ${passwordHash})
        RETURNING id, email, display_name, role, disabled
      `;
      const user = rowToAuthUser(rows[0]!);
      await deps.auditStore.write({
        actorEmail: actor.email,
        action: 'create',
        entityType: 'user',
        entityKey: email,
        beforeValue: null,
        afterValue: { email: user.email, displayName: user.displayName, role: user.role },
      }, tx);
      return user;
    });
    return Response.json({ ok: true, user: created }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json({ error: `A user with email ${email} already exists` }, { status: 409 });
    }
    throw err;
  }
}

async function putUserRole(req: Request, actor: AuthUser, deps: AdminApiDeps, email: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const role = (parsed.body as { role?: unknown } | null)?.role;
  if (role !== 'admin' && role !== 'operator') {
    return Response.json({ error: 'role must be "admin" or "operator"' }, { status: 400 });
  }

  try {
    const result = await deps.sql.begin(async (tx) => {
      const { target, activeAdminCount } = await lockTargetAndActiveAdmins(tx, email);
      if (!target) return null;

      // Guardrail: an admin may not remove their OWN admin role, regardless
      // of how many other admins exist — self-demotion has no recovery path
      // but the CLI.
      if (target.role === 'admin' && role !== 'admin' && target.email === actor.email) {
        throw new GuardrailViolation('You cannot remove your own admin role.');
      }
      // Guardrail: the last active admin may not be demoted, by anyone.
      // Only relevant when the target is currently active — demoting an
      // already-disabled admin doesn't reduce the active count.
      if (target.role === 'admin' && role !== 'admin' && !target.disabled && activeAdminCount <= 1) {
        throw new GuardrailViolation('This is the last remaining admin. Promote another admin before removing this one.');
      }

      await tx`UPDATE users SET role = ${role}, updated_at = now() WHERE id = ${target.id}`;
      await deps.auditStore.write({
        actorEmail: actor.email,
        action: 'update',
        entityType: 'user',
        entityKey: email,
        beforeValue: { role: target.role },
        afterValue: { role },
      }, tx);
      return { ...target, role: role as Role };
    });
    if (result === null) return Response.json({ error: `No user with email ${email}` }, { status: 404 });
    return Response.json({ ok: true, user: result });
  } catch (err) {
    if (err instanceof GuardrailViolation) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

async function putUserDisabled(req: Request, actor: AuthUser, deps: AdminApiDeps, email: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const disabled = (parsed.body as { disabled?: unknown } | null)?.disabled;
  if (typeof disabled !== 'boolean') {
    return Response.json({ error: '"disabled" must be a boolean' }, { status: 400 });
  }

  try {
    const result = await deps.sql.begin(async (tx) => {
      const { target, activeAdminCount } = await lockTargetAndActiveAdmins(tx, email);
      if (!target) return null;

      if (disabled && target.role === 'admin' && !target.disabled) {
        // Guardrail: an admin may not disable their OWN account.
        if (target.email === actor.email) {
          throw new GuardrailViolation('You cannot disable your own account.');
        }
        // Guardrail: the last active admin may not be disabled, by anyone.
        if (activeAdminCount <= 1) {
          throw new GuardrailViolation('This is the last remaining admin. Promote another admin before disabling this one.');
        }
      }

      await tx`UPDATE users SET disabled = ${disabled}, updated_at = now() WHERE id = ${target.id}`;
      await deps.auditStore.write({
        actorEmail: actor.email,
        action: 'update',
        entityType: 'user',
        entityKey: email,
        beforeValue: { disabled: target.disabled },
        afterValue: { disabled },
      }, tx);
      return { ...target, disabled };
    });
    if (result === null) return Response.json({ error: `No user with email ${email}` }, { status: 404 });
    return Response.json({ ok: true, user: result });
  } catch (err) {
    if (err instanceof GuardrailViolation) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

/** No guardrail here: resetting a password (including your own) never
 *  reduces the admin count, so it can't cause the lockout the other three
 *  routes guard against. Revokes every existing session for the user
 *  afterward, exactly like `set-password` on the CLI (src/cli/admin.ts) — a
 *  password change that leaves a stolen cookie valid defeats the point. */
async function putUserPassword(req: Request, actor: AuthUser, deps: AdminApiDeps, email: string): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const password = (parsed.body as { password?: unknown } | null)?.password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  const { hashPassword } = await import('../auth/local-provider.ts');
  const passwordHash = await hashPassword(password);

  const targetId = await deps.sql.begin(async (tx) => {
    const rows = await tx`SELECT id FROM users WHERE email = ${email} FOR UPDATE`;
    if (rows.length === 0) return null;
    const id = rows[0]!.id as number;
    await tx`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${id}`;
    await deps.auditStore.write({
      actorEmail: actor.email,
      action: 'update',
      entityType: 'user',
      entityKey: email,
      beforeValue: null,
      afterValue: { passwordChanged: true },
    }, tx);
    return id;
  });

  if (targetId === null) return Response.json({ error: `No user with email ${email}` }, { status: 404 });
  await deps.sessionStore.deleteByUser(targetId);
  return Response.json({ ok: true });
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

    if (path === '/api/admin/users' && req.method === 'GET') return await listUsers(deps);
    if (path === '/api/admin/users' && req.method === 'POST') return await createUser(req, user, deps);
    const userRoleMatch = /^\/api\/admin\/users\/([^/]+)\/role$/.exec(path);
    if (userRoleMatch && req.method === 'PUT') {
      return await putUserRole(req, user, deps, decodeURIComponent(userRoleMatch[1]!).trim().toLowerCase());
    }
    const userDisabledMatch = /^\/api\/admin\/users\/([^/]+)\/disabled$/.exec(path);
    if (userDisabledMatch && req.method === 'PUT') {
      return await putUserDisabled(req, user, deps, decodeURIComponent(userDisabledMatch[1]!).trim().toLowerCase());
    }
    const userPasswordMatch = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(path);
    if (userPasswordMatch && req.method === 'PUT') {
      return await putUserPassword(req, user, deps, decodeURIComponent(userPasswordMatch[1]!).trim().toLowerCase());
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (err) {
    console.error('[admin-api] unexpected error:', err);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
