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

if [ ! -d "${PLUGIN_DIR}/.git" ]; then
  echo "Cloning AL LSP plugin at ${PLUGIN_REF}..."
  rm -rf "${PLUGIN_DIR}"
  git clone --quiet "${REPO_URL}" "${PLUGIN_DIR}"
fi

CURRENT="$(git -C "${PLUGIN_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
if [ "${CURRENT}" = "${PLUGIN_REF}" ]; then
  echo "AL LSP plugin already at ${PLUGIN_REF}"
  exit 0
fi

echo "Checking out AL LSP plugin ${PLUGIN_REF}..."
git -C "${PLUGIN_DIR}" fetch --quiet origin
git -C "${PLUGIN_DIR}" checkout --quiet --detach "${PLUGIN_REF}"

ACTUAL="$(git -C "${PLUGIN_DIR}" rev-parse HEAD)"
if [ "${ACTUAL}" != "${PLUGIN_REF}" ]; then
  echo "ERROR: AL LSP plugin is at ${ACTUAL}, expected ${PLUGIN_REF}"
  exit 1
fi
echo "AL LSP plugin pinned at ${PLUGIN_REF}"
