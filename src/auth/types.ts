export type Role = 'admin' | 'operator';

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
}
