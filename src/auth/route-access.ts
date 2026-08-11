/** Which role a route needs. Routes NOT listed here default to 'operator'
 *  (login required) — a new endpoint can never accidentally ship public.
 *  The public list is pinned by tests/auth/route-access.test.ts. */
export type Access = 'public' | 'operator' | 'admin';

export interface RouteRule {
  method: string;
  pattern: RegExp;
  access: Access;
}

export const routeRules: RouteRule[] = [
  // Unauthenticated: the login door and the static shell the SPA needs to
  // render the login page. These files contain no data.
  //
  // The login and status rows below are documentation, not enforcement:
  // src/dashboard/server.ts dispatches both endpoints ABOVE this table's
  // gate, before requiredAccess() is ever consulted. Editing either row
  // alone does not change what an unauthenticated request can reach — the
  // dispatch order in server.ts is what actually decides that. Also note
  // handleMe(user!) at that same call site assumes /api/auth/me is never
  // marked public here; if it ever is, that non-null assertion throws.
  { method: 'POST', pattern: /^\/api\/auth\/login$/, access: 'public' },
  { method: 'GET', pattern: /^\/api\/auth\/status$/, access: 'public' },
  { method: 'GET', pattern: /^\/(index\.html)?$/, access: 'public' },
  { method: 'GET', pattern: /^\/(bundle|index)\.js$/, access: 'public' },
  { method: 'GET', pattern: /^\/dashboard\.css$/, access: 'public' },

  // Admin-only global mutations.
  { method: 'POST', pattern: /^\/api\/runners$/, access: 'admin' },
];

/** `path` must already be normalised and free of a query string, and `method`
 *  must already be uppercase — this function does neither itself. */
export function requiredAccess(method: string, path: string): Access {
  for (const rule of routeRules) {
    if (rule.method === method && rule.pattern.test(path)) return rule.access;
  }
  return 'operator';
}
