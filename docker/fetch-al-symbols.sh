#!/usr/bin/env bash
set -euo pipefail

# fetch-al-symbols.sh — Cache the Microsoft Business Central symbol packages for one
# BC major, so the AL language server can resolve Base Application, System
# Application, Business Foundation and platform (System.app) symbols.
#
# Usage: ./fetch-al-symbols.sh <tools-dir> <app.json>
#
# Prints the cache directory (<tools-dir>/al-symbols/<major>) on stdout when it holds a
# complete set, and nothing otherwise. Every log line goes to stderr, so a caller can
# do `DIR=$(fetch-al-symbols.sh ...)` and export only on success.
#
# Review containers have no .alpackages, so without these the language server reports
# every base-app object (Vendor, Purchase Header, ...) as missing. Only the five w1
# packages of the one major the repo's app.json needs are kept: no country variants,
# no second minor, so the cache stays about 7 MB per major.
#
# The major comes from app.json "application", falling back to "platform"
# (28.0.0.0 -> 28). A newer minor of the same major satisfies it. When the feed has
# no packages for that major (BC 29 today) nothing is cached and nothing is printed —
# a different major would resolve against the wrong base app.

TOOLS_DIR="${1:?Usage: fetch-al-symbols.sh <tools-dir> <app.json>}"
APP_JSON="${2:?Usage: fetch-al-symbols.sh <tools-dir> <app.json>}"
# The public Microsoft feed (anonymous). PackageBaseAddress of
# https://dynamicssmb2.pkgs.visualstudio.com/DynamicsBCPublicFeeds/_packaging/MSSymbols/nuget/v3/index.json
FEED="${AL_SYMBOLS_FEED:-https://dynamicssmb2.pkgs.visualstudio.com/571e802d-b44b-45fc-bd41-4cfddec73b44/_packaging/b656b10c-3de0-440c-900c-bc2e4e86d84c/nuget/v3/flat2}"
MAX_AGE_MIN="${AL_SYMBOLS_MAX_AGE_MIN:-1440}"   # re-check the feed at most daily

PLATFORM_ID="microsoft.platform.symbols"
APP_IDS=(
  "microsoft.application.symbols"
  "microsoft.baseapplication.symbols.437dbf0e-84ff-417a-965d-ed2bb9650972"
  "microsoft.systemapplication.symbols.63ca2fa4-4f03-4f2b-a480-172fef340d3f"
  "microsoft.businessfoundation.symbols.f3552374-a1f2-4356-848e-196002525837"
)
EXPECTED_APPS=5

log() { echo "al-symbols: $*" >&2; }

if [ ! -f "${APP_JSON}" ]; then
  log "no app.json at ${APP_JSON}; skipping"
  exit 1
fi
VERSION_FIELD="$(jq -r '.application // .platform // empty' "${APP_JSON}" 2>/dev/null || true)"
MAJOR="${VERSION_FIELD%%.*}"
if ! [[ "${MAJOR}" =~ ^[0-9]+$ ]]; then
  log "app.json has no usable application/platform version ('${VERSION_FIELD}'); skipping"
  exit 1
fi

ROOT="${TOOLS_DIR}/al-symbols"
TARGET="${ROOT}/${MAJOR}"
MARKER="${TARGET}/.versions"
LOCK_FILE="${ROOT}/.lock-${MAJOR}"
LOCK_DIR="${LOCK_FILE}.d"
mkdir -p "${ROOT}"

complete() { [ -f "${MARKER}" ] && [ "$(find "${TARGET}" -maxdepth 1 -name '*.app' | wc -l)" -eq "${EXPECTED_APPS}" ]; }
fresh() { complete && [ -n "$(find "${MARKER}" -mmin "-${MAX_AGE_MIN}" 2>/dev/null)" ]; }

# --- Fast path (unlocked): a complete set checked within the last day. No network,
# no lock — the common case for every container start after the first. ---
if fresh; then
  echo "${TARGET}"
  exit 0
fi

