export type AuthEventKind = 'login-success' | 'login-failed' | 'login-locked-out' | 'logout';

export interface AuthEventRow {
  id: number;
  at: string;
  kind: AuthEventKind;
  email: string;
  ip: string | null;
  userId: number | null;
}

export interface IAuthEventStore {
  write(event: { kind: AuthEventKind; email: string; ip: string | null; userId?: number | null }): Promise<void>;
  list(limit: number): Promise<AuthEventRow[]>;
}
