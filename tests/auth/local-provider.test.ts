import { describe, test, expect } from 'bun:test';
import { hashPassword, verifyLocalLogin } from '../../src/auth/local-provider.ts';
import { FakeUserStore } from './fakes.ts';

describe('verifyLocalLogin', () => {
  test('accepts the right password, case-insensitive email', async () => {
    const users = new FakeUserStore();
    await users.create({ email: 'a@b.c', displayName: 'A', role: 'admin', passwordHash: await hashPassword('hunter2hunter2') });
    const user = await verifyLocalLogin(users, 'A@B.C', 'hunter2hunter2');
    expect(user?.role).toBe('admin');
    expect((user as unknown as Record<string, unknown>)?.['passwordHash']).toBeUndefined(); // hash never leaves
  });

  test('rejects wrong password, unknown email, disabled user, and password-less user', async () => {
    const users = new FakeUserStore();
    await users.create({ email: 'a@b.c', displayName: 'A', role: 'admin', passwordHash: await hashPassword('hunter2hunter2') });
    await users.create({ email: 'entra@b.c', displayName: 'E', role: 'operator', passwordHash: null });

    expect(await verifyLocalLogin(users, 'a@b.c', 'wrong-password')).toBeNull();
    expect(await verifyLocalLogin(users, 'nobody@b.c', 'hunter2hunter2')).toBeNull();
    expect(await verifyLocalLogin(users, 'entra@b.c', 'anything-at-all')).toBeNull();

    users.rows[0]!.disabled = true;
    expect(await verifyLocalLogin(users, 'a@b.c', 'hunter2hunter2')).toBeNull();
  });
});
