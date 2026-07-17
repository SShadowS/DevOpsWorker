// ---------------------------------------------------------------------------
// Bash-command guards for the coder agent — pure classifiers with nothing
// agent-specific about them. Each guard is a function of the command string
// alone, so it is independently unit-testable (see
// tests/agents/coder/bash-guard.test.ts). The SDK PreToolUse(Bash) hook
// wrappers that call these guards stay in config.ts, since wiring a plain
// function into the SDK's hook shape is agent-plumbing, not classification.
// ---------------------------------------------------------------------------

/**
 * Pure guard: decide whether a Bash command is a forbidden inline CI poll/trigger.
 * The coder must trigger via `--trigger-only` and delegate the WAIT to the ci-waiter
 * subagent; only the subagent may `--attach` (it carries the `--waiter` sentinel).
 * Prompting alone did not get the subagent used (the coder inline-polled anyway), so
 * this is enforced deterministically by a PreToolUse hook.
 */
export function ciWaiterGuard(command: string): { deny: false } | { deny: true; reason: string } {
  if (!command.includes('await-pipeline')) return { deny: false };
  if (command.includes('--attach') && !command.includes('--waiter')) {
    return {
      deny: true,
      reason:
        'Do NOT poll CI inline. Trigger with `await-pipeline.ts --branch <branch> --trigger-only` ' +
        '(it prints runId=<id> and exits), then delegate the wait to the ci-waiter subagent: ' +
        'Task(subagent_type: "ci-waiter", prompt with `await-pipeline.ts --attach <id> --timeout 100 --waiter`). ' +
        'The subagent does ALL --attach polling — you never run --attach yourself.',
    };
  }
  if (command.includes('--branch') && !command.includes('--trigger-only')) {
    return {
      deny: true,
      reason:
        'Do NOT trigger-and-wait inline. Use `await-pipeline.ts --branch <branch> --trigger-only` to ' +
        'trigger (it returns runId=<id> and exits 0), then hand that runId to the ci-waiter subagent via Task.',
    };
  }
  return { deny: false };
}

// ---------------------------------------------------------------------------
// File-operation guard — deny bash file-ops that have a dedicated tool.
//
// The coder's CLAUDE.md already tells it to use Glob/Grep/Read/jq/branch-diff
// instead of bash `ls`/`find`/`grep`/`cat`/`head`/`tail`/inline-python/`git diff
// master...`. Prompting alone failed (one real run made ~57 bash file-ops),
// burning expensive Sonnet context with noisy shell output. Same fix that got
// the ci-waiter subagent used: a deterministic PreToolUse(Bash) deny that feeds
// the exact replacement back to the model.
//
// Correctness hinges on PRIMARY-vs-PIPE: `cat file` (bash reading the repo) is
// denied, but `git log | cat` / `az ... | grep` (filtering another command's
// output — no dedicated-tool equivalent) is allowed. So we tokenize: split the
// command on top-level `&& || ; \n` (quote-aware), and within each segment look
// only at the FIRST pipe stage's primary command. Anything after a `|` is a
// filter and passes. Conservative: when unsure, ALLOW (a false deny wedges the
// agent in a retry loop, which is worse than missing one bash call).
// ---------------------------------------------------------------------------

/** Split a command line on top-level `&&`/`||`/`;`/newline, ignoring operators
 *  inside single/double quotes (so `git commit -m "a && b"` stays one segment). */
export function splitSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';') { segs.push(cur); cur = ''; continue; }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      segs.push(cur); cur = ''; i++; continue;
    }
    cur += c;
  }
  segs.push(cur);
  return segs.map(s => s.trim()).filter(Boolean);
}

/** Split a single segment into pipe stages on top-level `|` (quote-aware).
 *  `||` is already consumed at the segment level, so only single pipes remain. */
export function splitPipes(seg: string): string[] {
  const stages: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '|') { stages.push(cur); cur = ''; continue; }
    cur += c;
  }
  stages.push(cur);
  return stages.map(s => s.trim()).filter(Boolean);
}

