#!/usr/bin/env bun
/**
 * al-symbol — syntactic AL procedure resolver
 *
 * Subcommands:
 *   def <Symbol> [--root <dir>]       Print procedure body for every match of Symbol
 *   callees <file.al> <Proc>          Print names of procedures called inside Proc
 *   callers <Symbol> [--root <dir>]   Print every procedure that calls Symbol
 *
 * Resolution is syntactic (tree-sitter), not semantic.
 *
 * Usage:
 *   bun scripts/al-symbol.ts def Insert --root tests/fixtures/al-symbol
 *   bun scripts/al-symbol.ts callees InsertFileArchive.Codeunit.al Insert
 *   bun scripts/al-symbol.ts callers Insert --root tests/fixtures/al-symbol
 */
import { Glob } from 'bun';
import { resolve } from 'path';
import { statSync } from 'fs';
import { findDefinition, findCalleesWithPresence, findCallers, type Definition, type CallerRef } from './al-symbol/resolver.ts';

const USAGE = `Usage:
  bun scripts/al-symbol.ts def <Symbol> [--root <dir>]
  bun scripts/al-symbol.ts callees <file.al> <Proc>
  bun scripts/al-symbol.ts callers <Symbol> [--root <dir>]`;

/**
 * Every `.al` file under `root`, INCLUDING those inside dot-directories.
 *
 * `dot: true` is the whole point. Bun's Glob skips dot-directories by default,
 * and in these repos the companion apps' source is vendored under
 * `.dependencies/` — so the default hid exactly the callees a reviewer cannot
 * read from the diff. Measured on a real clone: `find` reported 1280 `.al`
 * files, the glob returned 1082, and a symbol defined only under
 * `.dependencies` came back as "No definition found". Passing `--root` INTO the
 * dot-directory worked, which is what disguised it — the same lookup resolved
 * or not depending on where the caller stood.
 */
export function scanAlFiles(root: string): string[] {
  return [...new Glob('**/*.al').scanSync({ cwd: root, absolute: true, dot: true })];
}

/** Above this many matches, print where they are instead of what they contain. */
const MAX_BODIES = 3;

/**
 * Render `def` results.
 *
 * One match, or a handful, prints the bodies — that is the answer the caller
 * wanted. Past `MAX_BODIES` the bodies stop being an answer and become a
 * haystack: a real lookup of a common test-library name matched 33 procedures
 * and printed 28 KB across 515 lines into an agent's context for one question.
 * Beyond the threshold every location is still named — nothing is hidden — with
 * the two ways to narrow stated, so the caller is never left guessing.
 */
export function formatDefinitions(symbol: string, defs: Definition[]): string {
  if (defs.length === 0) return `No definition found for '${symbol}'.`;

  if (defs.length === 1) {
    const d = defs[0]!;
    return `# ${d.file}:${d.line}\n${d.body}`;
  }

  const header = `# ambiguous: ${defs.length} definitions found for '${symbol}'`;

  if (defs.length <= MAX_BODIES) {
    return [header, ...defs.map((d) => `# ${d.file}:${d.line}\n${d.body}\n`)].join('\n');
  }

  return [
    header,
    `# too many to print in full — locations only`,
    ...defs.map((d) => `${d.file}:${d.line}`),
    `# narrow with --root <dir>, or Read one of the files above at that line`,
  ].join('\n');
}

/** Above this many call sites, summarise by file instead of listing every one. */
const MAX_CALL_SITES = 40;

/** And in that summary, list at most this many files before counting the rest. */
const MAX_FILES_LISTED = 25;

/**
 * Render `callers` results.
 *
 * Same bound as `formatDefinitions`, for the same reason. Measured on a real
 * clone, `callers Insert` produced 1229 lines / 145 KB — and common AL names
 * (Insert, Get, Run, FindFirst) are exactly the ones an agent reaches for. Past
 * the threshold the per-file counts answer "where does this cluster" without
 * spending the context, and the caller is told how to get the detail back.
 */
