import { describe, test, expect } from 'bun:test';
import { parseAdminArgs } from '../../src/cli/admin.ts';

describe('parseAdminArgs', () => {
  test('parses create-user flags', () => {
    expect(parseAdminArgs(['create-user', '--email', 'A@B.c', '--role', 'admin', '--display-name', 'Ann Example', '--password-stdin']))
      .toEqual({ sub: 'create-user', email: 'a@b.c', role: 'admin', displayName: 'Ann Example', passwordStdin: true });
  });
  test('defaults: role operator, displayName from email, no stdin', () => {
    expect(parseAdminArgs(['create-user', '--email', 'a@b.c']))
      .toEqual({ sub: 'create-user', email: 'a@b.c', role: 'operator', displayName: 'a@b.c', passwordStdin: false });
  });
  test('rejects bad role and missing email', () => {
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--role', 'root'])).toThrow('role must be admin or operator');
    expect(() => parseAdminArgs(['create-user'])).toThrow('--email is required');
    expect(() => parseAdminArgs(['set-password'])).toThrow('--email is required');
  });
  test('list-users needs nothing', () => {
    expect(parseAdminArgs(['list-users'])).toEqual({ sub: 'list-users', email: '', role: 'operator', displayName: '', passwordStdin: false });
  });
  test('unknown subcommand throws', () => {
    expect(() => parseAdminArgs(['frobnicate'])).toThrow('Unknown admin subcommand');
  });
  test('rejects flag-shaped values', () => {
    // --email with flag-shaped value
    expect(() => parseAdminArgs(['create-user', '--email', '--password-stdin', '--role', 'admin']))
      .toThrow('--email requires a value');
    // --role with flag-shaped value
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--role', '--display-name']))
      .toThrow('--role requires a value');
    // --display-name with flag-shaped value
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--display-name', '--role']))
      .toThrow('--display-name requires a value');
  });
  test('rejects missing flag values', () => {
    // --email at end
    expect(() => parseAdminArgs(['create-user', '--email']))
      .toThrow('--email requires a value');
    // --role at end
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--role']))
      .toThrow('--role requires a value');
    // --display-name at end
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--display-name']))
      .toThrow('--display-name requires a value');
  });
  test('rejects unknown flags', () => {
    expect(() => parseAdminArgs(['create-user', '--email', 'a@b.c', '--unknown-flag']))
      .toThrow('Unknown flag: --unknown-flag');
  });
});
