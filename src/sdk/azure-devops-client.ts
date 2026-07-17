// ---------------------------------------------------------------------------
// Azure DevOps REST client — thin re-export barrel.
//
// The client used to be a single 780-line file spanning 5 unrelated resource
// domains (work items, pull requests, comments, test results, builds) plus a
// hand-rolled XML parser. It's now split by resource under `./ado/`:
//
//   ado/http.ts          — shared AzureDevOpsError, adoFetch, buildPipelineRunUrl
//   ado/work-items.ts    — work item CRUD, tags, comments, rerun-command scanner
//   ado/pull-requests.ts — PR status, review comments, posting, rerun-command scanner
//   ado/test-results.ts  — test case failure resolution + steps-XML parsing
//   ado/builds.ts        — build timeline / CI task errors
//
// This file exists only so every existing
// `import { fn } from '.../sdk/azure-devops-client.ts'` keeps resolving
// unchanged. Add new ADO functionality under `./ado/<resource>.ts` and
// re-export it here — do not add new code directly in this file.
// ---------------------------------------------------------------------------

export { AzureDevOpsError, buildPipelineRunUrl } from './ado/http.ts';
export * from './ado/work-items.ts';
export * from './ado/pull-requests.ts';
export * from './ado/test-results.ts';
export * from './ado/builds.ts';
