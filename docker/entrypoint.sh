#!/usr/bin/env bash
set -euo pipefail

# --- Validate required env vars ---
: "${AZURE_DEVOPS_PAT:?AZURE_DEVOPS_PAT is required}"
: "${REPO_CONFIG:?REPO_CONFIG is required}"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: Either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set"
  exit 1
fi

# --- Configure git credentials for Azure DevOps ---
git config --global credential.helper '!f() { echo "username=pat"; echo "password=${AZURE_DEVOPS_PAT}"; }; f'
# user.name stays "DevOpsWorker" so AI commits are distinguishable from human ones in git log / ADO.
# user.email must be a Ninja-authorized address — the AL Object ID Ninja backend validates
# `git config user.email` against the app pool's allowlist (403 USER_NOT_AUTHORIZED otherwise).
# Set GIT_USER_EMAIL per deployment (the neutral default below is intentionally invalid so a
# missing override fails loudly at Ninja); a deploy overlay may also set it via /entrypoint.d.
git config --global user.name "${GIT_USER_NAME:-DevOpsWorker}"
git config --global user.email "${GIT_USER_EMAIL:-devopsworker@example.invalid}"

# --- Configure Azure CLI auth ---
export AZURE_DEVOPS_EXT_PAT="${AZURE_DEVOPS_PAT}"

# Environment-tool backend (ENV_CLI) is wired by a deployment overlay via
# /entrypoint.d/*.sh (sourced below), not by this generic base entrypoint.

# --- Retry helper for transient network issues ---
MAX_RETRIES=5
RETRY_DELAY=15

retry_git() {
  local attempt
  for attempt in $(seq 1 "${MAX_RETRIES}"); do
    if "$@"; then
      return 0
    fi
    if [ "${attempt}" -lt "${MAX_RETRIES}" ]; then
      echo "Git operation failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY}s..."
      sleep "${RETRY_DELAY}"
      RETRY_DELAY=$((RETRY_DELAY * 2))
    fi
  done
  echo "Git operation failed after ${MAX_RETRIES} attempts"
  return 1
}

# --- Resolve workspace layout from config ---
SESSION_ROOT="/workspace/session"
export SESSION_ROOT
mkdir -p "${SESSION_ROOT}"

# Pre-mark all directories as safe (needed before clone/pull operations)
git config --global --add safe.directory '*'

# --- Phase 1: initial resolve (need repoKey + appRoot before we can read app.json) ---
INITIAL_INFO=$(cd /app && bun scripts/resolve-companions.ts "${REPO_CONFIG}" 2>&1) || {
  echo "ERROR: Failed to resolve companions: ${INITIAL_INFO}"
  exit 1
}
REPO_KEY=$(echo "${INITIAL_INFO}" | jq -r '.repoKey')
APP_ROOT=$(echo "${INITIAL_INFO}" | jq -r '.appRoot')
MAIN_REPO_DIR="${SESSION_ROOT}/${REPO_KEY}"

# --- Phase 2: clone or refresh main repo ---
if [ ! -d "${MAIN_REPO_DIR}/.git" ]; then
  echo "Cloning main repo (${REPO_KEY})..."
  retry_git git clone --branch "${REPO_BRANCH:-master}" "${REPO_URL}" "${MAIN_REPO_DIR}"
else
  echo "Refreshing main repo (${REPO_KEY})..."
  cd "${MAIN_REPO_DIR}" && retry_git git fetch origin && cd /app
fi

# NOTE: app.json Windows backslash path normalization (the "Specified part does not exist in
# the package" Linux publish bug) may be handled by the environment CLI / build pipeline during
# compile/deploy. A generic compat workaround for any remaining literal-backslash paths follows
# below (the AL1001 symlink step).