STAGING=""
USE_MKDIR_LOCK=0
cleanup() {
  [ -n "${STAGING}" ] && rm -rf "${STAGING}"
  if [ "${USE_MKDIR_LOCK}" = "1" ]; then rmdir "${LOCK_DIR}" 2>/dev/null || true; fi
}
trap cleanup EXIT

# --- One writer per major. flock where available (the production image has it);
# an atomic-mkdir mutex elsewhere (Git Bash on Windows, for local test runs). ---
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock -x 9
else
  USE_MKDIR_LOCK=1
  attempts=0
  until mkdir "${LOCK_DIR}" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge 600 ]; then log "timed out waiting for ${LOCK_DIR}"; exit 1; fi
    sleep 0.2
  done
fi

# Another container may have filled or refreshed it while this one waited.
if fresh; then
  echo "${TARGET}"
  exit 0
fi

# A stale but complete set stays usable if the feed cannot be reached.
use_existing_or_fail() {
  if complete; then log "$1; keeping the existing ${MAJOR}.x set"; echo "${TARGET}"; exit 0; fi
  log "$1"; exit 1
}

# Newest version of a package whose number starts with the given prefix.
latest() {
  local id="$1" prefix="$2" json
  json="$(curl -fsS --max-time 60 "${FEED}/${id}/index.json")" || return 2
  printf '%s' "${json}" | jq -r --arg p "${prefix}" '.versions[] | select(startswith($p))' | sort -V | tail -n 1
}

# The platform carries only <major>.0.x; the four apps share one <major>.<minor>
# build, taken from Base Application so all four match.
PLATFORM_VER="$(latest "${PLATFORM_ID}" "${MAJOR}.0.")" || use_existing_or_fail "feed unreachable"
APP_VER="$(latest "${APP_IDS[1]}" "${MAJOR}.")" || use_existing_or_fail "feed unreachable"
if [ -z "${PLATFORM_VER}" ] || [ -z "${APP_VER}" ]; then
  log "the feed has no BC ${MAJOR} symbol packages; not caching another major"
  exit 1
fi

WANTED="${PLATFORM_ID} ${PLATFORM_VER}"
for id in "${APP_IDS[@]}"; do WANTED="${WANTED}"$'\n'"${id} ${APP_VER}"; done

# Same versions as last time: nothing to download, just record the check.
if complete && [ "$(cat "${MARKER}")" = "${WANTED}" ]; then
  touch "${MARKER}"
  echo "${TARGET}"
  exit 0
fi

# --- Stage the full set beside the target (same filesystem, so the final move is a
# rename), verify it, then swap it in. Readers never see a half-filled set. ---
STAGING="$(mktemp -d "${ROOT}/.staging-${MAJOR}-XXXXXX")"
chmod 755 "${STAGING}"   # mktemp -d makes it 0700; the set is read by whoever runs the LSP
while read -r id ver; do
  pkg="${STAGING}/pkg.nupkg"
  if ! curl -fsSL --max-time 300 -o "${pkg}" "${FEED}/${id}/${ver}/${id}.${ver}.nupkg"; then
    use_existing_or_fail "download failed: ${id} ${ver}"
  fi
  # Only the .app at the zip root; its name keeps the original spaces.
  unzip -q -j -o "${pkg}" '*.app' -d "${STAGING}"
  rm -f "${pkg}"
done <<< "${WANTED}"

count="$(find "${STAGING}" -maxdepth 1 -name '*.app' -size +0 | wc -l)"
if [ "${count}" -ne "${EXPECTED_APPS}" ]; then
  use_existing_or_fail "expected ${EXPECTED_APPS} .app files, got ${count}"
fi
printf '%s' "${WANTED}" > "${STAGING}/.versions"

OLD=""
if [ -e "${TARGET}" ]; then OLD="$(mktemp -d "${ROOT}/.old-${MAJOR}-XXXXXX")"; mv "${TARGET}" "${OLD}/"; fi
mv "${STAGING}" "${TARGET}"
STAGING=""
[ -n "${OLD}" ] && rm -rf "${OLD}"

log "cached BC ${MAJOR} symbols: platform ${PLATFORM_VER}, apps ${APP_VER}"
echo "${TARGET}"
