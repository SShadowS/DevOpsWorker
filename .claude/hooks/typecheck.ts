#!/usr/bin/env bun
// Stop hook. When the turn touched any .ts/.tsx file, run `bun run typecheck`
// (strict tsc is this project's only code gate — no linter/formatter) and block
// turn-end on type errors so they surface immediately instead of at CI.
// Guards against loops via stop_hook_active. Typecheck here is ~0.4s.

interface HookInput { stop_hook_active?: boolean }

const input: HookInput = await Bun.stdin.json().catch(() => ({}));
if (input.stop_hook_active) process.exit(0); // already re-entered once; don't loop

const proj = process.env.CLAUDE_PROJECT_DIR ?? ".";

const status = Bun.spawnSync({ cmd: ["git", "-C", proj, "status", "--porcelain"] })
  .stdout?.toString() ?? "";
if (!/\.tsx?(\s|$)/m.test(status)) process.exit(0); // no TS changes this turn

const r = Bun.spawnSync({ cmd: ["bun", "run", "typecheck"], cwd: proj });
if (r.exitCode !== 0) {
  const out = ((r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""))
    .trim().split("\n").slice(-25).join("\n");
  console.error("⚠️ tsc --noEmit failed — TypeScript errors before finishing:\n" + out);
  process.exit(2);
}
process.exit(0);