# --- Phase 3: read source app.json platform for BC companion derivation ---
APP_JSON="${MAIN_REPO_DIR}/${APP_ROOT}/app.json"
BC_PLATFORM=""
if [ -f "${APP_JSON}" ]; then
  BC_PLATFORM=$(jq -r '.platform // empty' "${APP_JSON}" 2>/dev/null || echo "")
fi

# --- Phase 4: refined companion resolution with BC branch derived from platform ---
# Capture pre-platform BC branch so we can detect whether --bc-platform actually changed the answer.
INITIAL_BC_BRANCH=$(echo "${INITIAL_INFO}" | jq -r '.companions[] | select(.name == "BC") | .branch' 2>/dev/null || echo "")

if [ -n "${BC_PLATFORM}" ]; then
  REPO_INFO=$(cd /app && bun scripts/resolve-companions.ts "${REPO_CONFIG}" --bc-platform "${BC_PLATFORM}" 2>&1) || {
    echo "ERROR: Failed to resolve companions with bc-platform: ${REPO_INFO}"
    exit 1
  }
else
  REPO_INFO="${INITIAL_INFO}"
fi

# Log the BC companion branch and its source for debuggability.
BC_BRANCH=$(echo "${REPO_INFO}" | jq -r '.companions[] | select(.name == "BC") | .branch' 2>/dev/null || echo "")
if [ -n "${BC_BRANCH}" ]; then
  if [ -z "${BC_PLATFORM}" ]; then
    BC_SOURCE="fallback to companion default (no platform found at ${APP_JSON})"
  elif [ "${BC_BRANCH}" = "${INITIAL_BC_BRANCH}" ]; then
    BC_SOURCE="explicit override in repos.ts (--bc-platform ${BC_PLATFORM} ignored)"
  else
    BC_SOURCE="derived from platform ${BC_PLATFORM}"
  fi
  echo "BC companion branch: ${BC_BRANCH} (${BC_SOURCE})"
fi

# --- Clone/cache and symlink companion repos ---
COMPANIONS=$(echo "${REPO_INFO}" | jq -c '.companions[]' 2>/dev/null)

if [ -n "${COMPANIONS}" ]; then
  echo "${COMPANIONS}" | while IFS= read -r comp; do
    COMP_NAME=$(echo "${comp}" | jq -r '.name')
    COMP_URL=$(echo "${comp}" | jq -r '.url')
    COMP_BRANCH=$(echo "${comp}" | jq -r '.branch')
    COMP_READONLY=$(echo "${comp}" | jq -r '.readOnly')
    COMP_SYMLINK_ONLY=$(echo "${comp}" | jq -r '.symlinkOnly')
    CACHE_DIR="/state/repos/${COMP_NAME}"
    SESSION_DIR="${SESSION_ROOT}/${COMP_NAME}"

    # Skip if already present (continue case)
    [ -L "${SESSION_DIR}" ] && continue
    [ -d "${SESSION_DIR}/.git" ] && continue

    # Cache: clone or pull
    if [ ! -d "${CACHE_DIR}/.git" ]; then
      echo "Cloning companion ${COMP_NAME} (branch: ${COMP_BRANCH})..."
      mkdir -p "/state/repos"
      retry_git git clone --depth 1 --single-branch --branch "${COMP_BRANCH}" "${COMP_URL}" "${CACHE_DIR}" || {
        echo "WARNING: Failed to clone ${COMP_NAME} — skipping"
        continue
      }
    else
      echo "Refreshing companion ${COMP_NAME}..."
      cd "${CACHE_DIR}"
      git pull --ff-only || {
        echo "WARNING: pull failed for ${COMP_NAME}, re-cloning..."
        cd /app
        rm -rf "${CACHE_DIR}"
        retry_git git clone --depth 1 --single-branch --branch "${COMP_BRANCH}" "${COMP_URL}" "${CACHE_DIR}" || {
          echo "WARNING: Failed to re-clone ${COMP_NAME} — skipping"
          continue
        }
      }
      cd /app
    fi

    # Stage into the session workspace.
    # symlinkOnly companions (huge + LSP-covered as a dependency, e.g. the BC code-
    # history mirror) are SYMLINKED from cache — zero copy, and agents never file-
    # search them. Everything else gets a real local clone so the agents' Grep/Glob
    # can actually search the source — those tools SKIP symlinked directories, so a
    # symlinked companion is invisible to them (this is why non-dependency companions
    # like DocumentCapture were unsearchable).
    if [ "${COMP_SYMLINK_ONLY}" = "true" ]; then
      echo "Symlink (symlinkOnly) companion ${COMP_NAME}..."
      ln -sf "${CACHE_DIR}" "${SESSION_DIR}"
    else
      echo "Local clone for companion ${COMP_NAME} (real, searchable dir)..."
      git clone --local "${CACHE_DIR}" "${SESSION_DIR}"
    fi
  done
