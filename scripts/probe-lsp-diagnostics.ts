#!/usr/bin/env bun
/**
 * Probe: does Claude Code auto-inject AL LSP diagnostics after an edit?
 *
 * The CLI registers a PASSIVE publishDiagnostics handler and, after edit-type
 * tools run, injects a <new-diagnostics> block of NEW diagnostics into context
 * (getLSPDiagnosticAttachments). This probe drives an agent to introduce a
 * deliberate AL error, then captures the FULL message stream and reports whether
 * a diagnostics block was actually injected — independent of what the agent says.
 *
 * Usage:
 *   bun scripts/probe-lsp-diagnostics.ts <al-project-cwd> <target-al-file-rel>
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { resolveAlLspPlugin, TOOL_SETS } from '../src/sdk/mcp-configs.ts';
import { writeFileSync } from 'fs';

const cwd = process.argv[2];
const target = process.argv[3];
if (!cwd || !target) {
  console.error('Usage: bun scripts/probe-lsp-diagnostics.ts <al-project-cwd> <target-al-file-rel>');
  process.exit(1);
}

const plugin = resolveAlLspPlugin();
console.log(`AL LSP plugin: ${plugin ? (plugin as { path: string }).path : 'NOT FOUND'}`);
if (!plugin) process.exit(1);

const prompt = [
  `This is a controlled LSP-diagnostics test on the file "${target}". Do these steps IN ORDER:`,
  '',
  `1. Call the LSP tool with operation "documentSymbol" on "${target}" (this makes the language server open/track the file).`,
  `2. Then use the Edit tool to insert this deliberately INVALID AL line (a SYNTAX error) on its own line inside`,
  `   an existing procedure or trigger body, and save it:`,
  '',
  '       @@@ this is not valid AL syntax $$$ ###',
  '',
  `   DO NOT fix it afterward — this error is intentional.`,
  `3. Then call the LSP tool "documentSymbol" on "${target}" AGAIN (to nudge a recompute).`,
  `4. In your NEXT message, report VERBATIM any feedback, diagnostics, compiler errors, or system messages you`,
  `   received after the edit. If you saw a "<new-diagnostics>" block or any error list, quote it exactly.`,
  `   If you received NOTHING, say exactly: "NO DIAGNOSTIC FEEDBACK RECEIVED".`,
].join('\n');

const captured: any[] = [];
let injectedDiagnosticsText = '';
let sawNewDiagnosticsTag = false;
let agentReport = '';

const startTime = Date.now();
for await (const message of query({
  prompt,
  options: {
    allowedTools: [...TOOL_SETS.fsAndBashWithLSP],
    plugins: [plugin].filter(Boolean) as SdkPluginConfig[],
    model: (process.env['PROBE_MODEL'] ?? 'sonnet') as any,
    cwd,
    maxTurns: Number(process.env['PROBE_MAX_TURNS'] ?? '10'),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
})) {
  captured.push(message);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Scan EVERY message's serialized form for an injected diagnostics block.
  const blob = JSON.stringify(message);
  if (/new-diagnostics/i.test(blob)) {
    sawNewDiagnosticsTag = true;
    injectedDiagnosticsText += blob + '\n';
  }

  if (message.type === 'assistant') {
    const content = (message as any).message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_use') console.log(`  [${elapsed}s] → ${b.name}`);
        else if (b.type === 'text') agentReport += b.text + '\n';
      }
    }
  } else if (message.type === 'user') {
    // Injected meta turns (tool results + any <new-diagnostics> attachment) arrive as 'user'.
    const content = (message as any).message?.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    if (/diagnostic|error|new-diagnostics/i.test(text)) {
      console.log(`  [${elapsed}s] [user/meta carries diagnostic-ish content]`);
    }
  } else if (message.type === 'system') {
    console.log(`  [${elapsed}s] system: ${(message as any).subtype ?? ''}`);
  } else if (message.type === 'result') {
    console.log(`  [${elapsed}s] result: $${(message as any).total_cost_usd?.toFixed?.(4)}`);
  }
}

writeFileSync('probe-messages.json', JSON.stringify(captured, null, 2));

console.log('\n========== PROBE RESULT ==========');
console.log(`<new-diagnostics> block injected:  ${sawNewDiagnosticsTag ? 'YES ✓' : 'NO ✗'}`);
const agentSaysNothing = /NO DIAGNOSTIC FEEDBACK RECEIVED/i.test(agentReport);
console.log(`Agent reported receiving nothing:  ${agentSaysNothing ? 'YES' : 'no'}`);
console.log(`\n--- agent's report of feedback received ---`);
console.log(agentReport.slice(-1500).trim());
if (sawNewDiagnosticsTag) {
  console.log(`\n--- injected diagnostics blob (first 1200 chars) ---`);
  console.log(injectedDiagnosticsText.slice(0, 1200));
}
console.log(`\nFull message stream saved to probe-messages.json (${captured.length} messages)`);
