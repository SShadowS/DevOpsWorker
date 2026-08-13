import { describe, test, expect } from 'bun:test';
import {
  emptyCreateUserFormState,
  buildCreateUserPayload,
  listUserRows,
  countActiveAdmins,
  getRoleGuardReason,
  getDisableGuardReason,
  buildPasswordResetWarning,
  MIN_PASSWORD_LENGTH,
  reduceUserPanel,
} from '../../src/dashboard/client/components/admin-users.tsx';
import type { CreateUserFormState, UserPanel } from '../../src/dashboard/client/components/admin-users.tsx';
import type { AuthUser } from '../../src/auth/types.ts';

// No test in this file opens a database connection or renders a component
// tree (repo convention — see tests/dashboard/admin-repos.test.ts). Every
// function under test is pure: given data, it returns a value.

function mkUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 1,
    email: 'fake-user@example.invalid',
    displayName: 'Fake User',
    role: 'operator',
    disabled: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// emptyCreateUserFormState / buildCreateUserPayload
// ---------------------------------------------------------------------------

describe('emptyCreateUserFormState', () => {
  test('defaults to the operator role and empty text fields', () => {
    const f = emptyCreateUserFormState();
    expect(f.email).toBe('');
    expect(f.displayName).toBe('');
    expect(f.role).toBe('operator');
    expect(f.password).toBe('');
  });
});

function fixtureForm(overrides: Partial<CreateUserFormState> = {}): CreateUserFormState {
  return {
    email: 'someone@example.invalid',
    displayName: 'Someone',
    role: 'operator',
    password: 'a-fake-password-1',
    ...overrides,
  };
}

