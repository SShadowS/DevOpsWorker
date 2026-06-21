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
import { findDefinition, findCallees, findCallers } from './al-symbol/resolver.ts';

const USAGE = `Usage:
  bun scripts/al-symbol.ts def <Symbol> [--root <dir>]
  bun scripts/al-symbol.ts callees <file.al> <Proc>
  bun scripts/al-symbol.ts callers <Symbol> [--root <dir>]`;

function scanAlFiles(root: string): string[] {
  return [...new Glob('**/*.al').scanSync({ cwd: root, absolute: true })];
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

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write(USAGE + '\n');
  process.exit(1);
}

const [subcommand, ...rest] = args;

switch (subcommand) {
  case 'def': {
    const symbol = rest[0];
    if (!symbol) {
      process.stderr.write('def: missing <Symbol>\n' + USAGE + '\n');
      process.exit(1);
    }
    try {
      const root = resolve(parseRoot(rest.slice(1)) ?? process.cwd());
      const files = scanAlFiles(root);
      const defs = findDefinition(symbol, files);

      if (defs.length === 0) {
        console.log(`No definition found for '${symbol}'.`);
      } else if (defs.length > 1) {
        console.log(`# ambiguous: ${defs.length} definitions found for '${symbol}'`);
        for (const d of defs) {
          console.log(`# ${d.file}:${d.line}`);
          console.log(d.body);
          console.log('');
        }
      } else {
        const d = defs[0]!;
        console.log(`# ${d.file}:${d.line}`);
        console.log(d.body);
      }
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
      const callees = findCallees(resolve(file), proc);
      if (callees.length === 0) {
        console.log(`No callees found for '${proc}' in ${file}.`);
      } else {
        for (const name of callees) console.log(name);
      }
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
      const root = resolve(parseRoot(rest.slice(1)) ?? process.cwd());
      const files = scanAlFiles(root);
      const callers = findCallers(symbol, files);

      if (callers.length === 0) {
        console.log(`No callers found for '${symbol}'.`);
      } else {
        for (const c of callers) {
          console.log(`${c.file}:${c.line}  ${c.proc}`);
        }
      }
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
