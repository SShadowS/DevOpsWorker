import { describe, test, expect } from 'bun:test';
import {
  ciWaiterGuard,
  fileOpGuard,
  splitSegments,
  splitPipes,
  primaryToken,
  classifyUtil,
  READ_UTILS,
  GREP_UTILS,
} from '../../../src/agents/coder/bash-guard.ts';

// ---------------------------------------------------------------------------
// bash-guard — pure Bash-command classifiers used by the coder's
// PreToolUse(Bash) hooks. No agent-specific state: everything here is a
// function of the command string alone.
//
// fileOpGuard/ciWaiterGuard were originally exported from config.ts and
// covered there; this file was written FIRST against those config.ts exports
// (confirmed green — see task-9-report.md), THEN the functions were moved
// into bash-guard.ts and this import re-pointed here, proving the move
// preserved behavior exactly.
// ---------------------------------------------------------------------------

describe('ciWaiterGuard (inline CI-poll guard)', () => {
  test('denies inline --attach without the --waiter sentinel', () => {
    const v = ciWaiterGuard('bun scripts/await-pipeline.ts --attach 691974 --timeout 100');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('ci-waiter');
  });

  test('allows --attach that carries the --waiter sentinel (the subagent)', () => {
    expect(ciWaiterGuard('bun /app/scripts/await-pipeline.ts --attach 691974 --timeout 100 --waiter').deny).toBe(false);
  });

  test('denies --branch without --trigger-only (inline trigger-and-wait)', () => {
    const v = ciWaiterGuard("bun scripts/await-pipeline.ts --branch 'bug/#1-x'");
    expect(v.deny).toBe(true);
  });

  test('allows --branch --trigger-only (the sanctioned trigger)', () => {
    expect(ciWaiterGuard("bun scripts/await-pipeline.ts --branch 'bug/#1-x' --trigger-only").deny).toBe(false);
  });

  test('ignores unrelated Bash commands', () => {
    expect(ciWaiterGuard('git commit -m x').deny).toBe(false);
    expect(ciWaiterGuard('bun scripts/parse-mcp.ts file errors').deny).toBe(false);
  });
});