describe('buildCreateUserPayload', () => {
  test('a valid form builds a payload with every field trimmed', () => {
    const result = buildCreateUserPayload(fixtureForm({ email: '  someone@example.invalid  ', displayName: '  Someone  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.email).toBe('someone@example.invalid');
      expect(result.payload.displayName).toBe('Someone');
      expect(result.payload.role).toBe('operator');
      expect(result.payload.password).toBe('a-fake-password-1');
    }
  });

  test('a blank email is rejected against the "email" path, not sent to the server', () => {
    const result = buildCreateUserPayload(fixtureForm({ email: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ path: 'email', message: 'An email address is required.' });
    }
  });

  test(`a password shorter than ${MIN_PASSWORD_LENGTH} characters is rejected against the "password" path`, () => {
    const result = buildCreateUserPayload(fixtureForm({ password: 'short' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({ path: 'password', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
  });

  test('a blank email AND a short password are both reported, not just the first one found', () => {
    const result = buildCreateUserPayload(fixtureForm({ email: '', password: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path).sort();
      expect(paths).toEqual(['email', 'password']);
    }
  });
});

// ---------------------------------------------------------------------------
// listUserRows
// ---------------------------------------------------------------------------

describe('listUserRows', () => {
  test('sorts by email so the table order is stable regardless of the array order the server returned', () => {
    const rows = listUserRows([
      mkUser({ email: 'zeta@example.invalid' }),
      mkUser({ email: 'alpha@example.invalid' }),
      mkUser({ email: 'mid@example.invalid' }),
    ]);
    expect(rows.map((r) => r.email)).toEqual(['alpha@example.invalid', 'mid@example.invalid', 'zeta@example.invalid']);
  });

  test('an empty list yields an empty list, not an error', () => {
    expect(listUserRows([])).toEqual([]);
  });

  test('does not mutate the array it was given', () => {
    const original = [mkUser({ email: 'b@example.invalid' }), mkUser({ email: 'a@example.invalid' })];
    const copy = [...original];
    listUserRows(original);
    expect(original).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// countActiveAdmins
// ---------------------------------------------------------------------------

describe('countActiveAdmins', () => {
  test('counts only admins that are not disabled', () => {
    const users = [
      mkUser({ email: 'a1@example.invalid', role: 'admin', disabled: false }),
      mkUser({ email: 'a2@example.invalid', role: 'admin', disabled: true }),
      mkUser({ email: 'op@example.invalid', role: 'operator', disabled: false }),
    ];
    expect(countActiveAdmins(users)).toBe(1);
  });

  test('an empty or all-operator list counts zero', () => {
    expect(countActiveAdmins([])).toBe(0);
    expect(countActiveAdmins([mkUser({ role: 'operator' })])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRoleGuardReason — mirrors putUserRole's two demotion guardrails
// ---------------------------------------------------------------------------

describe('getRoleGuardReason', () => {
  test('an operator row is never guarded — promotion has no guardrail', () => {
    const operator = mkUser({ role: 'operator', email: 'op@example.invalid' });
    expect(getRoleGuardReason(operator, 'op@example.invalid', 1)).toBeNull();
    expect(getRoleGuardReason(operator, 'someone-else@example.invalid', 0)).toBeNull();
  });

  test('an admin cannot remove their own admin role, regardless of how many other admins exist', () => {
    const self = mkUser({ role: 'admin', email: 'self@example.invalid', disabled: false });
    expect(getRoleGuardReason(self, 'self@example.invalid', 5)).toBe('You cannot remove your own admin role.');
  });

  test('the last remaining active admin cannot be demoted by someone else', () => {
    const lastAdmin = mkUser({ role: 'admin', email: 'last@example.invalid', disabled: false });
    expect(getRoleGuardReason(lastAdmin, 'other@example.invalid', 1)).toBe(
      'This is the last remaining admin. Promote another admin before removing this one.',
    );
  });

  test('an admin can be demoted when another active admin exists', () => {
    const admin = mkUser({ role: 'admin', email: 'demotable@example.invalid', disabled: false });
    expect(getRoleGuardReason(admin, 'other@example.invalid', 2)).toBeNull();
  });

  test('a disabled admin is not guarded by the "last remaining" rule — an inactive admin never counted toward it', () => {
    const disabledAdmin = mkUser({ role: 'admin', email: 'disabled-admin@example.invalid', disabled: true });
    expect(getRoleGuardReason(disabledAdmin, 'other@example.invalid', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDisableGuardReason — mirrors putUserDisabled's two guardrails
// ---------------------------------------------------------------------------

describe('getDisableGuardReason', () => {
  test('re-enabling a disabled account is never guarded', () => {
    const disabled = mkUser({ disabled: true, role: 'admin', email: 'self@example.invalid' });
    expect(getDisableGuardReason(disabled, 'self@example.invalid', 0)).toBeNull();
  });

  test('an admin cannot disable their own account', () => {
    const self = mkUser({ role: 'admin', email: 'self@example.invalid', disabled: false });
    expect(getDisableGuardReason(self, 'self@example.invalid', 5)).toBe('You cannot disable your own account.');
  });

  test('the last remaining active admin cannot be disabled by someone else', () => {
    const lastAdmin = mkUser({ role: 'admin', email: 'last@example.invalid', disabled: false });
    expect(getDisableGuardReason(lastAdmin, 'other@example.invalid', 1)).toBe(
      'This is the last remaining admin. Promote another admin before disabling this one.',
    );
  });

  test('an operator row is never guarded by the last-admin rule', () => {
    const operator = mkUser({ role: 'operator', email: 'op@example.invalid', disabled: false });
    expect(getDisableGuardReason(operator, 'other@example.invalid', 0)).toBeNull();
  });

  test('an admin can be disabled when another active admin exists', () => {
    const admin = mkUser({ role: 'admin', email: 'disableable@example.invalid', disabled: false });
    expect(getDisableGuardReason(admin, 'other@example.invalid', 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPasswordResetWarning
// ---------------------------------------------------------------------------

describe('buildPasswordResetWarning', () => {
  test('names the person and states the session-revocation consequence plainly', () => {
    const text = buildPasswordResetWarning(mkUser({ displayName: 'Fake Person' }));
    expect(text).toContain('Fake Person');
    expect(text).toContain('signs');
    expect(text.toLowerCase()).toContain('every device');
  });
});

// ---------------------------------------------------------------------------
// reduceUserPanel — the single source of truth for which secondary panel
// (the create-user form, or a row's password-reset form) is open. Mirrors
// admin-repos.test.ts's reduceRepoPanel coverage for the same reason: this
// screen was modelled on that one and inherited the same gap — opening the
// create form never cleared a pending password-reset panel for a different
// user, and vice versa. Each test asserts the fix's actual guarantee, that
// opening any panel leaves no trace of whichever one was open before.
// ---------------------------------------------------------------------------

describe('reduceUserPanel', () => {
  const priorPanels: UserPanel[] = [
    { kind: 'closed' },
    { kind: 'create' },
    { kind: 'passwordReset', email: 'a@example.invalid' },
  ];

  test('opening the create form closes whatever was open before, regardless of what it was', () => {
    for (const prior of priorPanels) {
      expect(reduceUserPanel(prior, { type: 'openCreate' })).toEqual({ kind: 'create' });
    }
  });

  test('opening a password-reset panel for one user closes a password-reset panel open for another', () => {
    const resettingA: UserPanel = { kind: 'passwordReset', email: 'a@example.invalid' };
    const next = reduceUserPanel(resettingA, { type: 'openPasswordReset', email: 'b@example.invalid' });
    expect(next).toEqual({ kind: 'passwordReset', email: 'b@example.invalid' });
  });

  test('opening a password-reset panel closes the create-user form', () => {
    const next = reduceUserPanel({ kind: 'create' }, { type: 'openPasswordReset', email: 'a@example.invalid' });
    expect(next).toEqual({ kind: 'passwordReset', email: 'a@example.invalid' });
  });

  test('close always returns to closed, regardless of what was open', () => {
    for (const prior of priorPanels) {
      expect(reduceUserPanel(prior, { type: 'close' })).toEqual({ kind: 'closed' });
    }
  });
});
