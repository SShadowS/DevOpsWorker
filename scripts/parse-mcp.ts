#!/usr/bin/env bun
/**
 * parse-mcp — Extract useful summaries from MCP tool result files.
 *
 * MCP tool results that exceed the context window are saved as JSON files
 * with the format: [{type: "text", text: "<json string>"}]
 * This script handles the double-deserialization and provides common views.
 *
 * Usage (subcommand-first — preferred):
 *   bun scripts/parse-mcp.ts <command> <file> [options]
 *
 * Legacy file-first ordering (`bun scripts/parse-mcp.ts <file> [command] [options]`)
 * is still accepted for backward compatibility.
 *
 * Commands:
 *   runs                          — List pipeline runs (from list_pipeline_runs result)
 *   timeline                      — Show pipeline tasks with errors (from pipeline_timeline result)
 *   errors                        — Show only failed tasks and their error messages
 *   raw                           — Print the inner JSON (after unwrapping the MCP envelope)
 *   keys                          — Print top-level keys of the inner JSON
 *   changes <file> [--paths-only] — List changed files from get_pull_request_changes result
 *   changes-diff <file> <substr>  — Print patch for files matching substring
 *   repos <file> [--filter <sub>] — List repositories (name/id) from list_repositories result
 *   search <file>                 — Flatten search_code results to path:line:text
 *   file-content <file>           — Print file content from get_file_content result
 *     [--lines N-M]               —   Print only lines N through M (1-indexed, inclusive)
 *     [--find <regex>]            —   Print lines matching regex (with line numbers)
 *     [--context N]               —   With --find: include N lines before/after each match
 *
 * If no command is given, auto-detects based on file content.
 *
 * Examples (subcommand-first):
 *   bun scripts/parse-mcp.ts runs /path/to/mcp-azureDevOps-list_pipeline_runs-*.txt
 *   bun scripts/parse-mcp.ts errors /path/to/mcp-azureDevOps-pipeline_timeline-*.txt
 *   bun scripts/parse-mcp.ts changes /path/to/mcp-azureDevOps-get_pull_request_changes-*.txt --paths-only
 *   bun scripts/parse-mcp.ts repos /path/to/mcp-azureDevOps-list_repositories-*.txt --filter MyRepo
 *   bun scripts/parse-mcp.ts search /path/to/mcp-azureDevOps-search_code-*.txt
 *   bun scripts/parse-mcp.ts file-content /path/to/mcp-azureDevOps-get_file_content-*.txt --lines 10-20
 *   bun scripts/parse-mcp.ts file-content /path/to/mcp-azureDevOps-get_file_content-*.txt --find 'TODO' --context 2
 *
 * Examples (legacy file-first — still supported):
 *   bun scripts/parse-mcp.ts /path/to/mcp-azureDevOps-list_pipeline_runs-*.txt runs
 *   bun scripts/parse-mcp.ts /path/to/mcp-azureDevOps-pipeline_timeline-*.txt errors
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Parse the MCP envelope
// ---------------------------------------------------------------------------

export function parseMcpFile(path: string): unknown {
  const raw = readFileSync(path, 'utf-8');
  const envelope = JSON.parse(raw);

  // MCP format: [{type: "text", text: "<json>"}]
  if (Array.isArray(envelope) && envelope[0]?.text) {
    return JSON.parse(envelope[0].text);
  }

  // Already unwrapped
  return envelope;
}

// ---------------------------------------------------------------------------
// Command: runs
// ---------------------------------------------------------------------------

function showRuns(data: any): void {
  const runs = Array.isArray(data) ? data : data?.runs ?? data?.value ?? [];
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }

  console.log(`Pipeline runs (${runs.length} total):\n`);
  console.log(
    'ID'.padEnd(8) +
    'Outcome'.padEnd(22) +
    'Branch'.padEnd(50) +
    'Created',
  );
  console.log('-'.repeat(110));

  for (const r of runs.slice(0, 20)) {
    const id = String(r.id ?? '');
    const outcome = r.buildOutcome ?? resultToString(r.result) ?? '?';
    const branch = (r.sourceBranch ?? r.branch ?? '').replace('refs/heads/', '');
    const created = (r.createdDate ?? '').substring(0, 19);
    console.log(
      id.padEnd(8) +
      outcome.padEnd(22) +
      branch.substring(0, 49).padEnd(50) +
      created,
    );
  }
}

function resultToString(result: number | string | undefined): string {
  if (typeof result === 'string') return result;
  switch (result) {
    case 0: return 'unknown';
    case 1: return 'succeeded';
    case 2: return 'failed';
    case 4: return 'canceled';
    default: return String(result ?? '?');
  }
}

// ---------------------------------------------------------------------------
// Command: timeline
// ---------------------------------------------------------------------------

function showTimeline(data: any): void {
  const records: any[] = data?.records ?? data ?? [];
  if (records.length === 0) {
    console.log('No timeline records found.');
    return;
  }

  // Sort by order
  const sorted = [...records].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  console.log(`Timeline (${sorted.length} records):\n`);
  console.log(
    'Type'.padEnd(12) +
    'Name'.padEnd(45) +
    'Result'.padEnd(18) +
    'Errors'.padEnd(8) +
    'Warnings',
  );
  console.log('-'.repeat(100));

  for (const r of sorted) {
    // Skip stages/phases without meaningful info, show tasks
    if (r.type === 'Checkpoint') continue;

    const type = (r.type ?? '').substring(0, 11);
    const name = (r.name ?? '').substring(0, 44);
    const result = r.result ?? '';
    const errors = r.errorCount ?? 0;
    const warnings = r.warningCount ?? 0;

    // Highlight failures
    const marker = errors > 0 ? '❌ ' : result === 'failed' ? '❌ ' : '';

    console.log(
      marker +
      type.padEnd(marker ? 10 : 12) +
      name.padEnd(45) +
      String(result).padEnd(18) +
      String(errors).padEnd(8) +
      String(warnings),
    );
  }
}

// ---------------------------------------------------------------------------
// Command: errors
// ---------------------------------------------------------------------------

function showErrors(data: any): void {
  const records: any[] = data?.records ?? data ?? [];

  const failed = records.filter(
    (r: any) =>
      (r.errorCount ?? 0) > 0 ||
      r.result === 'failed' ||
      r.result === 'succeededWithIssues',
  );

  if (failed.length === 0) {
    console.log('No errors found — all tasks passed.');
    return;
  }

  console.log(`Found ${failed.length} task(s) with errors:\n`);

  for (const r of failed) {
    console.log(`❌ ${r.name} (${r.type ?? 'Task'}) — result: ${r.result}`);
    console.log(`   Errors: ${r.errorCount ?? 0}, Warnings: ${r.warningCount ?? 0}`);
    if (r.logId) console.log(`   Log ID: ${r.logId} (use get_pipeline_log to fetch)`);

    const issues = r.issues ?? [];
    if (issues.length > 0) {
      console.log('   Issues:');
      for (const issue of issues) {
        const type = issue.type === 'error' ? '  ERROR' : '  WARN ';
        console.log(`   ${type}: ${issue.message ?? '(no message)'}`);
      }
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Command: raw / keys
// ---------------------------------------------------------------------------

function showRaw(data: any): void {
  console.log(JSON.stringify(data, null, 2).substring(0, 5000));
}

function showKeys(data: any): void {
  if (typeof data !== 'object' || data === null) {
    console.log('Not an object:', typeof data);
    return;
  }
  if (Array.isArray(data)) {
    console.log(`Array with ${data.length} items`);
    if (data[0]) console.log('First item keys:', Object.keys(data[0]));
  } else {
    console.log('Keys:', Object.keys(data));
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`);
      else console.log(`  ${k}: ${typeof v}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: changes
// Pure function: returns array of lines. CLI printer calls join('\n').
// ---------------------------------------------------------------------------

export interface ChangesOptions {
  pathsOnly?: boolean;
}

export function buildChangesLines(data: any, opts: ChangesOptions = {}): string[] {
  const lines: string[] = [];

  // Shape A: data.changes.changeEntries[]
  if (data?.changes?.changeEntries && Array.isArray(data.changes.changeEntries)) {
    for (const entry of data.changes.changeEntries) {
      const path: string = entry?.item?.path ?? entry?.path ?? '(unknown)';
      const changeType: string = entry?.changeType ?? 'unknown';
      lines.push(opts.pathsOnly ? path : `${changeType}\t${path}`);
    }
    return lines;
  }

  // Shape B: data.files[]
  if (data?.files && Array.isArray(data.files)) {
    for (const file of data.files) {
      const path: string = file?.path ?? '(unknown)';
      // Derive changeType from patch markers if available
      let changeType = file?.changeType ?? 'modify';
      if (!file?.changeType && file?.patch) {
        if (file.patch.startsWith('+++ /dev/null') || /^\+\+\+ b\//.test(file.patch)) {
          changeType = 'add';
        }
      }
      lines.push(opts.pathsOnly ? path : `${changeType}\t${path}`);
    }
    return lines;
  }

  // Shape A (flat): data.changeEntries[]
  if (data?.changeEntries && Array.isArray(data.changeEntries)) {
    for (const entry of data.changeEntries) {
      const path: string = entry?.item?.path ?? entry?.path ?? '(unknown)';
      const changeType: string = entry?.changeType ?? 'unknown';
      lines.push(opts.pathsOnly ? path : `${changeType}\t${path}`);
    }
    return lines;
  }

  lines.push('No changed files found. Keys: ' + (typeof data === 'object' && data !== null ? Object.keys(data).join(', ') : String(data)));
  return lines;
}

// ---------------------------------------------------------------------------
// Command: changes-diff
// Pure function: returns { lines, exitCode }
// ---------------------------------------------------------------------------

export interface ChangesDiffResult {
  lines: string[];
  exitCode: number;
}

export function buildChangesDiffLines(data: any, pathSubstring: string): ChangesDiffResult {
  if (!data?.files || !Array.isArray(data.files)) {
    return {
      lines: ["this changes result has no per-file patches — use shape B-aware MCP call"],
      exitCode: 1,
    };
  }

  const matches = data.files.filter((f: any) =>
    typeof f?.path === 'string' && f.path.includes(pathSubstring),
  );

  if (matches.length === 0) {
    return {
      lines: [`No file matching '${pathSubstring}' found. Available paths:\n` +
        data.files.map((f: any) => `  ${f?.path ?? '(unknown)'}`).join('\n')],
      exitCode: 1,
    };
  }

  const outputLines: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const file = matches[i];
    if (i > 0) {
      outputLines.push('', `---`, `${file.path}`, `---`, '');
    }
    outputLines.push(file.patch ?? '(no patch available)');
  }

  return { lines: outputLines, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command: repos
// Pure function: returns array of lines.
// ---------------------------------------------------------------------------

export interface ReposOptions {
  filter?: string;
}

export function buildReposLines(data: any, opts: ReposOptions = {}): string[] {
  // Unwrap Azure DevOps { value: [...] } envelope or plain array
  const repos: any[] = Array.isArray(data) ? data : (data?.value ?? []);

  let rows = repos.map((r: any) => ({
    name: String(r?.name ?? '(unknown)'),
    id: String(r?.id ?? '(unknown)'),
  }));

  if (opts.filter) {
    const lower = opts.filter.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(lower));
  }

  if (rows.length === 0) {
    return ['No repositories found.'];
  }

  return rows.map(r => `${r.name}\t${r.id}`);
}

// ---------------------------------------------------------------------------
// Command: search
// Pure function: returns array of lines.
// ---------------------------------------------------------------------------

export function buildSearchLines(data: any): string[] {
  const results: any[] = data?.results ?? data?.value ?? (Array.isArray(data) ? data : []);

  if (results.length === 0) {
    const keys = typeof data === 'object' && data !== null ? Object.keys(data) : [];
    return [
      'no results extracted',
      `keys found: ${keys.join(', ') || '(none)'}`,
    ];
  }

  const lines: string[] = [];
  for (const result of results) {
    const filePath: string = result?.path ?? result?.filePath ?? result?.fileName ?? '(unknown)';
    const matches: any[] = result?.matches ?? result?.hits ?? [];

    if (matches.length === 0) {
      lines.push(`${filePath}:(no matches)`);
      continue;
    }

    for (const match of matches) {
      if (typeof match === 'string') {
        lines.push(`${filePath}:${match}`);
      } else {
        const lineNum: string | number | undefined = match?.lineNumber ?? match?.line_number ?? match?.line;
        const text: string = match?.content ?? match?.text ?? match?.line ?? '(no text)';
        if (lineNum !== undefined) {
          lines.push(`${filePath}:${lineNum}:${text}`);
        } else {
          lines.push(`${filePath}:${text}`);
        }
      }
    }
  }

  if (lines.length === 0) {
    const keys = typeof data === 'object' && data !== null ? Object.keys(data) : [];
    return [
      'no results extracted',
      `keys found: ${keys.join(', ') || '(none)'}`,
    ];
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Command: file-content
// Pure function: returns { lines, exitCode }
// ---------------------------------------------------------------------------

export interface FileContentOptions {
  lineRange?: { from: number; to: number }; // 1-indexed inclusive
  find?: string;                             // regex pattern
  context?: number;                          // lines before/after find match
}

export interface FileContentResult {
  lines: string[];
  exitCode: number;
}

export function buildFileContentLines(data: any, opts: FileContentOptions = {}): FileContentResult {
  if (opts.lineRange && opts.find) {
    return {
      lines: ['--lines and --find are mutually exclusive'],
      exitCode: 1,
    };
  }

  // Extract the raw content string
  let content: string;
  if (typeof data === 'string') {
    content = data;
  } else if (typeof data?.content === 'string') {
    content = data.content;
  } else {
    const keys = typeof data === 'object' && data !== null ? Object.keys(data) : [];
    return {
      lines: [
        'Could not extract file content. Expected data.content (string) or data as string.',
        `Keys found: ${keys.join(', ') || '(none)'}`,
      ],
      exitCode: 1,
    };
  }

  const allLines = content.split('\n');

  // --lines N-M
  if (opts.lineRange) {
    const { from, to } = opts.lineRange;
    const start = Math.max(1, from);
    const end = Math.min(allLines.length, to);
    const output: string[] = [];
    for (let i = start; i <= end; i++) {
      output.push(`${i}:${allLines[i - 1]}`);
    }
    return { lines: output, exitCode: 0 };
  }

  // --find <regex> [--context N]
  if (opts.find) {
    let regex: RegExp;
    try {
      regex = new RegExp(opts.find);
    } catch {
      return {
        lines: [`Invalid regex: ${opts.find}`],
        exitCode: 1,
      };
    }

    const ctx = opts.context ?? 0;
    const indicesToInclude = new Set<number>();

    for (let i = 0; i < allLines.length; i++) {
      if (regex.test(allLines[i]!)) {
        for (let j = Math.max(0, i - ctx); j <= Math.min(allLines.length - 1, i + ctx); j++) {
          indicesToInclude.add(j);
        }
      }
    }

    if (indicesToInclude.size === 0) {
      return { lines: [`No lines matching /${opts.find}/`], exitCode: 0 };
    }

    const sortedIndices = [...indicesToInclude].sort((a, b) => a - b);
    const output: string[] = [];
    let prevIdx: number | null = null;
    for (const idx of sortedIndices) {
      if (prevIdx !== null && idx > prevIdx + 1) {
        output.push('--');
      }
      output.push(`${idx + 1}:${allLines[idx]}`);
      prevIdx = idx;
    }
    return { lines: output, exitCode: 0 };
  }

  // No flags: print full content
  return { lines: [content], exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

function autoDetect(data: any, filePath: string): string {
  if (filePath.includes('list_pipeline_runs')) return 'runs';
  if (filePath.includes('pipeline_timeline')) return 'errors';
  if (filePath.includes('get_pipeline_run')) return 'raw';
  if (filePath.includes('get_pull_request_changes')) return 'changes';
  if (filePath.includes('list_repositories')) return 'repos';
  if (filePath.includes('search_code')) return 'search';
  if (filePath.includes('get_file_content')) return 'file-content';
  if (data?.records) return 'errors';
  if (data?.runs || (Array.isArray(data) && data[0]?.buildOutcome !== undefined)) return 'runs';
  return 'keys';
}

// ---------------------------------------------------------------------------
// Thin printers (CLI use only)
// ---------------------------------------------------------------------------

function printLines(lines: string[]): void {
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Argument parsing — supports both subcommand-first (preferred) and
// file-first (legacy) orderings. Exported for testing.
// ---------------------------------------------------------------------------

export const KNOWN_COMMANDS = new Set([
  'runs', 'timeline', 'errors', 'raw', 'keys',
  'changes', 'changes-diff', 'repos', 'search', 'file-content',
]);

export interface ParsedCliArgs {
  command: string | undefined;
  filePath: string | undefined;
  restArgs: string[];
}

export function parseCliArgs(rawArgs: string[]): ParsedCliArgs {
  let command: string | undefined;
  let filePath: string | undefined;
  const restArgs: string[] = [];

  if (rawArgs.length === 0) {
    return { command, filePath, restArgs };
  }

  // Subcommand-first (preferred): `<command> <file> [options]`
  if (KNOWN_COMMANDS.has(rawArgs[0]!)) {
    command = rawArgs[0]!;
    filePath = rawArgs[1];
    for (let i = 2; i < rawArgs.length; i++) restArgs.push(rawArgs[i]!);
  }
  // Legacy file-first: `<file> [command] [options]`
  else {
    filePath = rawArgs[0]!;
    command = rawArgs[1];
    for (let i = 2; i < rawArgs.length; i++) restArgs.push(rawArgs[i]!);
  }

  return { command, filePath, restArgs };
}

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------

if (import.meta.main) {

const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
  console.error('Usage: bun scripts/parse-mcp.ts <command> <file> [options]   (file-first legacy: `<file> <command>` also accepted)');
  console.error('Commands: ' + Array.from(KNOWN_COMMANDS).join(', '));
  process.exit(1);
}

const parsed = parseCliArgs(rawArgs);
let { command, filePath } = parsed;
const restArgs = parsed.restArgs;

if (!filePath) {
  console.error('Missing <file>. Usage: bun scripts/parse-mcp.ts <command> <file> [options]');
  process.exit(1);
}

if (!command) {
  command = autoDetect(parseMcpFile(filePath), filePath);
}

switch (command) {
  case 'runs': {
    showRuns(parseMcpFile(filePath));
    break;
  }
  case 'timeline': {
    showTimeline(parseMcpFile(filePath));
    break;
  }
  case 'errors': {
    showErrors(parseMcpFile(filePath));
    break;
  }
  case 'raw': {
    showRaw(parseMcpFile(filePath));
    break;
  }
  case 'keys': {
    showKeys(parseMcpFile(filePath));
    break;
  }
  case 'changes': {
    const pathsOnly = restArgs.includes('--paths-only');
    const data = parseMcpFile(filePath);
    printLines(buildChangesLines(data, { pathsOnly }));
    break;
  }
  case 'changes-diff': {
    const pathSubstring = restArgs[0];
    if (!pathSubstring) {
      console.error('Usage: bun scripts/parse-mcp.ts changes-diff <file> <path-substring>');
      process.exit(1);
    }
    const data = parseMcpFile(filePath);
    const result = buildChangesDiffLines(data, pathSubstring);
    printLines(result.lines);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    break;
  }
  case 'repos': {
    const filterIdx = restArgs.indexOf('--filter');
    const filter = filterIdx !== -1 ? restArgs[filterIdx + 1] : undefined;
    const data = parseMcpFile(filePath);
    printLines(buildReposLines(data, { filter }));
    break;
  }
  case 'search': {
    const data = parseMcpFile(filePath);
    printLines(buildSearchLines(data));
    break;
  }
  case 'file-content': {
    const linesIdx = restArgs.indexOf('--lines');
    const findIdx = restArgs.indexOf('--find');
    const contextIdx = restArgs.indexOf('--context');

    const linesFlag = linesIdx !== -1
      ? restArgs[linesIdx + 1]
      : restArgs.find(a => a.startsWith('--lines='))?.split('=')[1];
    const findFlag = findIdx !== -1
      ? restArgs[findIdx + 1]
      : restArgs.find(a => a.startsWith('--find='))?.split('=')[1];
    const contextFlag = contextIdx !== -1
      ? restArgs[contextIdx + 1]
      : restArgs.find(a => a.startsWith('--context='))?.split('=')[1];

    const opts: FileContentOptions = {};

    if (linesFlag) {
      const m = linesFlag.match(/^(\d+)-(\d+)$/);
      if (!m) {
        console.error(`Invalid --lines format '${linesFlag}'. Expected N-M (e.g. 10-20).`);
        process.exit(1);
      }
      opts.lineRange = { from: parseInt(m[1]!, 10), to: parseInt(m[2]!, 10) };
    }

    if (findFlag) {
      opts.find = findFlag;
    }

    if (contextFlag) {
      opts.context = parseInt(contextFlag, 10);
    }

    const data = parseMcpFile(filePath);
    const result = buildFileContentLines(data, opts);
    printLines(result.lines);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    break;
  }
  default: {
    console.error(`Unknown command: ${command}`);
    console.error('Valid commands: ' + Array.from(KNOWN_COMMANDS).join(', '));
    process.exit(1);
  }
}

} // end if (import.meta.main)
