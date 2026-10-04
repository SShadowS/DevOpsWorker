# Sourced by entrypoint.sh. Git helpers for the companion repo cache on the shared
# state volume (/state/repos), which every spawned container uses at once.

MAX_RETRIES=5

# Retries with a doubling delay. The delay is local: it used to be a script-wide
# variable that kept doubling across calls, so a second failing companion started
# at 240s and a container could wait an hour.
retry_git() {
  local attempt delay=${GIT_RETRY_DELAY:-15}
  for attempt in $(seq 1 "${MAX_RETRIES}"); do
    if "$@"; then
      return 0
    fi
    if [ "${attempt}" -lt "${MAX_RETRIES}" ]; then
      echo "Git operation failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}s..."
      sleep "${delay}"
      delay=$((delay * 2))
    fi
  done
  echo "Git operation failed after ${MAX_RETRIES} attempts"
  return 1
}

# cache_companion NAME URL BRANCH ROOT — make ROOT/NAME a current clone of BRANCH.
#
# Holds an exclusive lock per companion (ROOT/.NAME.lock) for the whole clone or pull.
# Without it, containers starting together on a cold cache cloned and pulled the same
# folder at once and left a half-made repo that every later attempt failed on, so
# reviews silently ran without the companion's code. Read the cache under the same
# lock file, shared (`flock -s`), so a copy never sees a pull half-way through.
cache_companion() {
  local name=$1 url=$2 branch=$3 root=$4
  mkdir -p "${root}"
  (
    flock -w 1800 9 || { echo "WARNING: timed out waiting for the ${name} cache lock"; exit 1; }
    local dir="${root}/${name}"
    if [ -d "${dir}/.git" ]; then
      echo "Refreshing companion ${name}..."
      git -C "${dir}" pull --ff-only && exit 0
      echo "WARNING: pull failed for ${name}, re-cloning..."
    else
      echo "Cloning companion ${name} (branch: ${branch})..."
    fi
    # Clear a failed pull, or a half-made clone a killed container left behind;
    # git clone refuses a folder that exists and is not empty.
    rm -rf "${dir}"
    retry_git git clone --depth 1 --single-branch --branch "${branch}" "${url}" "${dir}"
  ) 9>"${root}/.${name}.lock"
}