export function formatCallers(symbol: string, callers: CallerRef[]): string {
  if (callers.length === 0) return `No callers found for '${symbol}'.`;

  if (callers.length <= MAX_CALL_SITES) {
    return callers.map((c) => `${c.file}:${c.line}  ${c.proc}`).join('\n');
  }

  const byFile = new Map<string, number>();
  for (const c of callers) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
  const ranked = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  // The per-file summary needs its own cap: call sites spread thinly across
  // hundreds of files produce a file list as long as the call list it replaced.
  const shown = ranked.slice(0, MAX_FILES_LISTED);
  const hidden = ranked.length - shown.length;

  return [
    `# ${callers.length} call sites across ${byFile.size} files — too many to list`,
    ...shown.map(([file, n]) => `${n}\t${file}`),
    ...(hidden > 0 ? [`# … and ${hidden} more files`] : []),
    `# narrow with --root <dir> to list the call sites themselves`,
  ].join('\n');
}

/**
 * Render `callees` results.
 *
 * "This procedure calls nothing" and "this file has no such procedure" used to
 * print the same sentence. They are opposite answers — one says stop looking,
 * the other says you are in the wrong file — and conflating them invites a
 * finding resting on "I checked, it calls nothing".
 */
export function formatCallees(
  proc: string,
  file: string,
  result: { found: boolean; callees: string[] },
): string {
  if (!result.found) return `No procedure named '${proc}' in ${file} — check the file, or find it with: def ${proc}`;
  if (result.callees.length === 0) return `'${proc}' calls nothing in ${file}.`;
  return result.callees.join('\n');
}

/**
 * Resolve and validate a `--root` value.
 *
 * The tool's own hint tells the caller to "narrow with --root <dir>", and the
 * obvious next move after reading a file path out of the output is to paste
 * that path back in. That produced a raw `ENOTDIR: not a directory, open ...`,
 * which says what went wrong but not what to do instead.
 */
export function resolveRoot(root: string): string {
  const abs = resolve(root.trim());
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new Error(`--root ${abs} does not exist`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`--root must be a directory, and ${abs} is a file — pass the folder that contains it`);
  }
  return abs;
}

/** Extract the value of a `--root <dir>` flag, or null if absent. */
function parseRoot(args: string[]): string | null {
  const rootIdx = args.indexOf('--root');
  if (rootIdx !== -1 && args[rootIdx + 1]) return args[rootIdx + 1]!;
  return null;
}

/** Print a clean one-line error to stderr and exit 1. */
function fail(err: unknown): never {
  process.stderr.write(`al-symbol: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// Only run the CLI when this file IS the entry point. Without the guard, merely
// importing it — which is how `scanAlFiles` and `formatDefinitions` are tested —
// parses argv, finds none, prints usage and calls process.exit(1), killing the
// test run before a single assertion executes.
const args = import.meta.main ? process.argv.slice(2) : [];

if (import.meta.main && args.length === 0) {
  process.stderr.write(USAGE + '\n');
  process.exit(1);
}

const [subcommand, ...rest] = args;

if (import.meta.main) switch (subcommand) {
  case 'def': {
    const symbol = rest[0];
    if (!symbol) {
      process.stderr.write('def: missing <Symbol>\n' + USAGE + '\n');
      process.exit(1);
    }
    try {
      const root = resolveRoot(parseRoot(rest.slice(1)) ?? process.cwd());
      const files = scanAlFiles(root);
      const defs = findDefinition(symbol, files);
      console.log(formatDefinitions(symbol, defs));
    } catch (err) {
      fail(err);
    }
    break;
  }

  case 'callees': {
    const file = rest[0];
    const proc = rest[1];
    if (!file || !proc) {
      process.stderr.write('callees: missing <file.al> and/or <Proc>\n' + USAGE + '\n');
      process.exit(1);
    }
    try {
      console.log(formatCallees(proc, file, findCalleesWithPresence(resolve(file), proc)));
    } catch (err) {
      fail(err);
    }
    break;
  }

  case 'callers': {
    const symbol = rest[0];
    if (!symbol) {
      process.stderr.write('callers: missing <Symbol>\n' + USAGE + '\n');
      process.exit(1);
    }
    try {
      const root = resolveRoot(parseRoot(rest.slice(1)) ?? process.cwd());
      const files = scanAlFiles(root);
      console.log(formatCallers(symbol, findCallers(symbol, files)));
    } catch (err) {
      fail(err);
    }
    break;
  }

  default: {
    process.stderr.write(`Unknown command: ${subcommand}\n` + USAGE + '\n');
    process.exit(1);
  }
}
