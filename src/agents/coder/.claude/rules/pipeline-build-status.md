# Pipeline Build Status Reference

## The `buildOutcome` Field

When you call `get_pipeline_run`, the response includes a `buildOutcome` field at the top level. This is the **authoritative** field for determining CI pass/fail.

| Value | Meaning | What to report |
|-------|---------|----------------|
| `succeeded` | All build tasks passed | `ciResult: 'passed'` |
| `failed` | One or more tasks failed | `ciResult: 'failed'` |
| `canceled` | Build was canceled | `ciResult: 'failed'` |
| `partiallySucceeded` | Some tasks had issues | Check individual tasks (see below) |
| `inProgress` | Build is still running | Wait and re-check |
| `canceling` | Build is being canceled | Wait and re-check |
| `unknown` | Status not determined | `ciResult: 'failed'` |

**Common mistake:** Do NOT infer success from `state: "completed"`. Completed only means the build finished — it could have finished with a failure. Always check `buildOutcome`.

**Rule:** Report `ciResult: 'passed'` ONLY when `buildOutcome` is `"succeeded"`. For ALL other values, report `ciResult: 'failed'` (or wait if `inProgress`/`canceling`).

## Legacy Numeric Fields

If you see numeric values for `state` or `result` (older MCP server versions), these are the mappings:

### `state` field

| Value | Status | Description |
|-------|--------|-------------|
| 0 | Unknown | State not set |
| 1 | InProgress | Build is running |
| 2 | Canceling | Build is being canceled |
| 4 | Completed | Build has finished |

### `result` field

| Value | Status | Description |
|-------|--------|-------------|
| 0 | Unknown | Result not set |
| 1 | Succeeded | All tasks passed |
| 2 | Failed | One or more tasks failed |
| 4 | Canceled | Build was canceled |

**Common mistake:** `result: 0` is NOT success — it means the result is unknown (build may still be running). `result: 1` is success.

## Checking Individual Pipeline Tasks

`buildOutcome` alone is not reliable — a build can report `succeeded` or `partiallySucceeded` even when critical tasks have errors.

After the pipeline completes:

1. Call `pipeline_timeline` with the run ID
2. Look for tasks with errors (not just warnings) — focus on:
   - **AppSourceCop validation** — its errors are breaking changes (AS0032, AS0064, AS0067)
   - **Compile** — compilation errors mean the code doesn't build
3. Report `ciResult: 'failed'` if ANY task has errors, regardless of `buildOutcome`
4. Include the error messages in `compilationErrors` so reviewers can see them

**Note:** `partiallySucceeded` from non-critical tasks (e.g., translation service on dev branches) is acceptable — only tasks with actual errors matter.
