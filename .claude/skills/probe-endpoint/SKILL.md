---
name: probe-endpoint
description: >-
  Probe an Azure DevOps REST endpoint live with the real PAT and print its status
  code and actual response shape. Use BEFORE writing or trusting any REST client
  code, when a test mocks fetch and you need to know the endpoint is real, when a
  response shape came from an MCP tool, or when a call fails and you need to see
  what the API really returns.
---

# Probe Endpoint

Hit the endpoint. Read what comes back. Then write the client.

## Why

`fetchPRDiff` was written against `git/repositories/{id}/pullrequests/{prId}/changes`.
**That endpoint does not exist, and Azure DevOps serves no unified diffs at all.** The
`{files:[{path,patch}]}` shape it expected is real — but it is *composed by the MCP
server*, not served by REST.

The test replaced `globalThis.fetch`, pinned the wrong URL, and hand-wrote the
response body. It passed. Nine reviews passed it. One review certified it had
"verified endpoint discrimination by construction" — which proved two tests could not
cross-match, not that either endpoint existed.

It failed closed: the throw was caught, routing fell back to the expensive path with
the plausible-but-false reason "source PR not found in this repository", and that was
persisted to the database. A live run would have read as "nothing matched", not
"broken".

**A mocked fetch confirms your own request against your own imagined response.** One
live probe costs seconds.

## How

The PAT is in `.env` as `AZURE_DEVOPS_PAT`. Bun auto-loads `.env`, so:

```bash
bun -e '
const pat = process.env.AZURE_DEVOPS_PAT;
const url = "https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repoId>/<PATH>?api-version=7.0";
const r = await fetch(url, { headers: { Authorization: "Basic " + btoa(":" + pat) } });
console.log("STATUS", r.status, r.statusText);
const body = await r.text();
console.log(body.slice(0, 1200));
'
```

Report the status code and the real top-level keys — not a summary. If it is 404, say
so plainly; that is the finding.

## Rules

- **Never** paste the PAT into a file, a commit, or the transcript. Read it from the
  environment only.
- Probe **GET** endpoints freely. Do not probe POST/PATCH/PUT/DELETE against live
  data to "see what happens" — those write. Confirm with the user first.
- Paste the real status and shape into whatever report or test you are writing. A
  probe nobody recorded gets re-litigated later.
- Treat a hand-written mock response as a *shape assumption to be verified*, never as
  evidence of the contract.
- Be most suspicious when the expected shape came from an **MCP tool** — MCP servers
  compose responses from several upstream calls, and that shape usually has no single
  REST equivalent.

## Known Azure DevOps facts (measured, not assumed)

- `/pullrequests/{id}/changes` — **does not exist.**
- `/pullrequests/{id}/iterations` — exists; last entry carries `commonRefCommit`
  (merge base) and `sourceRefCommit` (head).
- `refs/pull/*` is retained only while a PR is **OPEN**. Completed PRs have no entry.
- **Active** PR diff → `git diff <commonRefCommit> <sourceRefCommit>`.
- **Completed** PR diff → `git diff <lastMergeTargetCommit> <lastMergeCommit>`; both
  present 40/40 measured, and `lastMergeTargetCommit` is the first parent of
  `lastMergeCommit` 40/40, so the base cannot silently widen.
- **Abandoned** PR → 0/40 have a `lastMergeCommit`.
- A PR completed with `deleteSourceBranch: true` has **no source branch** — anything
  that checks one out fails for every completed PR.
