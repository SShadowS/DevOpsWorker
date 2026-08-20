#!/usr/bin/env bash
set -euo pipefail

# fetch-al-lsp-plugin.sh — Fetch the AL LSP wrapper plugin at a PINNED ref.
#
# Usage: ./fetch-al-lsp-plugin.sh <cache-dir>
#
# The entrypoint previously cloned this repo's default branch and ran
# `git pull --ff-only 2>/dev/null || true` at every container start. That made
# plugin changes reach production the moment they merged — no image rebuild, no
# gate, no rollback — and made the clone a mutable directory that concurrent
# containers read while another was pulling into it.
#
# The default below is the SHA production was already running when it was
# pinned, so pinning changed no behaviour; it only stopped the drift. Bump it
# deliberately, as a reviewed change.

CACHE_DIR="${1:?Usage: fetch-al-lsp-plugin.sh <cache-dir>}"
REPO_URL="https://github.com/SShadowS/claude-code-lsps.git"
PLUGIN_REF="${AL_LSP_PLUGIN_REF:-5e1c8ec78c76fce5dc5d29a625f08ce69ef82ae2}"
PLUGIN_DIR="${CACHE_DIR}/al-lsp-plugin"

mkdir -p "${CACHE_DIR}"

# --- Fast path: the existing clone is already at the pin. No clone, no network. ---
# This must stay the common case: every container start after the first hits
# this and returns immediately.
if [ -d "${PLUGIN_DIR}/.git" ]; then
  CURRENT="$(git -C "${PLUGIN_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
  if [ "${CURRENT}" = "${PLUGIN_REF}" ]; then
    echo "AL LSP plugin already at ${PLUGIN_REF}"
    exit 0
  fi
fi

# --- Otherwise: stage a fresh clone, verify, then swap. Never touch the
# existing directory in place. ---
#
# The clone that used to sit at PLUGIN_DIR could be a shallow clone left by
# the old `git clone --depth 1` this script replaces. A shallow clone's
# `git fetch origin` does not deepen it, so `git checkout <older-sha>` against
# it fails with "fatal: unable to read tree" the moment the pin is not the
# clone's tip — which happens on every deliberate pin bump or rollback, the
# exact events pinning exists to enable. A corrupt or diverged clone has the
# same shape of problem: there is no way to repair it in place that can't
# itself fail under `set -e` and leave the directory wedged for every
# subsequent start.
#
# So we never fetch or checkout into PLUGIN_DIR. We clone fresh into a
# staging directory made with `mktemp -d` under CACHE_DIR (same filesystem,
# so the final move is a rename), check out the pin there, verify it landed
# exactly on the pin, and only then swap staging into place. A concurrent
# reader of PLUGIN_DIR always sees either the complete old clone or the
# complete new one, never a partial — the same ordering fetch-al-extension.sh
# uses for the VSIX payload.
STAGING="$(mktemp -d "${CACHE_DIR}/.al-lsp-staging-XXXXXX")"
cleanup_staging() { rm -rf "${STAGING}"; }
trap cleanup_staging EXIT

echo "Cloning AL LSP plugin at ${PLUGIN_REF}..."
git clone --quiet "${REPO_URL}" "${STAGING}"
git -C "${STAGING}" checkout --quiet --detach "${PLUGIN_REF}"

ACTUAL="$(git -C "${STAGING}" rev-parse HEAD)"
if [ "${ACTUAL}" != "${PLUGIN_REF}" ]; then
  echo "ERROR: staged AL LSP plugin is at ${ACTUAL}, expected ${PLUGIN_REF} —"
  echo "       refusing to install it. The existing cache is left untouched."
  exit 1
fi

# --- Swap in: verified staging replaces the live directory as late as
# possible. STAGING and PLUGIN_DIR are always distinct paths, so the trap's
# cleanup can never remove the live plugin directory — by the time we get
# here STAGING has already been moved (mv), so the trap's rm -rf is a no-op. ---
OLD_DIR="${PLUGIN_DIR}.old.$$"
if [ -d "${PLUGIN_DIR}" ]; then
  mv "${PLUGIN_DIR}" "${OLD_DIR}"
fi
mv "${STAGING}" "${PLUGIN_DIR}"
rm -rf "${OLD_DIR}"

echo "AL LSP plugin pinned at ${PLUGIN_REF}"
