#!/bin/bash
# Mirror every entry of mirrors.json: first boot clones (--mirror), later runs fetch + prune.
# Content-free output: repo names and outcomes only; URLs are scrubbed from git's error text.
set -uo pipefail
MIRRORS_PATH="${MIRRORS_PATH:-/config/mirrors.json}"
MIRRORS_ROOT="${MIRRORS_ROOT:-/mirrors}"
err="$(mktemp)"
rc=0
scrub() { sed -E 's#[a-z]+://[^[:space:]]+#<url>#g' "$err" | tr '\n' ' ' | head -c 300; }
list="$(mktemp)"
if ! jq -r '.[] | [.name, .url] | @tsv' "$MIRRORS_PATH" > "$list" 2>"$err"; then
  echo "sync: cannot read mirrors.json: $(scrub)" >&2; rm -f "$list" "$err"; exit 1
fi
if [ ! -s "$list" ]; then
  echo "sync: mirrors.json lists no mirrors" >&2; rm -f "$list" "$err"; exit 1
fi
while IFS=$'\t' read -r name url; do
  [ -n "$name" ] || continue
  dest="$MIRRORS_ROOT/$name.git"
  if [ ! -d "$dest" ]; then
    echo "sync: cloning $name"
    rm -rf "$dest.tmp"
    if git clone --quiet --mirror -- "$url" "$dest.tmp" 2>"$err" && mv "$dest.tmp" "$dest"; then
      echo "sync: cloned $name"
    else
      echo "sync: clone failed $name: $(scrub)" >&2; rm -rf "$dest.tmp"; rc=1
    fi
  else
    find "$dest" -name '*.lock' -mmin +30 -delete 2>/dev/null || true
    if git -C "$dest" remote update --prune >/dev/null 2>"$err"; then
      echo "sync: updated $name"
    else
      echo "sync: update failed $name: $(scrub)" >&2; rc=1
    fi
  fi
done < "$list"
rm -f "$list"
rm -f "$err"
exit $rc
