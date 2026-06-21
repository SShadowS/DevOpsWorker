#!/usr/bin/env bash
# Generates a PDF from docs/project-overview.md (with Mermaid diagram rendering).
# Uses mermaid-cli to pre-render diagrams, then md-to-pdf for the final PDF.
# Requires: npx (comes with Node/Bun). Chromium downloaded automatically on first run.
#
# Usage:
#   bash docs/generate-pdf.sh                    # output: docs/project-overview.pdf
#   bash docs/generate-pdf.sh my-output.pdf      # output: my-output.pdf

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$SCRIPT_DIR/project-overview.md"
OUTPUT="${1:-$SCRIPT_DIR/project-overview.pdf}"
TMP_DIR="$SCRIPT_DIR/.pdf-tmp"

if [ ! -f "$INPUT" ]; then
  echo "Error: $INPUT not found" >&2
  exit 1
fi

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

mkdir -p "$TMP_DIR"

# Step 1: Pre-render Mermaid diagrams → replaces ```mermaid blocks with image refs
echo "[1/3] Rendering Mermaid diagrams ..."
npx --yes @mermaid-js/mermaid-cli \
  -i "$INPUT" \
  -o "$TMP_DIR/processed.md" \
  -e svg \
  --quiet

# Step 2: Replace markdown image refs with HTML <img> tags that have constrained height
# This ensures diagrams fit on a single page in the PDF
echo "[2/3] Constraining diagram sizes ..."
sed -i 's|!\[diagram\](\(.*\.svg\))|<img src="\1" style="max-height:700px;width:auto;display:block;margin:1em auto;">|g' "$TMP_DIR/processed.md"

# Step 3: Convert processed markdown (with SVG images) to PDF
echo "[3/3] Converting to PDF ..."
npx --yes md-to-pdf "$TMP_DIR/processed.md" --config-file "$SCRIPT_DIR/pdf.config.js"

mv "$TMP_DIR/processed.pdf" "$OUTPUT"

echo "Done: $OUTPUT"
