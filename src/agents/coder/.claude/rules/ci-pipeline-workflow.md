# CI Pipeline — trigger, then delegate the wait to `ci-waiter`

**NEVER manually poll CI status.** Do not use `get_pipeline_run` in a loop, and NEVER `sleep` to wait for CI. You do NOT wait for CI yourself — you trigger the build and hand the waiting to the cheap `ci-waiter` subagent.

## Step 1 — Trigger only (you own the runId)

```bash
bun scripts/await-pipeline.ts --branch <your-branch> --trigger-only
```

This triggers the build, prints `runId=<id>`, and exits **0** immediately — it does NOT wait. Capture `<id>`: it is your authoritative CI run id. Report it as `ciRunId` in your output (the server-side CI backstop verifies that exact run).

## Step 2 — Delegate the wait to the `ci-waiter` subagent

Call the **`Task`** tool with `subagent_type: "ci-waiter"`. Put the exact attach command in its prompt:

```
Wait for the CI build and report the outcome. Run this, following its exit-code rules:

  bun scripts/await-pipeline.ts --attach <id> --timeout 100
```

The subagent runs on Haiku with a tiny context, loops the `--attach` round-trips itself, and returns a single final line:

- `RESULT: PASSED runId=<id>`
- `RESULT: FAILED runId=<id>` followed by the key error lines

It is **blocking** — you wait for its result, then continue. This is far cheaper than re-running `--attach` yourself, because each poll would otherwise replay your entire context.

## Step 3 — Act on the result

- **PASSED** → record `ciResult: 'passed'` and `ciRunId: <id>`.
- **FAILED** → read the returned errors, fix the code, commit, push, then go back to **Step 1** (a new build → a **new** runId; delegate the new wait again).

## Hard rules

- `--trigger-only` is the ONLY way you start a build. NEVER re-run with `--branch` to "check" a build — that starts a DUPLICATE build and wastes CI minutes.
- NEVER `sleep`. NEVER poll `get_pipeline_run` in a loop. All waiting happens inside the `ci-waiter` subagent.
- After the build completes, ALWAYS check for AppSourceCop errors — `succeeded`/`partiallySucceeded` can still hide task-level errors. The subagent's FAILED report and `parse-mcp.ts errors <file>` surface these.

To inspect a previously saved pipeline timeline file, use `bun scripts/parse-mcp.ts <file> errors`.
