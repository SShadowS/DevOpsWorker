/**
 * al-symbol/parser.ts
 *
 * Thin wrapper around web-tree-sitter that provides a cached singleton parser
 * loaded with the AL grammar WASM, exposing parseSource() and parseFile().
 *
 * The module performs a top-level await on import, so by the time any export
 * is called the parser is already initialised.
 */
import { Parser, Language, Tree } from 'web-tree-sitter';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface ParsedFile {
  path: string;
  tree: Tree;
}

// Paths to the WASM files bundled with the npm packages.
const RUNTIME_WASM = join(import.meta.dir, '../../node_modules/web-tree-sitter/web-tree-sitter.wasm');
const AL_WASM = join(import.meta.dir, '../../node_modules/@sshadows/tree-sitter-al/tree-sitter-al.wasm');

// Initialise once at module load time (top-level await — safe in Bun/ESM).
await Parser.init({ locateFile: () => RUNTIME_WASM });
const _al = await Language.load(AL_WASM);
const _parser = new Parser();
_parser.setLanguage(_al);

/** Parse AL source text. `path` is used only for the returned ParsedFile. */
export function parseSource(path: string, source: string): ParsedFile {
  const tree = _parser.parse(source);
  if (!tree) throw new Error(`Failed to parse AL source: ${path}`);
  return { path, tree };
}

/** Read `path` from disk and parse it. */
export function parseFile(path: string): ParsedFile {
  const source = readFileSync(path, 'utf-8');
  return parseSource(path, source);
}
