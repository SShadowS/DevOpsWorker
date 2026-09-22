#!/bin/bash
# The PAT reaches git through GIT_CONFIG_* environment variables (git >= 2.31):
# never on a command line, never in a file on disk, never in a URL.
set -euo pipefail
n=0
add_cfg() { export "GIT_CONFIG_KEY_$n=$1" "GIT_CONFIG_VALUE_$n=$2"; n=$((n + 1)); }
if [ -n "${AZURE_DEVOPS_PAT:-}" ]; then
  add_cfg "http.https://dev.azure.com/.extraheader" \
    "AUTHORIZATION: Basic $(printf ':%s' "$(printf '%s' "$AZURE_DEVOPS_PAT" | tr -d '\r\n')" | base64 | tr -d '\n')"
fi
add_cfg "core.askPass" ""
add_cfg "credential.helper" ""
export GIT_CONFIG_COUNT=$n GIT_TERMINAL_PROMPT=0
MIRRORS_ROOT="${MIRRORS_ROOT:-/mirrors}"
SYNC_INTERVAL_SEC="${SYNC_INTERVAL_SEC:-900}"

# One writer: this loop is the only thing that ever fetches into the mirrors, so
# containers cloning from them concurrently need no locking.
( while true; do /usr/local/bin/sync.sh || echo "sync: cycle finished with errors, retrying in ${SYNC_INTERVAL_SEC}s" >&2; sleep "$SYNC_INTERVAL_SEC"; done ) &

# Read-only: receive-pack stays disabled, so nothing can push into a mirror.
exec git daemon --export-all --base-path="$MIRRORS_ROOT" --reuseaddr \
  --informative-errors --port=9418 --listen=0.0.0.0
