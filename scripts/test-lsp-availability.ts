#!/usr/bin/env bun
/**
 * Diagnostic script: verifies that the AL LSP plugin is loaded and
 * the LSP tool can perform operations (hover, documentSymbol, etc.).
 *
 * Usage:
 *   bun scripts/test-lsp-availability.ts <cwd> [al-file-relative-path]
 *
 * cwd should be an AL project directory (containing app.json).
 * al-file is an optional .al file to test LSP operations on.
 * If omitted, the script just checks tool visibility.
 *
 * Examples:
 *   bun scripts/test-lsp-availability.ts "U:\Git\DO.Support\DocumentOutput\Cloud"
 *   bun scripts/test-lsp-availability.ts "U:\Git\DO.Support\DocumentOutput\Cloud" "AL/src/SomeFile.al"
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveAlLspPlugin, TOOL_SETS } from '../src/sdk/mcp-configs.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

const cwd = process.argv[2] ?? process.cwd();
const alFile = process.argv[3];

// ── Check plugin resolution ────────────────────────────────────────
const plugin = resolveAlLspPlugin();
if (!plugin) {
  console.error('✗ AL LSP plugin not found in ~/.claude/plugins/cache/');
  console.error('  Install it first, then re-run this script.');
  process.exit(1);
}
console.log(`✓ AL LSP plugin resolved: ${(plugin as { path: string }).path}`);

// ── Build prompt ───────────────────────────────────────────────────
// The LSP is a SINGLE tool called "LSP" with an operation parameter.
// Individual operations (hover, goToDefinition, etc.) are parameters,
// not separate tools.

let prompt: string;

if (alFile) {
  prompt = [
    'You have an LSP tool available. I need you to test it works.',
    '',
    `1. First, call the LSP tool with operation "documentSymbol" on the file "${alFile}"`,
    '2. Then report what you got back.',
    '',
    'Print your findings prefixed with RESULT: on each line.',
    'If the LSP tool is not available or fails, print: RESULT:FAIL:<reason>',
    'If it works, print: RESULT:OK followed by a summary of the symbols found.',
  ].join('\n');
} else {
  prompt = [
    'You have access to tools. I need you to confirm which tools you see.',
    '',
    'For each tool available to you, print exactly one line: TOOL:<toolName>',
    'Then, if you see an "LSP" tool, describe what operations/parameters it accepts.',
    'Print each operation as: OP:<operationName>',
    'If you see NO LSP tool, print: NO_LSP',
  ].join('\n');
}

console.log(`\nRunning agent query to ${alFile ? 'test LSP operations' : 'detect LSP tool'}…`);
console.log(`  cwd: ${cwd}`);
console.log(`  allowedTools: ${TOOL_SETS.fsReadOnlyWithLSP.join(', ')}`);
if (alFile) console.log(`  test file: ${alFile}`);
console.log('');

let resultText = '';
const startTime = Date.now();

for await (const message of query({
  prompt,
  options: {
    allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP],
    plugins: [plugin].filter(Boolean) as SdkPluginConfig[],
    model: (process.env['TEST_MODEL'] ?? 'haiku') as any,
    cwd,
    maxTurns: Number(process.env['TEST_MAX_TURNS'] ?? '5'),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
})) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (message.type === 'system') {
    const subtype = 'subtype' in message ? (message as any).subtype : '';
    console.log(`  [${elapsed}s] system: ${subtype}`);
  } else if (message.type === 'assistant') {
    console.log(`  [${elapsed}s] assistant turn`);
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          resultText += block.text;
        } else if (block.type === 'tool_use') {
          console.log(`  [${elapsed}s]   → tool_use: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
        }
      }
    }
  } else if (message.type === 'tool_progress') {
    const name = (message as any).tool_name ?? '';
    console.log(`  [${elapsed}s] tool_progress: ${name}`);
  } else if (message.type === 'result') {
    const cost = message.total_cost_usd;
    console.log(`\nAgent finished — $${cost.toFixed(4)}, ${message.num_turns} turn(s), ${elapsed}s\n`);
  } else {
    console.log(`  [${elapsed}s] ${message.type}`);
  }
}

// ── Report ─────────────────────────────────────────────────────────
console.log('── Agent response ──');
console.log(resultText.trim());
console.log('────────────────────');

// Quick summary
const hasLSP = resultText.includes('TOOL:LSP') || resultText.includes('LSP');
const hasFail = resultText.includes('RESULT:FAIL');
const hasOK = resultText.includes('RESULT:OK');

if (alFile) {
  if (hasOK) {
    console.log('\n✓ LSP tool is functional — operations work against the AL project.');
  } else if (hasFail) {
    console.log('\n✗ LSP tool was found but operations failed. Check the output above.');
  } else {
    console.log('\n? Could not determine LSP status from agent response.');
  }
} else {
  if (hasLSP) {
    console.log('\n✓ LSP tool is visible to the agent.');
  } else {
    console.log('\n✗ LSP tool was NOT detected.');
  }
}