fi

# safe.directory '*' already covers all repos

# --- HACK: AL1001 backslash-path workaround --------------------------------
# AL Compiler 18.0.35.20 on Linux does NOT normalize Windows path separators
# in app.json string fields (e.g. "logo": "Images\\Logo.png"). It looks for a
# literal file named `Images\Logo.png` and fails AL1001 when only `Images/Logo.png`
# exists. Until the AL toolchain or a build-pipeline preprocess step is fixed,
# create compat symlinks so the literal-backslash filenames resolve to the real files.
# TODO: remove this once a proper fix lands (newer AL compiler, build-pipeline
#       preprocessing, or repo migration to forward slashes).
echo "Creating AL backslash-path compat symlinks (workaround for AL1001)..."
find "${SESSION_ROOT}" -maxdepth 5 -name "app.json" -type f 2>/dev/null | while read -r app_json; do
  app_dir=$(dirname "$app_json")
  jq -r '.. | strings | select(test("\\\\"))' "$app_json" 2>/dev/null | while read -r bs_path; do
    fwd_path=$(echo "$bs_path" | tr '\\' '/')
    [ -e "${app_dir}/${fwd_path}" ] || continue
    [ -e "${app_dir}/${bs_path}" ] && continue
    ( cd "$app_dir" && ln -s "$fwd_path" "$bs_path" 2>/dev/null )
  done
done

# --- Set state directory ---
export STATE_DIR="/state/state"
mkdir -p "${STATE_DIR}"
mkdir -p "/state/logs"
mkdir -p "/state/actions"

# --- Fetch AL VSCode extension (cached on state volume) ---
AL_TOOLS_DIR="/state/tools"
mkdir -p "${AL_TOOLS_DIR}"
# AL extension fetch is an optional cache refresh — never let it abort the container
# (it has its own graceful exits, but guard here too against any unhandled failure).
/fetch-al-extension.sh "${AL_TOOLS_DIR}" || echo "WARNING: AL extension fetch failed (non-fatal) — using cached extension if present"
AL_EXT_DIR="${AL_TOOLS_DIR}/al-extension"
# Keep AL_EXTENSION_PATH for the AL LSP server (the language host still comes from
# the VSIX). The AL COMPILER (alc) is no longer taken from the VSIX — the Continia
# CLI provisions it from NuGet (self-contained .Tools.Linux) and caches it under
# CONTINIA_ALC_CACHE. So we do NOT build the `al`→`alc` shim or put the VSIX bin on
# PATH anymore (that path's alc was the source of an infinite-exec-loop hang).
if [ -d "${AL_EXT_DIR}/bin/linux" ]; then
  export AL_EXTENSION_PATH="${AL_EXT_DIR}"
fi

# Where the Continia CLI caches the NuGet-provisioned alc (persisted on the state
# volume so only the first compile pays the ~60MB download).
export CONTINIA_ALC_CACHE="${AL_TOOLS_DIR}/alc"

