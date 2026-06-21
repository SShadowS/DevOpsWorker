/**
 * Quick test: does the claude_code preset + settingSources: ['project']
 * actually load .claude/rules/ files?
 *
 * We ask the agent something only the coder's rules would tell it
 * (Azure DevOps PR status codes from azure-devops-status-codes.md).
 *
 * Runs directly from the coder agent's directory (has CLAUDE.md + .claude/rules/).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'coder');

async function main() {
  console.log(`Running agent with cwd: ${AGENT_DIR}\n`);

  for await (const message of query({
    prompt: 'According to your rules or instructions, what does Azure DevOps PR status value 1 mean? And what does mergeStatus value 3 mean? Only answer based on information in your instructions/rules. Answer concisely.',
    options: {
      systemPrompt: 'You are a helpful assistant. Answer based only on your instructions.',
      allowedTools: [],
      model: 'claude-haiku-4-5-20251001',
      cwd: AGENT_DIR,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            console.log('RESPONSE:', block.text);
          }
        }
      }
    }
    if (message.type === 'result') {
      console.log(`\nResult: ${message.subtype} ($${message.total_cost_usd.toFixed(4)})`);
    }
  }
}

main().catch(console.error);
