/**
 * Run a git command in `cwd`, capturing output and never throwing.
 *
 * `Bun.spawn` throws SYNCHRONOUSLY — not as a rejected promise — when the
 * executable cannot be found at all (e.g. `git` missing from PATH). That is
 * exactly the kind of failure the callers here promise never to surface as an
 * exception, so the whole spawn+wait sequence is wrapped rather than just awaited.
 *
 * `out` and `err` are returned RAW. Trimming here would be wrong for the one
 * caller that matters: `git diff` output is the payload, and `git diff --name-only
 * -z` is NUL-separated, so a helpful `.trim()` would silently corrupt both.
 * Callers that want a token (a sha) trim at the point of use.
 */
export interface GitRunResult {
  code: number;
  out: string;
  err: string;
}

export async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code: await p.exited, out, err };
  } catch (e) {
    return { code: -1, out: '', err: e instanceof Error ? e.message : String(e) };
  }
}