# --- Fetch AL LSP plugin (cached on state volume) ---
# The SDK resolveAlLspPlugin() reads AL_LSP_DIR to find the plugin binary.
# We shallow-clone the marketplace repo and point AL_LSP_DIR at the plugin directory.
AL_LSP_CACHE="${AL_TOOLS_DIR}/al-lsp-plugin"
AL_LSP_PLUGIN_DIR="${AL_LSP_CACHE}/al-language-server-go-linux"
if [ ! -d "${AL_LSP_CACHE}/.git" ]; then
  echo "Cloning AL LSP plugin..."
  git clone --depth 1 https://github.com/SShadowS/claude-code-lsps.git "${AL_LSP_CACHE}" || {
    echo "WARNING: Could not clone AL LSP plugin — agents will run without LSP"
  }
else
  echo "Updating AL LSP plugin..."
  cd "${AL_LSP_CACHE}" && git pull --ff-only 2>/dev/null || true && cd /app
fi
if [ -d "${AL_LSP_PLUGIN_DIR}" ]; then
  # resolveAlLspPlugin() expects: AL_LSP_DIR/<version>/ with plugin.json inside
  # The repo has: al-language-server-go-linux/plugin.json — read version and create version dir
  PLUGIN_VERSION=$(jq -r '.version // "0.0.0"' "${AL_LSP_PLUGIN_DIR}/plugin.json" 2>/dev/null || echo "0.0.0")
  AL_LSP_VERSIONED="${AL_LSP_PLUGIN_DIR}/${PLUGIN_VERSION}"
  if [ ! -d "${AL_LSP_VERSIONED}" ]; then
    # Create version directory with symlinks to plugin contents
    # NOTE: must include dotfiles (.lsp.json is required by Claude Code to register LSP tools)
    mkdir -p "${AL_LSP_VERSIONED}"
    ls -A "${AL_LSP_PLUGIN_DIR}" | while read -r base; do
      [ "$base" = "${PLUGIN_VERSION}" ] && continue
      ln -sf "${AL_LSP_PLUGIN_DIR}/$base" "${AL_LSP_VERSIONED}/$base"
    done
  fi
  export AL_LSP_DIR="${AL_LSP_PLUGIN_DIR}"
  echo "AL LSP plugin v${PLUGIN_VERSION} available at ${AL_LSP_DIR}"

  # Make Go binary executable
  chmod +x "${AL_LSP_PLUGIN_DIR}/bin/al-language-server" 2>/dev/null || true
fi

# NOTE: production no longer applies Claude Code binary patches. The A/B framework
# (run-inner.ts → applyPatchPreset) can still patch the SDK binary via tweakcc for
# experiments, but in-binary tool-description steering was measured to REDUCE LSP
# usage, and the workspaceSymbol query bug it once fixed is now fixed upstream. The
# old cli.js patcher is also dead on CLI v2 (no cli.js). See memory: tweakcc A/B finding.

# --- Deployment overlay hooks ---
# A deployment overlay image (built FROM this base) drops scripts into
# /entrypoint.d/ to wire its environment-tool backend — e.g.
# `export ENV_CLI=...`, set a Ninja-authorized git email, etc. Sourced (not exec'd)
# so exports reach the pipeline process below. The generic base ships none.
#
# Hook contract: each hook is sourced into THIS `set -euo pipefail` shell, so it must
# be -e-safe (append `|| true` to any fallible command) and must NOT call `exit`
# (that kills the container) — use `return` to bail out early.
if [ -d /entrypoint.d ]; then
  shopt -s nullglob          # empty dir → loop body runs zero times, not once on a literal glob
  for hook in /entrypoint.d/*.sh; do
    [ -r "${hook}" ] && . "${hook}"
  done
  shopt -u nullglob
fi

# --- Run as root (IS_SANDBOX=1 allows --dangerously-skip-permissions) ---
COMMAND="${1:-run}"
shift || true

cd /app
exec bun run src/cli/index.ts "${COMMAND}" "$@"
