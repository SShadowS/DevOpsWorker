import { z } from 'zod';
import type { AgentConfig } from '../types/agent.types.ts';
import type { PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import { TOOL_SETS, TOOLS } from '../sdk/mcp-configs.ts';

// ---------------------------------------------------------------------------
// Diagnostic agent — lightweight env health check (not a pipeline stage)
// ---------------------------------------------------------------------------

export const DiagnosticSchema = z.object({
  lsp: z.object({
    available: z.boolean(),
    languages: z.array(z.string()).describe('Languages the LSP responded for'),
    details: z.string().optional(),
  }),
  tools: z.object({
    requested: z.array(z.string()),
    functional: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  mcp: z.object({
    servers: z.array(z.object({
      name: z.string(),
      connected: z.boolean(),
      error: z.string().optional(),
    })),
  }),
  environment: z.object({
    cwd: z.string(),
    claudeMdFound: z.boolean(),
    dotClaudeFound: z.boolean(),
    settingsLoaded: z.array(z.string()),
  }),
  summary: z.string(),
});

export type DiagnosticResult = z.infer<typeof DiagnosticSchema>;

export function createDiagnosticConfig(options: {
  cwd: string;
  includeMcp?: boolean;
  mcpServers?: Record<string, any>;
  /** Add specific MCP tool names to allowedTools and test whether they're restricted */
  testMcpRestrictions?: string[];
}): AgentConfig<typeof DiagnosticSchema> {
  const baseTools = [
    ...TOOL_SETS.fsAndBashWithLSP,
    TOOLS.Skill,
  ];

  const allowedTools = options.testMcpRestrictions
    ? [...baseTools, ...options.testMcpRestrictions]
    : baseTools;

  const mcpTestMode = options.testMcpRestrictions && options.testMcpRestrictions.length > 0;

  return {
    name: 'diagnostic',
    useClaudeCodePreset: true,
    // Use cli/ dir as agent source — no CLAUDE.md here, runs with just the preset
    agentSourceDir: import.meta.dirname,
    sharedPromptFragments: [],
    outputSchema: DiagnosticSchema,
    allowedTools,
    mcpServers: options.includeMcp ? options.mcpServers : undefined,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 20,
    maxBudgetUsd: 0.50,
    cwd: options.cwd,

    buildPrompt(_state: PipelineState, _ctx: PipelineContext): string {
      if (mcpTestMode) {
        return [
          '## MCP Tool Restriction Test',
          '',
          'You are testing whether allowedTools restricts MCP server tools.',
          'Your allowedTools includes ONLY these MCP tools: ' + options.testMcpRestrictions!.join(', '),
          '',
          'Perform these tests:',
          '',
          '1. Try calling `mcp__zendesk__get_ticket` with ticket ID "1" — this SHOULD be allowed',
          '2. Try calling `mcp__zendesk__search` with query "test" — this should be BLOCKED if restrictions work',
          '3. Try calling `mcp__zendesk__list_tickets` — this should be BLOCKED if restrictions work',
          '',
          'For each, report whether the tool was available and callable, or if it was denied/missing.',
          'Report results in the tools section: functional = tools that worked, failed = tools that were blocked.',
          'In the summary, state clearly whether allowedTools successfully restricted MCP tools or not.',
          '',
          'For other fields: lsp.available=false, lsp.languages=[], mcp.servers=[], environment: check cwd and files.',
        ].join('\n');
      }

      return [
        '## Diagnostic Task',
        '',
        'You are a diagnostic agent. Be FAST — minimize tool calls, combine checks where possible.',
        'Run these checks and immediately produce structured output:',
        '',
        '1. **Glob** for *.al and *.ts files (one call each, in parallel)',
        '2. **Read** one small file to verify Read works',
        '3. **Bash** `echo hello` to verify Bash works',
        '4. **Grep** for a common keyword to verify Grep works',
        '5. **LSP** try `documentSymbol` on a found .al or .ts file (if any)',
        '6. **Bash** `ls CLAUDE.md .claude/ 2>&1` to check environment',
        '',
        'Skip Edit/Write (read-only diagnostic). No MCP servers to check.',
        '',
        'Then immediately produce structured output with your findings.',
        'For settingsLoaded, report ["project"] (that is what was configured).',
      ].join('\n');
    },
  };
}
