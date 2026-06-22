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

# --- Query marketplace for latest version ---
echo "Checking AL extension version..."
API_URL="https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
QUERY_BODY='{
  "filters": [{
    "criteria": [
      { "filterType": 7, "value": "ms-dynamics-smb.al" }
    ]
  }],
  "flags": 914
}'

RESPONSE=$(curl -sS --connect-timeout 15 --max-time 30 \
  -H "Content-Type: application/json" \
  -H "Accept: application/json;api-version=6.1-preview.1" \
  -d "${QUERY_BODY}" \
  "${API_URL}" 2>&1) || {
  echo "WARNING: Could not query VS Code Marketplace — AL LSP will run without extension"
  exit 0
}

# NOTE: jq is unguarded against non-JSON input. The marketplace occasionally
# returns HTML/empty/rate-limit bodies (curl exits 0 but body isn't JSON), which
# makes jq print "parse error: Invalid numeric literal" and exit nonzero. Under
# the entrypoint's `set -euo pipefail` that aborts the whole container (exit 4)
# even though a cached extension is already present. Route any jq failure into
# the existing empty-version graceful path instead.
LATEST_VERSION=$(echo "${RESPONSE}" | jq -r '.results[0].extensions[0].versions[0].version // empty' 2>/dev/null) || LATEST_VERSION=""
if [ -z "${LATEST_VERSION}" ]; then
  echo "WARNING: Could not determine latest AL extension version — AL LSP will use cached extension if present"
  exit 0
fi

echo "Latest AL extension version: ${LATEST_VERSION}"

# --- Check if already cached ---
# Re-extract when the version differs OR when the cached alc is corrupt — a
# matching version marker is NOT sufficient if the binary itself is garbage.
if [ -f "${VERSION_FILE}" ]; then
  CACHED_VERSION=$(cat "${VERSION_FILE}")
  if [ "${CACHED_VERSION}" = "${LATEST_VERSION}" ]; then
    if is_real_alc "${EXTENSION_DIR}/bin/linux/alc"; then
      echo "AL extension ${LATEST_VERSION} already cached"
      exit 0
    fi
    echo "WARNING: cached AL extension ${LATEST_VERSION} has a corrupt alc (not an ELF binary) — re-extracting"
  else
    echo "Upgrading AL extension from ${CACHED_VERSION} to ${LATEST_VERSION}"
  fi
fi

# --- Download VSIX ---
VSIX_URL="https://${PUBLISHER}.gallery.vsassets.io/_apis/public/gallery/publisher/${PUBLISHER}/extension/${EXTENSION}/${LATEST_VERSION}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage"
VSIX_FILE="/tmp/al-extension.vsix"

echo "Downloading AL extension v${LATEST_VERSION}..."
curl -sS -L --connect-timeout 15 --max-time 300 \
  -o "${VSIX_FILE}" "${VSIX_URL}" || {
  echo "WARNING: Failed to download AL extension — AL LSP will run without extension"
  exit 0
}

# --- Extract only the bin directory (saves space — skip dist/, node_modules/, etc.) ---
echo "Extracting AL extension..."
rm -rf "${EXTENSION_DIR}/bin" /tmp/al-vsix-extract
# VSIX contains files under extension/ prefix
unzip -q -o "${VSIX_FILE}" "extension/bin/*" -d "/tmp/al-vsix-extract" || {
  echo "WARNING: Failed to extract AL extension VSIX"
  rm -f "${VSIX_FILE}"
  exit 0
}

# Move bin/ to cache dir (strip the extension/ prefix)
mv /tmp/al-vsix-extract/extension/bin "${EXTENSION_DIR}/bin"
rm -rf /tmp/al-vsix-extract "${VSIX_FILE}"

# --- Verify and fix permissions ---
AL_BINARY="${EXTENSION_DIR}/bin/linux/Microsoft.Dynamics.Nav.EditorServices.Host"
if [ ! -f "${AL_BINARY}" ]; then
  echo "WARNING: AL Language Server binary not found after extraction"
  exit 0
fi
chmod +x "${AL_BINARY}"

# --- Verify + make the alc compiler executable (the VSIX ships it -x'd) ---
# Without this the CLI fails with EACCES posix_spawn; with a corrupt alc it would
# otherwise hang. Validate it is a real ELF and bail loud if the VSIX changed shape.
ALC_LINUX="${EXTENSION_DIR}/bin/linux/alc"
if is_real_alc "${ALC_LINUX}"; then
  chmod +x "${ALC_LINUX}"
  # --- Write version marker ---
  echo "${LATEST_VERSION}" > "${VERSION_FILE}"
  echo "AL extension v${LATEST_VERSION} installed to ${EXTENSION_DIR}"
else
  echo "WARNING: extracted alc is not a valid ELF binary at ${ALC_LINUX} — refusing to cache this version"
  rm -f "${ALC_LINUX}" "${VERSION_FILE}"
  exit 1
fi
