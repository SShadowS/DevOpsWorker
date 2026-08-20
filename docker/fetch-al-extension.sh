#!/usr/bin/env bash
set -euo pipefail

# fetch-al-extension.sh — Download the MS AL Language extension for the AL LSP wrapper.
# Caches on the state volume so only the first container run pays the download cost.
#
# Usage: ./fetch-al-extension.sh <cache-dir>
# Sets AL_EXTENSION_PATH env var via the exported environment.

CACHE_DIR="${1:?Usage: fetch-al-extension.sh <cache-dir>}"
EXTENSION_DIR="${CACHE_DIR}/al-extension"
VERSION_FILE="${EXTENSION_DIR}/.version"
PUBLISHER="ms-dynamics-smb"
EXTENSION="al"
LOCK_FILE="${CACHE_DIR}/.al-extension.lock"
LOCK_DIR="${LOCK_FILE}.d"

mkdir -p "${EXTENSION_DIR}"

# Validate that bin/linux/alc is the REAL native compiler (a self-contained ELF),
# not a corrupted stub. A stale/garbage alc on the shared state volume (e.g. a
# 252-byte self-exec shell wrapper) otherwise survives the version-marker cache
# skip and makes every compile hang in an infinite exec loop. ELF magic = 7f454c46.
is_real_alc() {
  local f="$1"
  [ -f "${f}" ] || return 1
  local magic
  magic=$(head -c 4 "${f}" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
  [ "${magic}" = "7f454c46" ]
}

# --- Resolve the version to install ---
#
# PINNED, deliberately. 18.0.2498801 is the last release whose VSIX ships
# extension/bin/linux/Microsoft.Dynamics.Nav.EditorServices.Host. 18.0.2668733
# (2026-08-19) removed the Linux and macOS payloads entirely — see the
# "Automatic .NET runtime acquisition" note in the extension changelog. Adopting
# "newest" is what took the pipeline down; do not restore it.
#
# This whole script is temporary: the language server moves to the NuGet
# toolchain (altool launchlspserver) and this file is deleted then.
TARGET_VERSION="${AL_EXTENSION_VERSION:-18.0.2498801}"
echo "AL extension: using pinned version ${TARGET_VERSION}"

# --- Check if already cached ---
# Re-extract when the version differs OR when the cached alc is corrupt — a
# matching version marker is NOT sufficient if the binary itself is garbage.
is_cached() {
  [ -f "${VERSION_FILE}" ] || return 1
  [ "$(cat "${VERSION_FILE}")" = "${TARGET_VERSION}" ] || return 1
  is_real_alc "${EXTENSION_DIR}/bin/linux/alc"
}

# --- Cleanup, armed for the whole script. Safe to call at any point: STAGING
# and USE_MKDIR_LOCK are only ever non-empty/1 once the corresponding
# resource actually exists, so an exit before that point is a no-op here. ---
STAGING=""
VSIX_FILE=""
USE_MKDIR_LOCK=0
cleanup() {
  [ -n "${STAGING}" ] && rm -rf "${STAGING}"
  [ -n "${VSIX_FILE}" ] && rm -f "${VSIX_FILE}"
  rm -rf /tmp/al-vsix-extract
  if [ "${USE_MKDIR_LOCK}" = "1" ]; then
    rmdir "${LOCK_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Fast path (unlocked): the existing cache is already at the target
# version with a real alc. No download, no network, no lock. This must stay
# the common case: every container start after the first hits this and
# returns immediately. ---
if is_cached; then
  echo "AL extension ${TARGET_VERSION} already cached"
  exit 0
fi

if [ -f "${VERSION_FILE}" ]; then
  CACHED_VERSION=$(cat "${VERSION_FILE}")
  if [ "${CACHED_VERSION}" = "${TARGET_VERSION}" ]; then
    echo "WARNING: cached AL extension ${TARGET_VERSION} has a corrupt alc (not an ELF binary) — re-extracting"
  else
    echo "Upgrading AL extension from ${CACHED_VERSION} to ${TARGET_VERSION}"
  fi
fi

# --- Take an exclusive lock before touching anything on the shared cache
# volume. A version bump is exactly the moment every container on the fleet
# fails the fast path above at once; without this, two containers racing the
# swap can nest one staged bin/ inside the other (bin/bin/…) instead of
# replacing it — see fetch-al-lsp-plugin.sh, which hit the identical race on
# its own swap. The lock covers everything from here through the download,
# the swap, and the old-directory removal. It lives in CACHE_DIR, not inside
# EXTENSION_DIR, so a lock file can never end up moved by the swap it is
# guarding.
#
# Prefer flock (a real kernel lock: blocks efficiently, auto-releases if the
# holder crashes) — it ships in the production image (util-linux, verified
# present in debian:bookworm-slim, the base this runs in). Where it is not
# available — Git Bash/MSYS2 on Windows, used to run this script's tests
# locally, has no flock — fall back to an mkdir-based mutex. mkdir is atomic
# on any POSIX filesystem: of N concurrent `mkdir` calls on the same path,
# exactly one succeeds, so polling it gives the same single-winner guarantee
# flock gives, just without kernel-assisted blocking or automatic release on
# crash (hence the bounded wait below and the rmdir in cleanup).
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock -x 9
else
  USE_MKDIR_LOCK=1
  attempts=0
  until mkdir "${LOCK_DIR}" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge 300 ]; then
      echo "ERROR: timed out waiting for the AL extension lock (${LOCK_DIR})"
      exit 1
    fi
    sleep 0.2
  done
fi

# --- Re-check under the lock: another container may have already staged and
# swapped in this version while we were waiting for it. This is what makes a
# fleet-wide version bump cost exactly one download instead of one per
# container. ---
if is_cached; then
  echo "AL extension ${TARGET_VERSION} already cached (installed by a concurrent container)"
  exit 0
fi

# --- Download VSIX ---
VSIX_URL="https://${PUBLISHER}.gallery.vsassets.io/_apis/public/gallery/publisher/${PUBLISHER}/extension/${EXTENSION}/${TARGET_VERSION}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_FILE="/tmp/al-extension.vsix"

echo "Downloading AL extension v${TARGET_VERSION}..."
curl -sS -L --connect-timeout 15 --max-time 300 \
  -o "${VSIX_FILE}" "${VSIX_URL}" || {
  echo "WARNING: Failed to download AL extension — AL LSP will run without extension"
  exit 0
}

# --- Extract only the bin directory (saves space — skip dist/, node_modules/, etc.) ---
echo "Extracting AL extension..."
# --- Extract to a STAGING dir; the live cache is never touched until verified ---
#
# The original deleted ${EXTENSION_DIR}/bin before extracting. When 18.0.2668733
# shipped a Windows-only payload, that delete removed the working Linux server
# out from under live containers reading the same /state volume, and the
# post-extract check could only warn about a cache it had already destroyed.
#
# STAGING is assigned into the variable the cleanup trap (armed above,
# alongside the lock) already watches — a second `trap ... EXIT` here would
# silently replace that handler and drop the lock release, so this reuses it
# instead of declaring its own.
STAGING="$(mktemp -d "${CACHE_DIR}/.al-ext-staging-XXXXXX")"

rm -rf /tmp/al-vsix-extract
unzip -q -o "${VSIX_FILE}" "extension/bin/*" -d /tmp/al-vsix-extract || {
  echo "ERROR: failed to extract AL extension VSIX"
  exit 1
}
mv /tmp/al-vsix-extract/extension/bin "${STAGING}/bin"

# --- Verify the STAGED payload before it can replace anything ---
STAGED_HOST="${STAGING}/bin/linux/Microsoft.Dynamics.Nav.EditorServices.Host"
if ! is_real_alc "${STAGED_HOST}"; then
  echo "ERROR: ${TARGET_VERSION} has no Linux language server at bin/linux/ —"
  echo "       refusing to install it. The existing cache is left untouched."
  exit 1
fi
if ! is_real_alc "${STAGING}/bin/linux/alc"; then
  echo "ERROR: ${TARGET_VERSION} has no valid Linux alc — refusing to install it."
  exit 1
fi
chmod +x "${STAGED_HOST}" "${STAGING}/bin/linux/alc"

# --- Swap in: verified payload replaces the live one as late as possible ---
OLD_BIN="${EXTENSION_DIR}/bin.old.$$"
if [ -d "${EXTENSION_DIR}/bin" ]; then
  mv "${EXTENSION_DIR}/bin" "${OLD_BIN}"
fi
mv "${STAGING}/bin" "${EXTENSION_DIR}/bin"
rm -rf "${OLD_BIN}"

echo "${TARGET_VERSION}" > "${VERSION_FILE}"
echo "AL extension v${TARGET_VERSION} installed to ${EXTENSION_DIR}"
