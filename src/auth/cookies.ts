export const SESSION_COOKIE = 'dw_session';

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue; // no '=' or empty name
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function flags(secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Expires=${expiresAt.toUTCString()}; ${flags(secure)}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Expires=${new Date(0).toUTCString()}; ${flags(secure)}`;
}
