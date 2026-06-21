import { join } from 'path';
import { runAgent } from '../sdk/run-agent.ts';
import { createDiagnosticConfig, type DiagnosticResult } from './diagnostic-agent.ts';
import type { PipelineState, PipelineContext, PipelineConfig } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// pipeline diagnose [--session <path>]
// ---------------------------------------------------------------------------

export async function diagnose(args: string[]): Promise<void> {
  const sessionPath = parseSessionArg(args);
  const testMcp = args.includes('--test-mcp');
  const cwd = sessionPath ?? process.cwd();

  console.log(`Running diagnostics in: ${cwd}`);
  if (testMcp) {
    console.log('Mode: MCP tool restriction test (allowedTools = [mcp__zendesk__get_ticket] only)');
  }
  console.log('');

  const config = createDiagnosticConfig({
    cwd,
    testMcpRestrictions: testMcp ? ['mcp__zendesk__get_ticket'] : undefined,
  });
  const state: PipelineState = {
    currentStage: 'diagnostic',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
  const context: PipelineContext = {
    workItemId: 0,
    workItem: {
      id: 0,
      title: 'Diagnostic',
      type: 'Bug',
      state: 'Active',
      areaPath: '',
      iterationPath: '',
      fields: {},
    },
    workItemType: 'Bug',
    config: minimalConfig(cwd),
  };

  const result = await runAgent(config, state, context);
  printDiagnosticReport(result.output);
}

// ---------------------------------------------------------------------------
// Pretty-print the diagnostic report
// ---------------------------------------------------------------------------

function printDiagnosticReport(r: DiagnosticResult): void {
  const pass = '✅';
  const fail = '❌';
  const warn = '⚠️';

  console.log('═══════════════════════════════════════');
  console.log('        DIAGNOSTIC REPORT');
  console.log('═══════════════════════════════════════\n');

  // LSP
  console.log(`${r.lsp.available ? pass : fail} LSP`);
  if (r.lsp.languages.length > 0) {
    console.log(`  Languages: ${r.lsp.languages.join(', ')}`);
  }
  if (r.lsp.details) {
    console.log(`  ${r.lsp.details}`);
  }

  // Tools
  console.log(`\n${r.tools.failed.length === 0 ? pass : warn} Tools`);
  console.log(`  Functional: ${r.tools.functional.join(', ') || 'none'}`);
  if (r.tools.failed.length > 0) {
    console.log(`  Failed:     ${r.tools.failed.join(', ')}`);
  }

  // MCP
  if (r.mcp.servers.length > 0) {
    const allOk = r.mcp.servers.every(s => s.connected);
    console.log(`\n${allOk ? pass : warn} MCP Servers`);
    for (const s of r.mcp.servers) {
      console.log(`  ${s.connected ? pass : fail} ${s.name}${s.error ? ` — ${s.error}` : ''}`);
    }
  } else {
    console.log(`\n${pass} MCP Servers: none configured`);
  }

  // Environment
  console.log(`\n${pass} Environment`);
  console.log(`  CWD:              ${r.environment.cwd}`);
  console.log(`  CLAUDE.md:        ${r.environment.claudeMdFound ? 'found' : 'not found'}`);
  console.log(`  .claude/:         ${r.environment.dotClaudeFound ? 'found' : 'not found'}`);
  console.log(`  Settings loaded:  ${r.environment.settingsLoaded.join(', ') || 'none'}`);

  // Summary
  console.log(`\n───────────────────────────────────────`);
  console.log(r.summary);
  console.log('');
}

// ---------------------------------------------------------------------------
// Minimal PipelineConfig — only paths are used by runAgent
// ---------------------------------------------------------------------------

function minimalConfig(cwd: string): PipelineConfig {
  return {
    azureDevOps: {
      organization: '',
      orgUrl: '',
      project: '',
      repositoryId: '',
      repositoryName: '',
      ciPipelineId: 0,
      cdPipelineId: 0,
      areaPath: '',
      iterationPath: '',
      pat: '',
    },
    paths: {
      sessionRoot: cwd,
      targetRepo: cwd,
      stateDir: join(cwd, '.pipeline', 'state'),
    },
    checkpoints: {
      planApproval: { tag: '', rerunCommand: '', timeoutHours: 0 },
      prPublished: { fixCommand: '', timeoutHours: 0 },
      pollIntervalMinutes: 0,
    },
    revisionLoops: { maxAttempts: 0 },
    models: { default: 'claude-haiku-4-5-20251001' },
    costs: {},
    repoKey: 'TargetRepo',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseSessionArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--session' || arg === '-s') && args[i + 1]) {
      return args[++i]!;
    }
  }
  return undefined;
}
