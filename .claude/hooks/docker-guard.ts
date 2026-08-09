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

import { existsSync } from "node:fs";
import { join } from "node:path";

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
// Split on shell separators, but NEVER inside quotes. A quoted regex alternation
// (`grep 'a\|docker compose b'`) contains a literal `|`; a naive split tore it apart
// and promoted `docker compose b` to a leading token, blocking a read-only grep on
// 2026-08-09. Backslash-escaping is not tracked: inside quotes nothing splits anyway,
// and outside quotes an escaped separator is not a separator we need to honour.
function splitSegments(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === '\n' || c === ';' || c === '|') {
      if (c === '|' && s[i + 1] === '|') i++;
      out.push(buf); buf = '';
      continue;
    }
    if (c === '&' && s[i + 1] === '&') { i++; out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
}
const segments = splitSegments(cmd);
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

// (c) Stale COMPOSE SERVICE images — the inverse of (b), and it bit on 2026-08-03.
//
// `docker compose up -d` recreates a container from the EXISTING image without
// rebuilding it, so a service can run code several commits old while every tag and
// container looks healthy. The deploy script only builds the SPAWNED image and ends
// with a printed reminder to run `docker compose build` — a reminder that was
// followed three times that day and missed the fourth, leaving the watcher two
// commits behind. The `continue` tag it had just gained was therefore undetectable,
// silently, which is the same class of failure this hook exists for.
//
// Services bake BUILD_SHA at image-build time, so the built image can be asked what
// it is. Checked only for `up` WITHOUT a build in the same command — `compose build
// && compose up -d` is the fix, and blocking the fix is how a guard gets bypassed.
const isComposeUp = leading.some((s) => /^docker\s+compose\b[^\n]*\bup\b/.test(s));
const alsoBuilds = leading.some((s) => /^docker\s+compose\b[^\n]*\bbuild\b/.test(s));
if (isComposeUp && !alsoBuilds) {
  const head = sh(["git", "-C", proj, "rev-parse", "--short", "HEAD"]);
  const env = sh([
    "docker", "image", "inspect", "devopsworker-watcher",
    "--format", "{{range .Config.Env}}{{println .}}{{end}}",
  ]);
  const built = env.match(/^BUILD_SHA=(.+)$/m)?.[1]?.trim();
  // A generic clone never exports BUILD_SHA and bakes the literal "unknown"; blocking
  // every `up` there would be hostile noise, so the staleness check below stays silent.
  // But a composed DEPLOYMENT (private/ present — the core gitignores it and probes it
  // at runtime) then gets NO protection at all: the check can only fire once the sha is
  // being set, so it protects only installations that already do the right thing. Nudge
  // those once, with the exact command, rather than staying silent and unfalsifiable.
  const isDeployment = existsSync(join(proj, "private"));
  if (isDeployment && head && built === "unknown") {
    reasons.push(
      `This deployment's compose images carry no build stamp, so nothing can tell whether\n` +
      `  the running service is current. \`compose up\` recreates from the EXISTING image —\n` +
      `  it does not rebuild — which is how a watcher sat two commits behind and silently\n` +
      `  could not see a tag it had just been taught (2026-08-03).\n` +
      `  Fix: BUILD_SHA=$(git rev-parse --short HEAD) docker compose build && docker compose up -d`,
    );
  }
  // Inert when the image does not exist yet (compose will build it), and when
  // BUILD_SHA was never baked — a generic clone that does not export it bakes the
  // literal "unknown", and blocking every `up` there would be hostile noise.
  if (head && built && built !== "unknown" && built !== head) {
    reasons.push(
      `The compose service image is stale: devopsworker-watcher was built at ${built}, HEAD is ${head}.\n` +
      `  \`compose up\` recreates from the EXISTING image — it does not rebuild. The service would\n` +
      `  keep running ${built} code with no error, which is how a watcher sat two commits behind\n` +
      `  and silently could not see a tag it had just been taught (2026-08-03).\n` +
      `  Fix: BUILD_SHA=$(git rev-parse --short HEAD) docker compose build && docker compose up -d\n` +
      `  If running the old build is deliberate, run the command from a terminal.`,
    );
  }
}

if (reasons.length) {
  console.error("⛔ docker-guard hook blocked this command:\n\n- " + reasons.join("\n\n- "));
  process.exit(2);
}
process.exit(0);
