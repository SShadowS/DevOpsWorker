# AL Code Intelligence Tools — LSP, Serena, and Text Search

You have a running AL Language Server. Call `LSP` directly — it is your primary tool for AL code navigation. Always prefer LSP over Bash grep/find for code exploration.

## MANDATORY: Proactive LSP Usage for AL Code Changes

When editing or analyzing AL code, you MUST proactively use LSP tools — do not wait to be asked. Specifically:

- **Before editing a file**: Use `documentSymbol` to understand its structure
- **Before modifying a procedure**: Use `hover` to check its signature and types
- **Before renaming or changing a symbol**: Use `findReferences` to find all usages
- **When navigating to related code**: Use `goToDefinition`, not text search
- **When understanding call flow**: Use `incomingCalls`/`outgoingCalls`

Never rely on Grep/Glob for AL code navigation when LSP is available. Text search is only appropriate for comments, TODOs, and non-code content.

## Available Tool Categories

| Tool | Best For |
|------|----------|
| **LSP** | Compiler-aware navigation (definitions, references, types, call hierarchy) |
| **Serena** | Symbolic code analysis, editing, and cross-reference exploration |
| **Grep/Glob** | Text patterns, comments, file discovery |

## Available LSP Operations

### goToDefinition
**Use when:** You need to find where a symbol (procedure, variable, field, table, enum, etc.) is defined.

**Better than Grep because:** It follows the compiler's resolution rules, handles imports, and works across files including dependencies.

**Examples:**
- "Where is `UpdateSearchName` defined?" → Use `goToDefinition` on the procedure call
- "What table is `Customer` referring to?" → Use `goToDefinition` on the table reference
- "Where is this enum value declared?" → Use `goToDefinition` on the enum value

### findReferences
**Use when:** You need to find all places where a symbol is used.

**Better than Grep because:** It understands AL semantics — won't match comments, strings, or similarly-named symbols in different scopes.

**Examples:**
- "Where is `UpdateSearchName` called from?" → Use `findReferences` on the procedure
- "What code uses the `Customer` table?" → Use `findReferences` on the table
- "Find all usages of this field" → Use `findReferences` on the field

### hover
**Use when:** You need type information, documentation, or signature details for a symbol.

**Better than reading the file because:** It provides compiled type information including inferred types, full field lists for records, and procedure signatures.

**Examples:**
- "What type is this variable?" → Use `hover` on the variable
- "What parameters does this procedure take?" → Use `hover` on the procedure call
- "What fields does this record have?" → Use `hover` on a Record variable

### documentSymbol
**Use when:** You need to see all symbols in a file, get object IDs, or understand file structure.

**Better than reading the file because:** It provides structured outline with object IDs, symbol kinds, types, and hierarchy.

**Examples:**
- "What procedures are in this codeunit?" → Use `documentSymbol`
- "What is the object ID of this table?" → Use `documentSymbol` (returns `Table 50000 "Name"`)
- "What are the enum values?" → Use `documentSymbol`

**Key insight:** `documentSymbol` is the preferred way to get object IDs, not text parsing. The top-level symbol always includes: `ObjectType ObjectID "ObjectName" (Kind) - Line N`

### workspaceSymbol
**Use when:** You need to search for symbols across the entire project.

**Better than Glob/Grep because:** It searches the compiled symbol table, not just text patterns.

### prepareCallHierarchy / incomingCalls / outgoingCalls
**Use when:** You need to analyze call relationships.

- `incomingCalls` — find all procedures that call a specific procedure (callers)
- `outgoingCalls` — find all procedures that a specific procedure calls (callees)

**Better than findReferences because:** Focuses on call relationships and identifies the calling/called procedure, not just the location.

## Decision Guide: LSP vs Serena vs Text Search

| Task | LSP | Serena | Grep/Glob |
|------|-----|--------|-----------|
| Find where a symbol is defined | `goToDefinition` ✓ | `find_symbol` | — |
| Find all usages of a symbol | `findReferences` ✓ | `find_referencing_symbols` | — |
| Get type/signature info | `hover` ✓ | — | — |
| Get all fields of a Record/Table | `hover` ✓ | — | — |
| Get object ID (codeunit/table/page number) | `documentSymbol` ✓ | — | — |
| Get enum values with ordinals | `documentSymbol` ✓ | — | — |
| List symbols in a file | `documentSymbol` ✓ | `get_symbols_overview` | — |
| Search symbols by name | `workspaceSymbol` | `find_symbol` ✓ | — |
| Find callers of a procedure | `incomingCalls` ✓ | `find_referencing_symbols` | — |
| Find callees of a procedure | `outgoingCalls` ✓ | — | — |
| Get symbol body/implementation | Read file | `find_symbol` with `include_body` ✓ | — |
| Symbol-aware code insertion | — | `insert_after/before_symbol` ✓ | — |
| Search for text in comments | — | `search_for_pattern` | `Grep` ✓ |
| Find files by naming pattern | — | `find_file` | `Glob` ✓ |

**✓ = Preferred tool for this task**

## When to Choose Which

**Use LSP when:**
- You need object metadata (object ID, type, name) → `documentSymbol`
- You need field information for a Record/Table → `hover`
- You need compiler-aware type information → `hover`
- You need precise call hierarchy analysis → `incomingCalls`/`outgoingCalls`
- You're navigating between definitions and references → `goToDefinition`/`findReferences`

**Use Serena when:**
- You want to read/edit code at the symbol level
- You need to find symbols with context (surrounding code)
- You're doing refactoring that requires symbol-aware insertion
- LSP is not returning results (e.g., missing dependencies)

**Use Grep/Glob when:**
- You're searching for text patterns (comments, strings, TODOs)
- You need to find files by name patterns
- You're searching for non-code content

## When Tools Return No Results

**If an LSP operation fails:**
1. **Verify the file path exists** — use `Glob` to confirm the exact path. This is the most common cause of LSP failures.
2. Common path mistakes:
   - Wrong subdirectory (e.g., `AL/Codeunit/` vs `.dependencies/EXT/Codeunit/`)
   - Missing or wrong object number prefix in filename
   - Case sensitivity issues on Linux
3. If the path is wrong, use `Glob` with the filename pattern (e.g., `**/*EXTQueueManagement*`) to find the correct location

**If LSP operations return empty results:**
1. Verify the file is a `.al` file in a valid AL project
2. Check that the position is on a valid symbol (not whitespace or comments)
3. The symbol might be from an external dependency (`.dal` virtual file)
4. **Try Serena** — it may work when LSP fails due to missing dependencies
5. Fall back to Grep/Glob for text-based search as a last resort
