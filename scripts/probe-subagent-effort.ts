// Probe: which reasoning effort does a sub-agent run at? The main agent runs at
// MAIN_EFFORT and dispatches two sub-agents — one with no effort set, one pinned
// to 'low' — that each report $CLAUDE_EFFORT (the SDK exposes the active effort
// to Bash under that name). Costs a few cents on Sonnet.
//   bun scripts/probe-subagent-effort.ts [main-effort]
import { query } from '@anthropic-ai/claude-agent-sdk';

const mainEffort = (process.argv[2] ?? 'medium') as 'low' | 'medium' | 'high';
const report = 'Run this exact Bash command and reply with only its output: echo "effort=${CLAUDE_EFFORT:-unset}"';

const q = query({
  prompt:
    'Dispatch the sub-agent "unpinned", then the sub-agent "pinned-low", one after the other, ' +
    'each with the prompt "report". Then run the same Bash command yourself: ' +
    'echo "effort=${CLAUDE_EFFORT:-unset}". Reply with three lines: main=<your output>, ' +
    'unpinned=<its output>, pinned-low=<its output>.',
  options: {
    model: 'claude-sonnet-5-5',
    effort: mainEffort,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Agent', 'Bash'],
    settingSources: [],
    maxTurns: 12,
    agents: {
      unpinned: { description: 'Reports its effort', prompt: report, tools: ['Bash'], model: 'claude-sonnet-5-5' },
      'pinned-low': { description: 'Reports its effort', prompt: report, tools: ['Bash'], model: 'claude-sonnet-5-5', effort: 'low' },
    },
  },
});

for await (const m of q) {
  if (m.type === 'result') {
    console.log(`main effort requested: ${mainEffort}`);
    console.log('result' in m ? m.result : m.subtype);
    console.log(`cost $${m.total_cost_usd.toFixed(3)}`);
  }
}
