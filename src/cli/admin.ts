import type { Role } from '../auth/types.ts';

export interface AdminArgs {
  sub: 'create-user' | 'set-password' | 'list-users';
  email: string;
  role: Role;
  displayName: string;
  passwordStdin: boolean;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function isUniqueViolation(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

export function parseAdminArgs(args: string[]): AdminArgs {
  const sub = args[0];
  if (sub !== 'create-user' && sub !== 'set-password' && sub !== 'list-users') {
    throw new Error(`Unknown admin subcommand: ${sub ?? '(none)'}. Use create-user, set-password, or list-users.`);
  }
  let email = '';
  let role: Role = 'operator';
  let displayName = '';
  let passwordStdin = false;
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--email': email = requireValue('--email', args[++i]).trim().toLowerCase(); break;
      case '--role': {
        const r = requireValue('--role', args[++i]);
        if (r !== 'admin' && r !== 'operator') throw new Error('role must be admin or operator');
        role = r;
        break;
      }
      case '--display-name': displayName = requireValue('--display-name', args[++i]); break;
      case '--password-stdin': passwordStdin = true; break;
      default: throw new Error(`Unknown flag: ${args[i]}`);
    }
  }
  if (sub !== 'list-users' && !email) throw new Error('--email is required');
  if (!displayName) displayName = email;
  return { sub, email, role, displayName, passwordStdin };
}

async function readPassword(passwordStdin: boolean): Promise<string> {
  const password = passwordStdin
    ? (await Bun.stdin.text()).trim()
    : (prompt('Password (visible while typing):') ?? '');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  return password;
}

export async function admin(args: string[]): Promise<void> {
  const parsed = parseAdminArgs(args);
  const { connectStores } = await import('../db/connect-stores.ts');
  const { disconnectDatabase } = await import('../db/postgres.ts');
  const { userStore } = await connectStores();

  try {
    switch (parsed.sub) {
      case 'create-user': {
        const existing = await userStore.findByEmail(parsed.email);
        if (existing) throw new Error(`A user with email ${parsed.email} already exists`);
        const { hashPassword } = await import('../auth/local-provider.ts');
        const passwordHash = await hashPassword(await readPassword(parsed.passwordStdin));
        try {
          const user = await userStore.create({
            email: parsed.email,
            displayName: parsed.displayName,
            role: parsed.role,
            passwordHash,
          });
          console.log(`Created ${user.role} user ${user.email} (id ${user.id})`);
        } catch (err) {
          // Catch concurrent unique-violation (code 23505) and provide plain-English message
          if (isUniqueViolation(err)) {
            throw new Error(`A user with email ${parsed.email} already exists`);
          }
          throw err;
        }
        break;
      }
      case 'set-password': {
        const user = await userStore.findByEmail(parsed.email);
        if (!user) throw new Error(`No user with email ${parsed.email}`);
        const { hashPassword } = await import('../auth/local-provider.ts');
        await userStore.setPassword(user.id, await hashPassword(await readPassword(parsed.passwordStdin)));
        console.log(`Password updated for ${user.email}`);
        break;
      }
      case 'list-users': {
        const users = await userStore.list();
        if (users.length === 0) {
          console.log('No users yet. Create one with: pipeline admin create-user --email <you> --role admin');
          break;
        }
        for (const u of users) {
          console.log(`${u.email}  ${u.role}${u.disabled ? '  (disabled)' : ''}  ${u.displayName}`);
        }
        break;
      }
    }
  } finally {
    await disconnectDatabase();
  }
}
