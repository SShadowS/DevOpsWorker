#!/usr/bin/env bun
// Update dependencies to latest and validate (typecheck + full unit suite).
// The Claude Agent SDK ships frequently — run this to ADOPT + VERIFY a new
// version safely instead of bumping blind.
//
// Usage:
//   bun scripts/update-deps.ts            # update ALL deps to latest
//   bun scripts/update-deps.ts --sdk-only # update only @anthropic-ai/claude-agent-sdk
//
// On success: commit package.json + bun.lock, then rebuild the prod image
// (private/deploy/docker-build.ps1) and re-pin the overlay/internal CORE_REF.
// On failure: the offending step's output is shown; revert with `git checkout
// package.json bun.lock && bun install`.
import { $ } from 'bun';

const sdkOnly = process.argv.includes('--sdk-only');
const SDK = '@anthropic-ai/claude-agent-sdk';

async function step(label: string, fn: () => Promise<unknown>) {
  process.stdout.write(`\n=== ${label} ===\n`);
  try {
    await fn();
  } catch {
    console.error(`\n❌ ${label} FAILED on the updated dependencies.`);
    console.error('   The update is NOT safe to ship. Revert with:');
    console.error('     git checkout package.json bun.lock && bun install');
    process.exit(1);
  }
}

const before = await $`bun pm ls`.text().catch(() => '');

await step(sdkOnly ? `Update ${SDK} to latest` : 'Update all deps to latest', () =>
  sdkOnly ? $`bun update --latest ${SDK}` : $`bun update --latest`,
);
await step('Typecheck', () => $`bun run typecheck`);
await step('Unit tests', () => $`bun run test`);

const after = await $`bun pm ls`.text().catch(() => '');
console.log('\n✅ Green on the updated dependencies.');
if (before && after && before !== after) console.log('   (lockfile changed)');
console.log('\nNext:');
console.log('  1. git add package.json bun.lock && git commit -m "chore(deps): update + verify"');
console.log('  2. git push  (public core)');
console.log('  3. Rebuild prod: pwsh private/deploy/docker-build.ps1   (bakes the new deps)');
console.log('  4. Re-pin overlay + internal CORE_REF to the new core tag, so their CI follows.');
