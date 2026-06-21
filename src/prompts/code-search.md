# Code Search Priority Rules

- **ALWAYS** use local tools (grep, glob, read) for code search — never Azure DevOps code search.
- Azure DevOps MCP tools are only for: work items, PRs, pipelines, repo metadata.
- LSP tools (if available) are preferred for AL code structure analysis (documentSymbol, hover, findReferences).
- When searching for AL objects, search by filename pattern (e.g. `*.al`) and by object name within files.