/** First real command token of a pipe stage, stripping leading `VAR=val` env
 *  assignments and harmless prefixes (`sudo`/`command`/`time`/`nohup`). */
export function primaryToken(stage: string): { cmd: string; rest: string } {
  let s = stage.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  s = s.replace(/^(?:sudo|command|time|nohup)\s+/, '');
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return { cmd: m?.[1] ?? '', rest: m?.[2] ?? '' };
}

export const READ_UTILS = new Set(['cat', 'head', 'tail']);
export const GREP_UTILS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

/** Classify a single command token + its stage text. Returns a deny reason or null. */
export function classifyUtil(cmd: string, stage: string, cdWarn: string): string | null {
  if (cmd === 'ls') {
    return `Do not list files with bash \`ls\`. Use the Glob tool: Glob {pattern:"<dir>/*"}.${cdWarn}`;
  }
  if (READ_UTILS.has(cmd)) {
    return `Do not read files with bash \`${cmd}\`. Use the Read tool: Read {file_path:"<path>"}.${cdWarn}`;
  }
  if (GREP_UTILS.has(cmd)) {
    return `Do not text-search with bash \`${cmd}\`. Use the Grep tool: Grep {pattern:"...", path:"..."}. For AL code navigation prefer LSP.${cdWarn}`;
  }
  if (cmd === 'find') {
    // `find ... -exec/-delete/-ok` is an ACTION, not a search — allow it.
    if (/\s-(?:exec(?:dir)?|delete|ok)\b/.test(stage)) return null;
    return `Do not search files with bash \`find\`. Use the Glob tool: Glob {pattern:"**/*.al"}.${cdWarn}`;
  }
  if (cmd === 'python' || cmd === 'python3') {
    if (/\s-c\b/.test(stage) && /json/i.test(stage)) {
      return `Do not parse JSON with inline python. Use \`jq\` (e.g. jq -r '.application' app.json); for saved MCP result files use \`bun scripts/parse-mcp.ts <file>\`.`;
    }
    return null;
  }
  if (cmd === 'git' && /\bdiff\b/.test(stage) && /(?:master|main|origin\/\S+)\.\.\./.test(stage)) {
    return `Do not run \`git diff <ref>...\` — the shell mangles \`#\` in branch names. Use \`bun scripts/branch-diff.ts <branch>\` (handles the quoting and local-vs-origin).`;
  }
  return null;
}

/**
 * Pure guard: decide whether a Bash command is a file-op that should go through
 * a dedicated tool (Glob/Grep/Read/jq/branch-diff) instead. Denies only the
 * PRIMARY command of each `&&`/`||`/`;`-separated segment; post-pipe filters and
 * `find -exec/-delete` actions are allowed. Conservative — unknown shapes pass.
 */
export function fileOpGuard(command: string): { deny: false } | { deny: true; reason: string } {
  // ci-poll commands are owned by ciWaiterGuard — never touch them here.
  if (command.includes('await-pipeline')) return { deny: false };
  const cdWarn = /(?:^|\s|&&|;)\s*cd\s/.test(command)
    ? ' NOTE: the `cd` in this command did NOT execute — pass the full/correct path to the tool.'
    : '';

  for (const seg of splitSegments(command)) {
    const stages = splitPipes(seg);
    if (stages.length === 0) continue;

    // Primary = first stage's command.
    const first = primaryToken(stages[0]!);
    const reason = classifyUtil(first.cmd, stages[0]!, cdWarn);
    if (reason) return { deny: true, reason };

    // `... | xargs cat` / `... | xargs grep` reads files through xargs — treat the
    // util after xargs as primary (read-utils only; `xargs rm` etc. stay allowed).
    for (const stage of stages) {
      const p = primaryToken(stage);
      if (p.cmd !== 'xargs') continue;
      const x = primaryToken(p.rest);
      if (READ_UTILS.has(x.cmd) || GREP_UTILS.has(x.cmd) || x.cmd === 'ls') {
        const r = classifyUtil(x.cmd, x.cmd + ' ' + x.rest, cdWarn);
        if (r) return { deny: true, reason: r };
      }
    }
  }
  return { deny: false };
}
