import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { login } from '../auth-client.ts';

const email = signal('');
const password = signal('');
const error = signal<string | null>(null);
const busy = signal(false);
const usersExist = signal(true);

async function submit(e: Event) {
  e.preventDefault();
  busy.value = true;
  error.value = null;
  try {
    error.value = await login(email.value, password.value);
  } finally {
    busy.value = false;
  }
}

export function LoginPage() {
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((s: { usersExist: boolean }) => { usersExist.value = s.usersExist; })
      .catch(() => {});
  }, []);

  return (
    <div class="login-page">
      <form class="login-card" onSubmit={submit}>
        <h1>Pipeline Dashboard</h1>
        {!usersExist.value && (
          <p class="login-card__hint">
            No users yet. Create the first admin on the server:
            <code>bun run pipeline -- admin create-user --email you@example.com --role admin</code>
          </p>
        )}
        <label>
          Email
          <input
            type="email"
            autocomplete="username"
            value={email.value}
            onInput={(e) => { email.value = (e.target as HTMLInputElement).value; }}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autocomplete="current-password"
            value={password.value}
            onInput={(e) => { password.value = (e.target as HTMLInputElement).value; }}
            required
          />
        </label>
        {error.value && <p class="login-card__error">{error.value}</p>}
        <button type="submit" disabled={busy.value}>{busy.value ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
