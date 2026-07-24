#!/usr/bin/env bun
// PreToolUse(Bash) guard. Blocks `git commit` when the staged change either
//   (a) contains a secret (any repo), or
//   (b) leaks internal names/paths into the PUBLIC core (origin SShadowS/DevOpsWorker).
// The customer-name blocklist lives in the gitignored overlay
// (private/internal-docs/leak-blocklist.txt) so THIS script — which is tracked in
// the public core — never carries a customer name. Exit 2 = block + reason to model.
// Hooks only gate the agent; a human can still commit from a terminal.

interface HookInput { tool_input?: { command?: string } }

const input: HookInput = await Bun.stdin.json().catch(() => ({}));
const cmd = input.tool_input?.command ?? "";

// Only gate commits.
if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) process.exit(0);

const proj = process.env.CLAUDE_PROJECT_DIR ?? ".";

// Which repo does this command target? (`git -C <dir> ...`, else cwd)
const cflag = cmd.match(/-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
const dir = cflag ? (cflag[1] ?? cflag[2] ?? cflag[3] ?? ".") : ".";

const git = (args: string[]): string =>
  Bun.spawnSync({ cmd: ["git", "-C", dir, ...args] }).stdout?.toString() ?? "";

// `commit -a`/`--all` stages tracked changes at commit time, so also scan the
// working-tree diff in that case; otherwise the index is the source of truth.
const usesAll = /\bcommit\b[^\n]*(\s-\w*a\b|\s--all\b)/.test(cmd);
const stagedDiff = git(["diff", "--cached"]);
const stagedNames = git(["diff", "--cached", "--name-only"]);
const scanDiff = stagedDiff + (usesAll ? "\n" + git(["diff"]) : "");
const scanNames = stagedNames + (usesAll ? "\n" + git(["diff", "--name-only"]) : "");

if (!scanDiff.trim()) process.exit(0); // nothing to inspect

const reasons: string[] = [];

// (a) Universal secret scan.
const SECRETS: [RegExp, string][] = [
  [/AZURE_DEVOPS_PAT\s*[:=]/i, "Azure DevOps PAT assignment"],
  [/ZENDESK_API_TOKEN\s*[:=]/i, "Zendesk API token"],
  [/CLAUDE_CODE_OAUTH_TOKEN\s*[:=]/i, "Claude OAuth token"],
  [/ANTHROPIC_API_KEY\s*[:=]/i, "Anthropic API key assignment"],
  [/sk-ant-api\d{2}-/, "Anthropic API key literal"],
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----/, "private key block"],
];
for (const [re, label] of SECRETS) if (re.test(scanDiff)) reasons.push(`secret: ${label}`);

// (b) Public-core-only leak scan.
const origin = git(["remote", "get-url", "origin"]).trim();
const isCore = /SShadowS\/DevOpsWorker(\.git)?$/i.test(origin);
if (isCore) {
  if (/(^|\n)docs\/superpowers\//.test(scanNames))
    reasons.push("path: docs/superpowers/ (internal, gitignored) staged to public core");

  const bl = Bun.file(`${proj}/private/internal-docs/leak-blocklist.txt`);
  if (await bl.exists()) {
    const hay = scanDiff + "\n" + scanNames;
    for (const raw of (await bl.text()).split(/\r?\n/)) {
      const pat = raw.trim();
      if (!pat || pat.startsWith("#")) continue;
      let hit = false;
      try { hit = new RegExp(pat, "i").test(hay); }
      catch { hit = hay.toLowerCase().includes(pat.toLowerCase()); }
      if (hit) reasons.push(`blocklist: /${pat}/ in a public-core commit`);
    }
  }
}

if (reasons.length) {
  console.error(
    "⛔ Commit blocked by guard-commit hook:\n- " + reasons.join("\n- ") +
    `\n\nTarget: ${origin || dir}${isCore ? " (PUBLIC CORE)" : ""}` +
    "\nInternal content belongs in the private overlay (private/). " +
    "If this is a false positive, commit from a terminal — hooks only gate the agent.",
  );
  process.exit(2);
}
process.exit(0);
