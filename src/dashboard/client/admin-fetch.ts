/**
 * The one way admin screens call the admin API (`src/dashboard/admin-api.ts`).
 * Every other call site in this client does its own bare `fetch` with its own
 * try/catch (or none) — see `sse.ts`, `actions.ts`, `auth-client.ts`. This
 * plan adds roughly eight new admin call sites, so they share one helper
 * instead of eight improvisations. Existing call sites are deliberately left
 * alone; retrofitting them is a separate piece of work.
 *
 * Handles the two things a caller must not get wrong:
 *   - 401: the session is gone — drop to the login page. `pollRunners`
 *     (sse.ts) is the only other place in this client that already does
 *     this; it reaches `currentUser` via a dynamic `import('./store.ts')` to
 *     dodge a circular import, and this follows the same trick rather than a
 *     static import at the top of this file.
 *   - 403: authenticated, but the wrong role. This is NOT the same situation
 *     as 401 — the user is genuinely logged in — so it must not log them
 *     out. It gets its own distinct message instead.
 *
 * Convention (decided for this plan — do not relitigate): the admin API
 * reports validation failures as a flat `{errors:[{path,message}]}` array
 * with no per-field key, so screens render that array as a LIST of
 * "path — message" lines under the form's submit button rather than
 * attempting per-field annotations, which would be guesswork the moment a
 * schema nests differently. This helper's job stops at handing back that
 * array in a shape a component can render directly; the rendering itself
 * belongs to the screens that use it.
 */

/** One issue from the admin API's validation error shape. `path` is
 *  dot-joined by the server, and is the literal string "(root)" for a
 *  root-level issue — see `issuesToFieldErrors` in admin-api.ts. */
export interface AdminFieldError {
  path: string;
  message: string;
}

export type AdminFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; errors: AdminFieldError[] };

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Log in again.';
const ADMIN_ONLY_MESSAGE = 'This action requires an administrator role.';

export async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<AdminFetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}`, errors: [] };
  }

  if (res.status === 401) {
    const { currentUser } = await import('./store.ts');
    currentUser.value = null;
    return { ok: false, message: SESSION_EXPIRED_MESSAGE, errors: [] };
  }

  if (res.status === 403) {
    return { ok: false, message: ADMIN_ONLY_MESSAGE, errors: [] };
  }

  if (res.ok) {
    return { ok: true, data: (await res.json()) as T };
  }

  return { ok: false, ...(await parseErrorBody(res)) };
}

async function parseErrorBody(res: Response): Promise<{ message: string; errors: AdminFieldError[] }> {
  const fallback = `Request failed (${res.status})`;
  const text = await res.text().catch(() => '');
  if (!text) return { message: fallback, errors: [] };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { message: fallback, errors: [] };
  }

  if (body !== null && typeof body === 'object') {
    const { error, errors } = body as { error?: unknown; errors?: unknown };
    if (Array.isArray(errors)) {
      return { message: 'Fix the errors below and try again.', errors: errors as AdminFieldError[] };
    }
    if (typeof error === 'string') {
      return { message: error, errors: [] };
    }
  }
  return { message: fallback, errors: [] };
}
