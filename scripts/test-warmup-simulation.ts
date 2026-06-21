#!/usr/bin/env bun
/**
 * Simulates how the pipeline runs the plan-reviewer agent:
 * - Stages CLAUDE.md and .claude/ into cwd (via symlinks)
 * - Uses settingSources: ['project'] (same as runAgent)
 * - Uses claude_code preset (same as runAgent)
 * - Checks if the agent follows the LSP Warm-Up instructions
 *
 * Usage:
 *   bun scripts/test-warmup-simulation.ts <cwd> <agent-source-dir>
 *
 * Example:
 *   bun scripts/test-warmup-simulation.ts /state/tools/al-lsp-plugin/test-al-project /app/src/agents/plan-reviewer
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveAlLspPlugin, TOOL_SETS } from '../src/sdk/mcp-configs.ts';
import { stageAgentWorkspace } from '../src/sdk/agent-workspace.ts';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

const cwd = process.argv[2];
const agentSourceDir = process.argv[3];

if (!cwd || !agentSourceDir) {
  console.error('Usage: bun scripts/test-warmup-simulation.ts <cwd> <agent-source-dir>');
  process.exit(1);
}

const plugin = resolveAlLspPlugin();
console.log('Plugin:', JSON.stringify(plugin));

// Stage workspace exactly like the pipeline does
console.log(`\nStaging workspace: ${agentSourceDir} -> ${cwd}`);
const staged = await stageAgentWorkspace(agentSourceDir, cwd);
console.log('  Staged links:', staged.links);

// Prompt that mimics what plan-reviewer buildPrompt produces
const prompt = [
  '## Task',
  'Review the development plan for work item #99999 as a senior AL developer.',
  'Challenge the plan critically.',
  '',
  '## Step 0 — LSP Warm-Up (MANDATORY FIRST ACTION)',
  'Before doing ANY other work, verify that the AL Language Server is functional:',
  '1. Call `ToolSearch` with query "LSP" to load the LSP tool schema',
  '2. Use `Glob` with pattern `src/**/*.al` to find an AL source file',
  '3. Call `LSP` with operation `documentSymbol` on the first .al file found',
  '4. Report: "LSP verified — [N] symbols found in [filename]" then proceed',
  '5. If LSP fails, report the error and continue with text-based tools as fallback',
  '',
  'This step is non-negotiable. Skip it and your output will be rejected.',
  'After this warm-up, use LSP for ALL subsequent AL code navigation.',
  '',
  '## Development Plan to Review',
  '{ "objective": "Test plan", "steps": ["step 1"] }',
  '',
  'After verifying LSP works, just output a brief summary of what you found.',
  'Do NOT produce a full review — this is a diagnostic test only.',
].join('\n');

console.log('\nRunning agent with settingSources: ["project"] + LSP plugin...');
console.log(`  cwd: ${cwd}`);
console.log(`  tools: ${TOOL_SETS.fsReadOnlyWithLSP.join(', ')}`);
console.log('');

let resultText = '';
const toolsUsed: string[] = [];

try {
  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
      },
      settingSources: ['project'],
      allowedTools: [...TOOL_SETS.fsReadOnlyWithLSP],
      plugins: [plugin].filter(Boolean) as SdkPluginConfig[],
      model: (process.env['TEST_MODEL'] ?? 'haiku') as any,
      cwd,
      maxTurns: Number(process.env['TEST_MAX_TURNS'] ?? '8'),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (msg.type === 'result') {
      console.log(`\nDone: ${msg.num_turns} turns, cost=$${msg.total_cost_usd.toFixed(4)}`);
    } else if (msg.type === 'assistant') {
      const content = msg.message?.content as any[];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            resultText += block.text;
          } else if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            console.log(`  tool: ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
          }
        }
      }
    }
  }
} finally {
  await staged.cleanup();
  console.log('\nWorkspace cleaned up.');
}

console.log('\n=== Tools used (in order) ===');
toolsUsed.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

console.log('\n=== Agent response ===');
console.log(resultText.trim().slice(0, 1500));
console.log('======================');

const lspUsed = toolsUsed.includes('LSP');
const toolSearchUsed = toolsUsed.includes('ToolSearch');
const lspVerified = resultText.includes('LSP verified') || resultText.includes('symbols found');

console.log('\n=== Warm-up check ===');
console.log('ToolSearch called:', toolSearchUsed ? 'YES' : 'NO');
console.log('LSP called:', lspUsed ? 'YES' : 'NO');
console.log('Verification reported:', lspVerified ? 'YES' : 'NO');

if (lspUsed && lspVerified) {
  console.log('\nPASS: Agent followed warm-up instructions and LSP works');
} else if (lspUsed) {
  console.log('\nPARTIAL: Agent called LSP but did not report verification text');
} else {
  console.log('\nFAIL: Agent did NOT call LSP — warm-up instructions were ignored');
}
