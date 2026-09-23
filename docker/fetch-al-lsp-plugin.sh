#!/usr/bin/env bash
set -euo pipefail

# fetch-al-lsp-plugin.sh — Fetch the AL LSP wrapper plugin at its NEWEST release.
#
# Usage: ./fetch-al-lsp-plugin.sh <cache-dir>
#
# Tracks the newest release on purpose: every container start resolves the highest
# v* tag and moves the cache to it, so a new plugin release reaches production
# without an image rebuild. Releases, not the default branch, because a release is
# what carries the signed wrapper. AL_LSP_PLUGIN_REF pins a specific commit instead
# (for tests, or to hold back a bad release).
#
# The price, known and accepted: a broken release reaches every container on its
# next start. The move itself is still safe — the new clone is staged, verified
# against the resolved commit and swapped in under a lock, so a failed fetch leaves
# the working copy in place rather than a half-updated one.

CACHE_DIR="${1:?Usage: fetch-al-lsp-plugin.sh <cache-dir>}"
REPO_URL="https://github.com/SShadowS/claude-code-lsps.git"
PLUGIN_DIR="${CACHE_DIR}/al-lsp-plugin"
LOCK_FILE="${CACHE_DIR}/.al-lsp-plugin.lock"
LOCK_DIR="${LOCK_FILE}.d"

mkdir -p "${CACHE_DIR}"

# The commit behind the highest v* tag. An annotated tag lists twice in ls-remote —
# its own object, and `^{}` for the commit it points to — and only the commit can
# match HEAD after checkout, so take the peeled sha whenever there is one.
newest_release() {
  git ls-remote --tags "${REPO_URL}" 'v*' 2>/dev/null | awk '
    { name = $2; sub(/^refs\/tags\//, "", name)
      if (name ~ /\^\{\}$/) { sub(/\^\{\}$/, "", name); peeled[name] = $1 } else { plain[name] = $1 } }
    END { for (n in plain) print n, (n in peeled ? peeled[n] : plain[n]) }'     | sort -V | tail -n 1 | awk '{ print $2 }'
}

if [ -n "${AL_LSP_PLUGIN_REF:-}" ]; then
  PLUGIN_REF="${AL_LSP_PLUGIN_REF}"
else
  PLUGIN_REF="$(newest_release || true)"
  if [ -z "${PLUGIN_REF}" ]; then
    # GitHub unreachable: a working plugin already in the cache is better than none.
    if [ -d "${PLUGIN_DIR}/.git" ]; then
      echo "WARNING: cannot list AL LSP plugin releases; keeping the cached plugin at $(git -C "${PLUGIN_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
      exit 0
    fi
    echo "ERROR: cannot list AL LSP plugin releases and no plugin is cached"
    exit 1
  fi
fi

at_pin() {
  [ -d "${PLUGIN_DIR}/.git" ] || return 1
  local current
  current="$(git -C "${PLUGIN_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
  [ "${current}" = "${PLUGIN_REF}" ]
}

# --- Cleanup, armed for the whole script. Safe to call at any point: STAGING
# and USE_MKDIR_LOCK are only ever non-empty/1 once the corresponding
# resource actually exists, so an exit before that point is a no-op here. ---
STAGING=""
USE_MKDIR_LOCK=0
cleanup() {
  [ -n "${STAGING}" ] && rm -rf "${STAGING}"
  if [ "${USE_MKDIR_LOCK}" = "1" ]; then
    rmdir "${LOCK_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Fast path (unlocked): the existing clone is already at the resolved ref.
# No clone and no lock — only the one `ls-remote` above. This must stay the
# common case: every start between releases hits it and returns at once. ---
if at_pin; then
  echo "AL LSP plugin already at ${PLUGIN_REF}"
  exit 0
fi

# --- Take an exclusive lock before touching anything on the shared cache
# volume. A pin bump is exactly the moment every container on the fleet
# fails the fast path above at once; without this, two containers racing
# the swap can interleave — the loser's `mv` of an already-moved path
# aborts the container under `set -e`, or a `[ -d ]` check goes stale
# between processes and staging ends up moved inside a directory another
# container just recreated. The lock covers everything from here through
# the swap and the old-directory removal. It lives in CACHE_DIR, not inside
# PLUGIN_DIR — PLUGIN_DIR itself gets renamed away and back during the
# swap, so a lock file inside it would move out from under the flock.
#
# Prefer flock (a real kernel lock: blocks efficiently, auto-releases if the
# holder crashes) — it ships in the production image (util-linux, verified
# present in debian:bookworm-slim, the base this runs in). Where it is not
# available — Git Bash/MSYS2 on Windows, used to run this script's tests
# locally, has no flock — fall back to an mkdir-based mutex. mkdir is
# atomic on any POSIX filesystem: of N concurrent `mkdir` calls on the same
# path, exactly one succeeds, so polling it gives the same single-winner
# guarantee flock gives, just without kernel-assisted blocking or automatic
# release on crash (hence the bounded wait below and the rmdir in cleanup).
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock -x 9
else
  USE_MKDIR_LOCK=1
  attempts=0
  until mkdir "${LOCK_DIR}" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge 300 ]; then
      echo "ERROR: timed out waiting for the AL LSP plugin lock (${LOCK_DIR})"
      exit 1
    fi
    sleep 0.2
  done
fi

# --- Re-check under the lock: another container may have already staged
# and swapped in the pin while we were waiting for it. This is what makes a
# fleet-wide pin bump cost exactly one clone instead of one per container. ---
if at_pin; then
  echo "AL LSP plugin already at ${PLUGIN_REF} (pinned by a concurrent container)"
  exit 0
fi

# --- Stage a fresh clone, verify, then swap. Never touch the existing
# directory in place. ---
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
# exactly on the pin, and only then swap staging into place.
#
# The lock above guarantees this: only one invocation of this script is ever
# inside this section at a time, so no two containers' swaps can interleave
# — no loser `mv`-ing a path the winner already moved away, no staging
# directory ending up nested inside a directory the winner just recreated.
# It does NOT make PLUGIN_DIR look atomic to an unrelated reader that isn't
# calling this script (an already-running container just reading files under
# AL_LSP_DIR, say) — PLUGIN_DIR is genuinely absent for the instant between
# the two `mv`s below, lock or no lock. That gap is inherent to a
# rename-based swap; the lock's job is only to keep concurrent *writers*
# from corrupting each other, not to hide the rename from readers.
STAGING="$(mktemp -d "${CACHE_DIR}/.al-lsp-staging-XXXXXX")"

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
# possible. STAGING and PLUGIN_DIR are always distinct paths, so cleanup's
# `rm -rf "${STAGING}"` can never remove the live plugin directory — by the
# time we get here STAGING has already been moved (mv), so that rm -rf is a
# no-op against a path that no longer exists. ---
OLD_DIR="${PLUGIN_DIR}.old.$$"
if [ -d "${PLUGIN_DIR}" ]; then
  mv "${PLUGIN_DIR}" "${OLD_DIR}"
fi
mv "${STAGING}" "${PLUGIN_DIR}"
STAGING=""
rm -rf "${OLD_DIR}"

echo "AL LSP plugin pinned at ${PLUGIN_REF}"
