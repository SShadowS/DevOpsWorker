#!/usr/bin/env bun
// PreToolUse(Bash) guard for the two Docker traps that fail SILENTLY or cryptically.
//
// (a) Wrong Docker context. Docker Desktop can sit in Windows-container mode, where
//     every Linux build dies on "no match for platform in manifest: not found" —
//     a message that names neither Docker Desktop nor the context. Deterministic:
//     if the context is wrong the command CANNOT succeed, so blocking loses nothing.
//
// (b) Stale spawned-container image. `docker run devopsworker:*` uses whatever was
//     last built. CLAUDE.md calls this "a common pitfall": compose services pick up
//     code changes while spawned containers run stale code, with NO error — just
//     side effects (like DB writes) that never happen. The deploy script tags
//     devopsworker:<short-sha>, so a missing tag for HEAD means the image predates it.
//
// Exit 2 = block + reason to the model. Hooks only gate the agent; a human can still
// run the command from a terminal.

interface HookInput { tool_input?: { command?: string } }

const input: HookInput = await Bun.stdin.json().catch(() => ({}));
const cmd = input.tool_input?.command ?? "";

// Only gate a command that is actually INVOKING docker.
//
// Matching the text anywhere is wrong and was actively obstructive: it fired on
// `git add deploy/docker-build.ps1`, on a `grep` whose pattern named the script, and
// on a commit message that merely described an image build — three times in one
// session, each blocking unrelated work. A guard that cries wolf gets bypassed, which
// costs more than the failure it prevents.
//
// So: split on shell separators, strip any leading `VAR=value` prefixes, and test only
// the LEADING token of each segment. `docker …` as an argument or inside prose is then
// invisible, while `docker run …` and `FOO=bar docker compose build` still match.
const segments = cmd.split(/\n|;|&&|\|\||\|/);
const leading = segments.map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, ''));
const touchesDocker =
  leading.some((s) => /^docker\s+(compose|build|run)\b/.test(s)) ||
  // The deploy script is a docker build by another name — but only when RUN, not when
  // merely named as a path to some other tool.
  leading.some((s) => /^(?:pwsh|powershell)\b[^\n]*\bdocker-build\.ps1/.test(s));
if (!touchesDocker) process.exit(0);

// Inspecting or switching the context is never something to block.
if (/\bdocker\s+context\s+(use|show|ls)\b/.test(cmd)) process.exit(0);

// Probe the SAME daemon the command will actually talk to.
//
// A `DOCKER_CONTEXT=... docker …` prefix lives in the command STRING, not in this
// hook's environment, so a probe spawned with the ambient env silently queries a
// different daemon than the command targets. On a Windows-default host that made the
// staleness check below unfalsifiable: it looked for a Linux image on the Windows
// daemon, never found one, and fired on every single `docker run` no matter how fresh
// the build. A guard that cannot pass is a guard people learn to route around.
const ctxInCmd = cmd.match(/DOCKER_CONTEXT\s*=\s*(\S+)/)?.[1];
const dockerEnv = ctxInCmd ? { ...process.env, DOCKER_CONTEXT: ctxInCmd } : process.env;

const proj = process.env.CLAUDE_PROJECT_DIR ?? ".";
const sh = (args: string[]): string =>
  Bun.spawnSync({ cmd: args, env: dockerEnv }).stdout?.toString().trim() ?? "";

const reasons: string[] = [];

// (a) Windows-container-mode check.
//
// Test the actual failure condition — the daemon serving WINDOWS containers — not the
// context NAME. Matching on `context show != desktop-linux` would block every command
// on a Linux host, where the context is legitimately `default`, with a message about
// Windows-container mode that is false there. `OSType` is what decides whether a
// linux/amd64 base image can be pulled at all.
// Probed under the effective context, so an explicit DOCKER_CONTEXT prefix resolves
// this check by making it pass rather than by waiving it.
{
  const osType = sh(["docker", "info", "--format", "{{.OSType}}"]);
  if (osType === "windows") {
    const ctx = sh(["docker", "context", "show"]);
    reasons.push(
      `The Docker daemon is serving WINDOWS containers (context "${ctx || "unknown"}"). ` +
      `Linux image builds fail against it with "no match for platform in manifest: not found".\n` +
      `  Fix: prefix the command with DOCKER_CONTEXT=desktop-linux (preferred — leaves the ` +
      `global default alone), or switch with: docker context use desktop-linux`,
    );
  }
}

// (b) Staleness check — only for RUNNING a spawned container, where stale code is silent.
// Building is how you fix staleness, so never block a build on it.
// The `devopsworker:<short-sha>` tag this check relies on is produced by the
// deployment overlay's build script. Without the overlay the tag never exists, so the
// check would block EVERY run and point at a script that isn't there — the hook must
// be inert in a generic clone, not hostile.
const isRun = /\bdocker\s+run\b/.test(cmd) && /devopsworker/.test(cmd);
const buildScript = "private/deploy/docker-build.ps1";
const hasOverlayBuild = await Bun.file(`${proj}/${buildScript}`).exists();
if (isRun && hasOverlayBuild) {
  const head = sh(["git", "-C", proj, "rev-parse", "--short", "HEAD"]);
  if (head) {
    const probe = Bun.spawnSync({
      cmd: ["docker", "image", "inspect", `devopsworker:${head}`],
      env: dockerEnv,
    });
    if (probe.exitCode !== 0) {
      reasons.push(
        `No devopsworker:${head} image — the spawned-container image predates HEAD (${head}).\n` +
        `  Stale images fail SILENTLY: the container runs old code with no error.\n` +
        `  Fix: pwsh ${buildScript} (tags :latest and :<short-sha>)\n` +
        `  If the staleness is deliberate, run the command from a terminal.`,
      );
    }
  }
}

if (reasons.length) {
  console.error("⛔ docker-guard hook blocked this command:\n\n- " + reasons.join("\n\n- "));
  process.exit(2);
}
process.exit(0);