describe('fileOpGuard (bash file-op redirect guard)', () => {
  // --- primary command denies (bash reading/searching the repo) ---
  test('denies primary `ls`', () => {
    const v = fileOpGuard('ls Cloud/AL');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('Glob');
  });

  test('denies bare `ls` with no trailing space', () => {
    expect(fileOpGuard('ls').deny).toBe(true);
  });

  test('denies primary `cat`/`head`/`tail` → Read', () => {
    for (const u of ['cat app.json', 'head -5 file.al', 'tail -n 20 log.txt']) {
      const v = fileOpGuard(u);
      expect(v.deny).toBe(true);
      if (v.deny) expect(v.reason).toContain('Read');
    }
  });

  test('denies primary `grep`/`rg`/`egrep` → Grep', () => {
    for (const u of ['grep -r foo Cloud', 'rg pattern src', 'egrep x file']) {
      const v = fileOpGuard(u);
      expect(v.deny).toBe(true);
      if (v.deny) expect(v.reason).toContain('Grep');
    }
  });

  test('denies `grep` with input redirect (still reading a file)', () => {
    expect(fileOpGuard('grep needle < data.txt').deny).toBe(true);
  });

  // --- find: search denied, action allowed ---
  test('denies `find -name` search → Glob', () => {
    const v = fileOpGuard("find . -name '*.al'");
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('Glob');
  });

  test('allows `find -exec`/`-delete` (action, not search)', () => {
    expect(fileOpGuard("find . -name '*.tmp' -delete").deny).toBe(false);
    expect(fileOpGuard("find . -name '*.al' -exec wc -l {} ;").deny).toBe(false);
  });

  // --- inline python json ---
  test('denies inline python reading JSON → jq', () => {
    const v = fileOpGuard('python3 -c "import json,sys;print(json.load(open(\'app.json\')))"');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('jq');
  });

  test('allows python without -c / without json', () => {
    expect(fileOpGuard('python3 scripts/build.py').deny).toBe(false);
  });

  // --- git diff helper ---
  test('denies `git diff master...` → branch-diff helper', () => {
    const v = fileOpGuard('git diff master...userstory/#73961-x');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('branch-diff');
  });

  test('allows ordinary `git diff` (no triple-dot ref)', () => {
    expect(fileOpGuard('git diff --stat').deny).toBe(false);
  });

  test('allows a normal git/build command', () => {
    expect(fileOpGuard('git commit -m "implement feature"').deny).toBe(false);
    expect(fileOpGuard('git push origin userstory/#1-x').deny).toBe(false);
  });

  // --- PRIMARY-vs-PIPE: filters after `|` are allowed ---
  test('allows read-utils AFTER a pipe (filtering command output)', () => {
    expect(fileOpGuard('git log --oneline | head -20').deny).toBe(false);
    expect(fileOpGuard('az pipelines list | grep CI').deny).toBe(false);
    expect(fileOpGuard('git status | cat').deny).toBe(false);
  });

  test('allows `git log | grep x` (grep is a pipe filter, not the primary command)', () => {
    expect(fileOpGuard('git log | grep x').deny).toBe(false);
  });

  // --- chain handling: cd && cat, env prefixes ---
  test('denies `cat` even when preceded by `cd &&`, and warns about lost cd', () => {
    const v = fileOpGuard('cd DocumentOutput/Cloud && cat app.json');
    expect(v.deny).toBe(true);
    if (v.deny) {
      expect(v.reason).toContain('Read');
      expect(v.reason).toContain('cd');
    }
  });

  test('denies `grep` behind an env-var prefix', () => {
    expect(fileOpGuard('LC_ALL=C grep -r foo src').deny).toBe(true);
  });

  test('denies a file-op in any segment of a `;` chain', () => {
    expect(fileOpGuard('git fetch ; cat README.md').deny).toBe(true);
  });

  // --- xargs pass-through ---
  test('denies `xargs cat` / `xargs grep`', () => {
    expect(fileOpGuard('git ls-files | xargs grep TODO').deny).toBe(true);
    expect(fileOpGuard('cat list | xargs cat').deny).toBe(true);
  });

  test('allows `xargs rm` (not a read-util)', () => {
    expect(fileOpGuard('echo x | xargs rm').deny).toBe(false);
  });

  // --- quote-awareness: operators inside strings must NOT split ---
  test('does not split on quoted operators', () => {
    expect(fileOpGuard('git commit -m "fix; cat and grep stuff"').deny).toBe(false);
    expect(fileOpGuard('git commit -m "a && b"').deny).toBe(false);
  });

  test('allows util name appearing only inside an echo string', () => {
    expect(fileOpGuard('echo "use cat or grep here"').deny).toBe(false);
  });

  // --- never touches ci-poll commands (ciWaiterGuard owns them) ---
  test('ignores await-pipeline commands entirely', () => {
    expect(fileOpGuard('bun scripts/await-pipeline.ts --attach 1 --waiter').deny).toBe(false);
  });

  // --- unrelated commands pass ---
  test('allows unrelated bash (git/bun/az/jq)', () => {
    for (const c of ['git commit -m x', 'bun scripts/parse-mcp.ts f errors', 'jq -r .application app.json', 'az pipelines run --id 973']) {
      expect(fileOpGuard(c).deny).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Internal parsing helpers — exported from bash-guard.ts specifically so they
// can be exercised directly (previously only reachable indirectly through
// fileOpGuard's integration-style tests above).
// ---------------------------------------------------------------------------

describe('splitSegments', () => {
  test('splits on top-level `&&`', () => {
    expect(splitSegments('git add . && git commit -m x')).toEqual(['git add .', 'git commit -m x']);
  });

  test('splits on top-level `||`', () => {
    expect(splitSegments('cmd1 || cmd2')).toEqual(['cmd1', 'cmd2']);
  });

  test('splits on top-level `;`', () => {
    expect(splitSegments('cmd1; cmd2; cmd3')).toEqual(['cmd1', 'cmd2', 'cmd3']);
  });

  test('splits on newline', () => {
    expect(splitSegments('cmd1\ncmd2')).toEqual(['cmd1', 'cmd2']);
  });

  test('does not split on `&&`/`;` inside single or double quotes', () => {
    expect(splitSegments('git commit -m "a && b; c"')).toEqual(['git commit -m "a && b; c"']);
    expect(splitSegments("git commit -m 'a && b; c'")).toEqual(["git commit -m 'a && b; c'"]);
  });

  test('trims whitespace and drops empty segments', () => {
    expect(splitSegments('  cmd1  ;  ; cmd2  ')).toEqual(['cmd1', 'cmd2']);
  });
});

describe('splitPipes', () => {
  test('splits a segment on top-level `|`', () => {
    expect(splitPipes('git log | grep x | head -5')).toEqual(['git log', 'grep x', 'head -5']);
  });

  test('does not split on `|` inside quotes', () => {
    expect(splitPipes('echo "a|b"')).toEqual(['echo "a|b"']);
  });

  test('single stage when there is no pipe', () => {
    expect(splitPipes('cat foo.al')).toEqual(['cat foo.al']);
  });
});

describe('primaryToken', () => {
  test('strips a single env-var prefix', () => {
    expect(primaryToken('FOO=bar cat x')).toEqual({ cmd: 'cat', rest: 'x' });
  });

  test('strips multiple chained env-var prefixes', () => {
    expect(primaryToken('FOO=bar BAZ=qux cat x')).toEqual({ cmd: 'cat', rest: 'x' });
  });

  test('strips harmless prefixes (sudo/command/time/nohup)', () => {
    expect(primaryToken('sudo rm -rf /tmp/x')).toEqual({ cmd: 'rm', rest: '-rf /tmp/x' });
    expect(primaryToken('time git status')).toEqual({ cmd: 'git', rest: 'status' });
  });

  test('plain command with no prefix', () => {
    expect(primaryToken('ls -la')).toEqual({ cmd: 'ls', rest: '-la' });
  });

  test('leading `cd` is treated as an ordinary command token', () => {
    // fileOpGuard relies on `cd` classifying as a no-op (not a read-util), not on
    // primaryToken special-casing it — cd handling lives in fileOpGuard's cdWarn.
    expect(primaryToken('cd some/dir')).toEqual({ cmd: 'cd', rest: 'some/dir' });
  });

  test('command with no arguments has empty rest', () => {
    expect(primaryToken('ls')).toEqual({ cmd: 'ls', rest: '' });
  });
});

describe('classifyUtil + READ_UTILS/GREP_UTILS', () => {
  test('READ_UTILS contains exactly cat/head/tail', () => {
    expect(READ_UTILS).toEqual(new Set(['cat', 'head', 'tail']));
  });

  test('GREP_UTILS contains exactly grep/egrep/fgrep/rg', () => {
    expect(GREP_UTILS).toEqual(new Set(['grep', 'egrep', 'fgrep', 'rg']));
  });

  test('classifies a read-util with a deny reason mentioning Read', () => {
    const reason = classifyUtil('cat', 'cat foo.al', '');
    expect(reason).toContain('Read');
  });

  test('classifies an unknown command as null (no deny)', () => {
    expect(classifyUtil('git', 'git status', '')).toBeNull();
  });

  test('appends the cdWarn suffix verbatim when provided', () => {
    const reason = classifyUtil('ls', 'ls', ' NOTE: cd lost.');
    expect(reason).toContain('NOTE: cd lost.');
  });
});
