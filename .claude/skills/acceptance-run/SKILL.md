---
name: acceptance-run
description: >-
  Run one real PR review in a spawned container in NO-POST mode, to verify review
  behaviour end-to-end before trusting it. Use when acceptance-testing a change to
  the PR reviewer, checking which review path a PR takes, or reproducing a review
  locally. Costs real money — picks the PR deliberately and checks it is reviewable
  BEFORE spending.
---

# Acceptance Run

One paid review, against the real container, writing nothing to the PR.

**This spends money — roughly $10-12 for a full review.** Never launch one to "see
what happens". Know what you are testing and what result would falsify it.

## Step 1 — Pick the PR, and check it is ACTIVE

Do this first. It is the step that gets skipped, and it wasted a run.

```
mcp__azureDevOps__list_pull_requests  repositoryId=<guid> pullRequestId=<id> status=all
```

Check two fields:

- **`status`** — `1` = active, `3` = completed, `2` = abandoned.
- **`completionOptions.deleteSourceBranch`** — if `true` and the PR is completed,
  **the source branch no longer exists.**

A completed PR whose branch was deleted **cannot exercise any path that checks out
the source branch**. It silently falls back to the full seven-agent review — the
fail-safe direction, so a broken path and a working one look identical, except the
broken one costs 3x. This exact trap burned a run on PR 52308.

**If you are testing the cherry-pick sanity path, you need an ACTIVE PR.** If only a
completed PR is available, say so and state that you are testing the fallback, not
the feature.

## Step 2 — Gather coordinates

From the repo registry (supplied by the overlay): `azureDevOps.repositoryId` (GUID),
`url`, `branch`, and `repoKey` — the **folder** name.

Note the registry key and the folder key are two different strings for the same repo
(the registry key is the lookup name; `repoKey` is the directory the clone lands in).
The container clones to `${SESSION_ROOT}/${REPO_KEY}`, using the folder key. Using the
registry key there produces a path that does not exist — and the failure is silent,
because the caller falls back rather than erroring.

Source and target branches come from the PR's `sourceRefName` / `targetRefName`.

## Step 3 — Run it

Mirrors the watcher's production dispatch (`buildDockerArgs` in `src/sdk/docker.ts`).
`PR_REVIEW_NO_POST=1` is checked twice — in the CLI and again before any write — so
nothing reaches the live PR.

```bash
#!/usr/bin/env bash
set -uo pipefail
export MSYS_NO_PATHCONV=1          # else MSYS2 rewrites /workspace, /state
export DOCKER_CONTEXT=desktop-linux # else Windows-container mode fails the run

VOL=pr-review-<PRID>-acceptance
docker volume rm -f "$VOL" >/dev/null 2>&1
docker volume create "$VOL" >/dev/null

# Host paths, from the environment — not hard-coded to one machine's layout.
# HOST_PRIVATE_DIR is the overlay mount source as the DOCKER DAEMON sees it, which
# on Docker Desktop is not the same string the shell uses; take it from .env.
WS="${CLAUDE_PROJECT_DIR:-$PWD}"
HOST_PRIVATE_DIR=$(grep -E '^HOST_PRIVATE_DIR=' "$WS/.env" | cut -d= -f2-)

docker run --rm --name "$VOL" \
  --network pipeline-net \
  -v do-pipeline-state:/state \
  -v "$VOL":/workspace \
  -v "$HOST_PRIVATE_DIR":/app/private:ro \
  --env-file "$WS/.env" \
  -e PRIVATE_DIR=/app/private \
  -e REPO_CONFIG=<registry-key> \
  -e "REPO_URL=<repo url>" \
  -e REPO_BRANCH=<default branch> \
  -e SESSION_ROOT=/workspace/session \
  -e PR_REVIEW_NO_POST=1 \
  devopsworker:latest \
  review-pr --pr-id <PRID> --repo-id <guid> \
    --source-branch "<sourceRef minus refs/heads/>" \
    --target-branch "<targetRef minus refs/heads/>"

echo "EXIT=$?"
docker volume rm -f "$VOL"
```

Run it in the background and watch the output file — a full review takes many minutes.

Gotchas that have each cost a run:
- `--env-file` needs a path the **host** docker CLI can open. `MSYS_NO_PATHCONV=1`
  correctly leaves container-side paths alone but does not translate the host side, so
  a POSIX-style path from Git Bash on Windows will not resolve. A wrong path exits 125
  (docker-CLI level — nothing was spent).
- The overlay mount must be set or the repo registry is empty and the key will not
  resolve.
- Rebuild first if `devopsworker:latest` predates HEAD, or you are testing old code.

## Step 4 — Read the result, and kill early if it is not testing anything

Watch the routing line as soon as it appears:

```
[backport] sanity path — ported from !NNNNN     <- detection fired
[backport] checkout of refs/heads/... failed, using the full review: ...   <- FELL BACK
```

**A sanity-path line followed by a checkout failure means the run is now doing the
expensive full review and is no longer testing the feature.** Kill it rather than pay:

```bash
docker stop pr-review-<PRID>-acceptance
```

A killed container writes no `pr_reviews` row, so the baseline stays clean.

Then check what was recorded:

```sql
SELECT id, pr_id, review_path, recommendation, findings_count, cost_usd, turns, error
FROM pr_reviews WHERE pr_id = <PRID> ORDER BY id DESC LIMIT 3;
```

- `review_path` tells you which route the review actually took.
- Compare `cost_usd` / `turns` / `findings_count` against the prior row for the same
  PR — that is the real before/after.
- A null-telemetry row with `error_max_turns` means the turn budget was missed, not
  that the agent found nothing.

## Rules

- Treat `DATABASE_URL` as pointing at real, shared data unless you have confirmed
  otherwise: inspect read-only, never write. In a deployment it is the production
  database, and a review row is real telemetry.
- Never run without `PR_REVIEW_NO_POST=1` unless the user explicitly asks to post.
- Report what actually happened, including a fallback or a kill. A green exit code
  proves the container ran, not that the feature worked.
