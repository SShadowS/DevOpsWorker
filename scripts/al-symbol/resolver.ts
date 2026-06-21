/**
 * al-symbol/resolver.ts
 *
 * Syntactic (tree-sitter) resolver for AL procedure definitions, callees,
 * and callers.  Operates purely on parse trees — no semantic analysis.
 *
 * Node-type facts discovered via spike (web-tree-sitter + @sshadows/tree-sitter-al):
 *   procedure declaration : "procedure"
 *   procedure name child  : first "identifier" named-child of the procedure node
 *   call expression       : "call_expression"
 *   callee name           : first named-child of call_expression is either
 *                             "identifier"        → simple call  (Commit, CreateRecord)
 *                             "member_expression" → qualified call (FileArchive.Insert)
 *                           For member_expression, the last "identifier" named-child
 *                           is the method name.
 */
import type { Node } from 'web-tree-sitter';
import { parseFile } from './parser.ts';

export interface Definition {
  file: string;
  line: number; // 1-based start line of the procedure
  body: string; // full procedure text
}

export interface CallerRef {
  file: string;
  proc: string; // name of the procedure that contains the call
  line: number; // 1-based start line of the call_expression
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the procedure name from a `procedure` node.
 * The name is the first `identifier` named-child.
 */
function procedureName(n: Node): string | undefined {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)!;
    if (c.type === 'identifier') return c.text;
  }
  return undefined;
}

/**
 * Extract the callee name from a `call_expression` node.
 *
 * - Simple call  `Commit()`         → first named-child is `identifier` → "Commit"
 * - Qualified    `FileArchive.X()`  → first named-child is `member_expression`
 *                                     → last `identifier` named-child of that = "X"
 */
function calleeName(n: Node): string | undefined {
  const first = n.namedChildCount > 0 ? n.namedChild(0)! : null;
  if (!first) return undefined;

  if (first.type === 'identifier') return first.text;

  if (first.type === 'member_expression') {
    // member_expression has named children: object identifier, dot, method identifier
    // The last identifier is the method name.
    for (let i = first.namedChildCount - 1; i >= 0; i--) {
      const c = first.namedChild(i)!;
      if (c.type === 'identifier') return c.text;
    }
  }

  return undefined;
}

/** Walk all named nodes, calling `visit` for each. */
function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i)!, visit);
  }
}

/**
 * Return all procedure nodes in a parse tree, pruning the walk at procedure
 * boundaries so nested procedures are not double-counted (and so callees of an
 * outer procedure are not double-walked).
 */
function procedureNodes(root: Node): Node[] {
  const result: Node[] = [];
  function recurse(n: Node): void {
    if (n.type === 'procedure') {
      result.push(n);
      return; // don't descend into nested procs
    }
    for (let i = 0; i < n.namedChildCount; i++) recurse(n.namedChild(i)!);
  }
  recurse(root);
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find all procedures named `symbol` across the given files.
 * Returns one Definition per match; `line` is 1-based.
 * Name matching is case-insensitive (AL is a case-insensitive language).
 */
export function findDefinition(symbol: string, files: string[]): Definition[] {
  const results: Definition[] = [];
  const target = symbol.toLowerCase();

  for (const file of files) {
    const parsed = parseFile(file);
    const procs = procedureNodes(parsed.tree.rootNode);

    for (const proc of procs) {
      if (procedureName(proc)?.toLowerCase() === target) {
        results.push({
          file,
          line: proc.startPosition.row + 1,
          body: proc.text,
        });
      }
    }
  }

  return results;
}

/**
 * Return the names of all procedures called inside `proc` in the given file.
 * Includes both simple calls (`Commit()`) and qualified calls (`obj.Method()`).
 * The procedure name is matched case-insensitively. Deduplicates the result.
 */
export function findCallees(file: string, proc: string): string[] {
  const parsed = parseFile(file);
  const procs = procedureNodes(parsed.tree.rootNode);
  const target = proc.toLowerCase();
  const procNode = procs.find(p => procedureName(p)?.toLowerCase() === target);
  if (!procNode) return [];

  const names = new Set<string>();
  walk(procNode, n => {
    if (n.type === 'call_expression') {
      const name = calleeName(n);
      if (name) names.add(name);
    }
  });

  return [...names];
}

/**
 * Find every procedure (across the given files) that calls `symbol`.
 * Returns one CallerRef per call site.
 * The symbol is matched case-insensitively (AL is case-insensitive).
 */
export function findCallers(symbol: string, files: string[]): CallerRef[] {
  const results: CallerRef[] = [];
  const target = symbol.toLowerCase();

  for (const file of files) {
    const parsed = parseFile(file);
    const procs = procedureNodes(parsed.tree.rootNode);

    for (const proc of procs) {
      const procName = procedureName(proc);
      if (!procName) continue;

      walk(proc, n => {
        if (n.type === 'call_expression' && calleeName(n)?.toLowerCase() === target) {
          results.push({
            file,
            proc: procName,
            line: n.startPosition.row + 1,
          });
        }
      });
    }
  }

  return results;
}
