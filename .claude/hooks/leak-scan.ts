#!/usr/bin/env bun
// PostToolUse(Write|Edit) leak scan for the PUBLIC core.
//
// guard-commit.ts runs the same blocklist at `git commit`. This hook runs it at WRITE
// time, because the gap between the two is where a leak actually gets built on: real
// closed-source product code once reached test fixtures here and survived nine reviews,
// caught only by a manual pre-commit sweep. Catching it at the edit means the fix is a
// one-line change, not a history rewrite (a July 2026 leak needed a force-push).
//
// The blocklist lives in the gitignored overlay (private/internal-docs/leak-blocklist.txt)
// so THIS file — tracked in the public core — never carries a customer name. No overlay
// (a generic clone) means nothing to scan: exit clean.
//
// Exit 2 surfaces the finding to the model. It cannot un-write the file — that is the
// point of following it up at commit time too. Skips anything under private/, which is
// the overlay and is allowed to name internal things.

interface HookInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    content?: string;      // Write
    new_string?: string;   // Edit
  };
}

const input: HookInput = await Bun.stdin.json().catch(() => ({}));
const file = input.tool_input?.file_path ?? "";
if (!file) process.exit(0);

// Content this call introduced. Edit gives only the replacement, which is exactly
// the newly-authored text — scanning the whole file would re-flag pre-existing hits
// on every unrelated edit.
const added = input.tool_input?.content ?? input.tool_input?.new_string ?? "";
if (!added.trim()) process.exit(0);

const norm = file.replace(/\\/g, "/");

// The overlay is private and may legitimately name internal things.
if (/\/private\//.test(norm) || /^private\//.test(norm)) process.exit(0);

// Resolve to an ABSOLUTE project dir. A bare "." fallback would make the
// containment test below reject every absolute path and silently disable the
// scan — the worst failure mode for a leak guard, since it looks identical to
// "nothing found".
const proj = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\\/g, "/");

// Only gate files inside this project (the public core). Relative paths are
// resolved against it, so they are in scope by construction.
if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
  if (!norm.toLowerCase().startsWith(proj.toLowerCase())) process.exit(0);
}

// Confirm this really is the public core before applying a public-core rule.
const origin = Bun.spawnSync({ cmd: ["git", "-C", proj, "remote", "get-url", "origin"] })
  .stdout?.toString().trim() ?? "";
if (!/SShadowS\/DevOpsWorker(\.git)?$/i.test(origin)) process.exit(0);

const bl = Bun.file(`${proj}/private/internal-docs/leak-blocklist.txt`);
if (!(await bl.exists())) process.exit(0); // generic clone, no overlay — nothing to check

const hay = added + "\n" + norm;
const hits: string[] = [];
for (const raw of (await bl.text()).split(/\r?\n/)) {
  const pat = raw.trim();
  if (!pat || pat.startsWith("#")) continue;
  let hit = false;
  try { hit = new RegExp(pat, "i").test(hay); }
  catch { hit = hay.toLowerCase().includes(pat.toLowerCase()); }
  if (hit) hits.push(pat);
}

if (hits.length) {
  console.error(
    `⛔ leak-scan: content just written to the PUBLIC core matches the internal blocklist.\n\n` +
    `File: ${norm}\n` +
    `Matched: ${hits.map((h) => `/${h}/`).join(", ")}\n\n` +
    `Fix now, before building on it:\n` +
    `- Real code/names for a test fixture? Replace with synthetic equivalents.\n` +
    `- Genuinely internal content? It belongs in the overlay (private/), not here.\n` +
    `- False positive? Continue — guard-commit re-checks at commit, and a human can ` +
    `commit from a terminal.`,
  );
  process.exit(2);
}
process.exit(0);
