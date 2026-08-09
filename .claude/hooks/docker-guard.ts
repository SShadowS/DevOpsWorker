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
//
// The split must not tear apart a quoted separator — a quoted regex alternation
// (`grep 'a\|docker compose b'`) contains a literal `|`; naively splitting on it
// promoted `docker compose b` to a leading token, blocking a read-only grep on
// 2026-08-09. But an UNBALANCED quote is the opposite danger: once a quote opens and
// never closes, every later separator is swallowed into one segment, its leading token
// is no longer `docker`, and the guard goes silent instead of catching a real `docker
// compose up`. The fallback below catches that (falls back to the naive split, which
// over-splits but never under-splits) whenever `quote` is left open — including a
// BACKSLASH-ESCAPED quote (`\'`, `\"`), which is unescaped below before it can toggle
// `quote` at all.
//
// KNOWN LIMIT, accepted rather than fixed: an EVEN number of stray quotes inside a `#`
// comment leaves `quote` balanced (closed) while still desynced from bash, so the
// fallback has nothing to detect. `# it's stale\ndocker compose up -d # don't forget`
// is exactly this shape — "it's" opens a phantom quote that "don't" closes two comments
// later, swallowing the real docker command in between. Fixing this needs comment
// awareness (tracking `#` to end-of-line), which is a shell parser this hook does not
// warrant. If this bites again, that is the edge to look at first (2026-08-09).
function splitSegments(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    // A backslash escapes the next character everywhere except inside single quotes,
    // where bash treats backslash as a plain character with no escaping power at all.
    // Consuming the pair together stops an escaped quote (`\'` unquoted, `\"` inside a
    // double-quoted string) from toggling `quote` when it shouldn't — two such stray
    // quotes previously left the scanner balanced (quote === null) while still desynced
    // from bash, which `if (quote)` below has nothing to catch (2026-08-09).
    if (c === '\\' && quote !== "'") { buf += c; if (i + 1 < s.length) buf += s[++i]; continue; }
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
  // An unbalanced quote means the state was wrong from the opening quote onward: every
  // separator after it was swallowed, so a real `docker compose up` can hide in a
  // non-leading position. Fall back to the naive split, which over-splits (the bug this
  // function fixes) but never under-splits. A guard may cry wolf; it may not go silent.
  if (quote) return s.split(/\n|;|&&|\|\||\|/);
  return out;
}
const segments = splitSegments(cmd);
// The `VAR=value` strip. `value` may itself contain a COMMAND SUBSTITUTION with
// spaces in it, so `\S*` is wrong: it stops at the first space, leaving
// `BUILD_SHA=$(git rev-parse --short HEAD) docker compose build` stripped down to
// the leading token `rev-parse --short HEAD) docker compose build`. `touchesDocker`
// then goes false and the hook exits 0 having run NO CHECK AT ALL — on a Windows
// daemon that command cannot succeed, which is the exact failure (a) exists to
// prevent. The same mangling made `alsoBuilds` false for a stamped
// `build && up -d`, arming the staleness check against a command that DOES build
// and printing, as its fix, the very command it had just blocked (2026-08-09).
// That command is the one this file's own message tells you to run.
//
// So a value is consumed in whole UNITS — a quoted string, or a `$(…)` group,
// spaces and all — before falling back to single non-space characters.
//
// The QUOTED branches are not decoration. Consuming `$(…)` alone fixed the
// stamped build but broke the opposite direction, because the strip then walked
// straight past a quote boundary:
//
//   CMD='BUILD_SHA=$(git rev-parse --short HEAD) docker compose build' bun -e …
//
// had `CMD='BUILD_SHA=$(…)` eaten, leaving `docker compose build' bun -e …` as
// the leading token — so a `bun` command was blocked as though it were a docker
// build. That is the obstructive false positive this file's header describes,
// and it fired on the second command written after the fix. The quoted branches
// consume the whole value, which also closes a fail-open BOTH earlier patterns
// had: `MSG="a b" docker compose build` used to leave `b" docker …` and go
// silent.
//
// THREE PROPERTIES OF THIS PATTERN, all measured, all easy to break by tidying it:
//
//  - The branches deliberately OVERLAP (`\S` matches a quote or a `$` too).
//    Making them disjoint (`\$(?!\()` plus `[^\s$]`) is the obvious cleanup and
//    it reintroduces a fail-open: on an UNTERMINATED `$(` or an unbalanced
//    quote, no specific branch matches, the strip consumes nothing, and
//    `A=$(oops docker compose up` goes silent. With the overlap, `\S` still eats
//    it and the guard fails toward checking.
//  - Order matters: quotes are tried before `\S` so a quoted value is taken
//    whole rather than one character at a time.
//  - The overlap costs backtracking: ~2 paths per unit when the tail cannot
//    match, measured at 0.8ms for 15 `$(…)` groups and 110ms for 22. Real
//    commands carry one or two, so this is charged against nothing — but do not
//    widen the alternation again without re-measuring it.
//
// Checked against 18 command shapes covering both directions (the strip must
// expose `docker` in 11 of them and must NOT in 7); this pattern is the first
// to get all 18, against 13 for the original and 15 for the `$(…)`-only fix.
const leading = segments.map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\$\([^)]*\)|\S)*\s+)*/, ''));
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
const upSegments = leading.filter((s) => /^docker\s+compose\b[^\n]*\bup\b/.test(s));
const alsoBuilds = leading.some((s) => /^docker\s+compose\b[^\n]*\bbuild\b/.test(s));
// Services actually BUILT from this repo (docker-compose.yml `build:` stanzas) —
// verified against the file, not assumed. `postgres` and `pg-backup` pull pre-built
// public images and carry no BUILD_SHA at all, so checking devopsworker-watcher's
// stamp against a bare-metal Postgres start is a category error. It blocked CLAUDE.md's
// own documented `docker compose up -d postgres` recipe ("PostgreSQL only, for local
// development") with a wrong answer. `up` with no service names starts everything,
// including the built-here services, so that case still needs the check.
const BUILT_HERE_SERVICES = new Set(["watcher", "dashboard", "webhook-server"]);
// Every service name docker-compose.yml defines. Hardcoded rather than parsed out of
// the YAML: a hand-rolled indentation scanner is its own source of silent misparsing
// (an `x-anchor:` block or a reformat could feed it garbage), and this hook already
// accepts that tradeoff for BUILT_HERE_SERVICES above — same file, same size, same
// change cadence. It goes stale the same way: add a compose service and forget this
// line, and an `up` naming only the new service silently skips the check. Keep both
// sets next to docker-compose.yml's own service list when that file changes.
const KNOWN_SERVICES = new Set([...BUILT_HERE_SERVICES, "postgres", "pg-backup"]);
// An unrecognised token is a flag's VALUE (`--timeout 60`, `--scale watcher=2`), a
// typo'd service name, or a service this list doesn't know about — none of which is
// evidence that nothing built here is starting, so it must fail toward checking
// (2026-08-09: a bare `!startsWith("-")` filter collected flag values as "services" and
// silenced the check under genuine staleness). Only skip when a segment names at least
// one service AND every name in it is one we positively know is not built here.
//
// Evaluated PER SEGMENT, not pooled across all of them: `up -d postgres ; up -d`
// starts everything in the second invocation, which names nothing at all. Merging every
// segment's names into one flat list before judging it loses that segment's "named
// nothing = starts everything" signal — the empty contribution just vanishes into the
// pool, so the compound command would read as "postgres only" and skip incorrectly.
// Requiring EVERY segment to individually qualify keeps that signal instead of losing it.
const targetsOnlyNonBuiltServices = upSegments.length > 0 && upSegments.every((seg) => {
  const names = seg.replace(/^.*?\bup\b/, "").trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
  return names.length > 0 && names.every((s) => KNOWN_SERVICES.has(s) && !BUILT_HERE_SERVICES.has(s));
});
if (upSegments.length > 0 && !alsoBuilds && !targetsOnlyNonBuiltServices) {
  const head = sh(["git", "-C", proj, "rev-parse", "--short", "HEAD"]);
  const env = sh([
    "docker", "image", "inspect", "devopsworker-watcher",
    "--format", "{{range .Config.Env}}{{println .}}{{end}}",
  ]);
  const built = env.match(/^BUILD_SHA=(.+)$/m)?.[1]?.trim();
  // A generic clone never exports BUILD_SHA and bakes the literal "unknown"; blocking
  // every `up` there would be hostile noise, so the staleness check below stays silent.
  // But a composed DEPLOYMENT gets NO protection at all: the check can only fire once
  // the sha is being set, so it protects only installations that already do the right
  // thing. Nudge those once, with the exact command, rather than staying silent and
  // unfalsifiable.
  //
  // `private/` existing (not `hasOverlayBuild` above) is the discriminator. The two
  // answer different questions: `hasOverlayBuild` is specifically about
  // private/deploy/docker-build.ps1, the script check (b) names in ITS fix message —
  // reusing it here would tie this nudge to one script's path rather than to "is this a
  // composed deployment at all", and go silent on any overlay layout that doesn't
  // happen to have that exact file yet. The core gitignores `private/` and
  // default-probes it at runtime, so its presence is the real signal.
  const isDeployment = existsSync(join(proj, "private"));
  if (isDeployment && head && built === "unknown") {
    reasons.push(
      `This deployment's compose images carry no build stamp, so nothing can tell whether\n` +
      `  the running service is current. \`compose up\` recreates from the EXISTING image —\n` +
      `  it does not rebuild — which is how a watcher sat two commits behind and silently\n` +
      `  could not see a tag it had just been taught (2026-08-03).\n` +
      `  Fix: BUILD_SHA=$(git rev-parse --short HEAD) docker compose build && docker compose up -d\n` +
      `  If running the old build is deliberate, run the command from a terminal.`,
    );
  }
  // Inert when the image does not exist yet (compose will build it). Also inert when
  // BUILD_SHA was never baked on a GENERIC CLONE (not a deployment) — blocking every
  // `up` there would be hostile noise. A composed deployment in the same unstamped
  // state is NOT silent: the nudge above already caught it.
  if (head && built && built !== "unknown") {
    // A plain `built !== head` comparison is a false positive on every commit that
    // doesn't touch the image — this task's own commit moved HEAD past the sha the
    // image was built at without changing a byte that goes into the image, and the
    // guard blocked anyway (2026-08-09). Gate on whether the paths the Dockerfile
    // actually bakes moved, not on HEAD identity. Path list verified against the
    // Dockerfile's COPY lines: package.json, bun.lock, src/, scripts/, tsconfig.json
    // (COPY ... at lines 48-52) and docker/claude-settings.json, docker/entrypoint.sh,
    // docker/fetch-al-extension.sh (COPY ... at lines 101-105) — plus the Dockerfile
    // itself, since changing the recipe is also a reason to rebuild, and .dockerignore,
    // since it's a build-context input too: it decides what COPY src/ actually sends
    // (currently excludes tests/, docs/, CLAUDE.md). NOT included: docker-compose.yml —
    // it isn't baked into the image, and this task's own commits change it, which would
    // re-light the exact false positive this gate exists to close.
    const IMAGE_INPUT_PATHS = ["src", "Dockerfile", "package.json", "bun.lock", "tsconfig.json", "scripts", "docker", ".dockerignore"];
    const diffProbe = Bun.spawnSync({
      cmd: ["git", "-C", proj, "diff", "--quiet", `${built}..HEAD`, "--", ...IMAGE_INPUT_PATHS],
    });
    // exit 0 = quiet = none of the paths the image actually bakes changed since `built`
    // — current regardless of HEAD identity. exit 1 = a real diff in those paths.
    // Anything else (128 = `built` unresolvable, e.g. after a history rewrite) can't be
    // verified either way — fail toward blocking, not silence, per this file's own rule.
    if (diffProbe.exitCode !== 0) {
      const why = diffProbe.exitCode === 1
        ? `HEAD (${head}) has since changed a path the image actually bakes`
        : `git could not diff ${built}..HEAD to check (that commit may no longer be reachable)`;
      reasons.push(
        `The compose service image may be stale: devopsworker-watcher was built at ${built}, and ${why}.\n` +
        `  \`compose up\` recreates from the EXISTING image — it does not rebuild. The service would\n` +
        `  keep running ${built} code with no error, which is how a watcher sat two commits behind\n` +
        `  and silently could not see a tag it had just been taught (2026-08-03).\n` +
        `  Fix: BUILD_SHA=$(git rev-parse --short HEAD) docker compose build && docker compose up -d\n` +
        `  If running the old build is deliberate, run the command from a terminal.`,
      );
    }
  }
}

if (reasons.length) {
  console.error("⛔ docker-guard hook blocked this command:\n\n- " + reasons.join("\n\n- "));
  process.exit(2);
}
process.exit(0);
