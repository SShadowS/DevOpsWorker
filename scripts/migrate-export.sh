#!/usr/bin/env bash
#
# migrate-export.sh — Run on the SOURCE (Windows) host.
# Creates a migration bundle in ./migration-bundle/ ready to copy to the new host.
#
set -euo pipefail

BUNDLE_DIR="./migration-bundle"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "=== DevOpsWorker Migration Export ==="
echo "Timestamp: $TIMESTAMP"
echo ""

# 1. Create bundle directory
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# 2. Take a fresh DB dump
echo "[1/4] Taking fresh database dump..."
docker compose exec -T postgres pg_dump -U pipeline --clean --if-exists pipeline \
  | gzip > "$BUNDLE_DIR/pipeline-$TIMESTAMP.sql.gz"
echo "  → Saved pipeline-$TIMESTAMP.sql.gz ($(du -h "$BUNDLE_DIR/pipeline-$TIMESTAMP.sql.gz" | cut -f1))"

# 3. Export the state volume (session artifacts, cloned repos)
echo "[2/4] Exporting do-pipeline-state volume..."
if docker volume inspect do-pipeline-state >/dev/null 2>&1; then
  docker run --rm \
    -v do-pipeline-state:/data:ro \
    -v "$(pwd)/$BUNDLE_DIR":/backup \
    alpine tar czf /backup/do-pipeline-state.tar.gz -C /data .
  echo "  → Saved do-pipeline-state.tar.gz ($(du -h "$BUNDLE_DIR/do-pipeline-state.tar.gz" | cut -f1))"
else
  echo "  → Volume do-pipeline-state not found, skipping (watcher will recreate it)"
fi

# 4. Copy .env (contains secrets — handle with care)
echo "[3/4] Copying .env..."
if [ -f .env ]; then
  cp .env "$BUNDLE_DIR/.env"
  echo "  → Copied .env"
else
  echo "  → WARNING: No .env found — you'll need to create one on the target host"
fi

# 5. Write a manifest
echo "[4/4] Writing manifest..."
cat > "$BUNDLE_DIR/MANIFEST.txt" <<EOF
DevOpsWorker Migration Bundle
Created: $TIMESTAMP
Source: $(hostname) ($(uname -s))

Files:
  pipeline-$TIMESTAMP.sql.gz   — Full PostgreSQL dump (pg_dump --clean --if-exists)
  do-pipeline-state.tar.gz     — State volume snapshot (optional, watcher recreates)
  .env                         — Environment variables (secrets!)
  MANIFEST.txt                 — This file

To import on the target host, run:
  ./scripts/migrate-import.sh migration-bundle/
EOF
echo "  → Done"

echo ""
echo "=== Bundle ready at $BUNDLE_DIR/ ==="
echo ""
echo "Copy the repo + bundle to the target host:"
echo "  rsync -avz --exclude node_modules --exclude .git/objects \\"
echo "    . user@target-host:/opt/devopsworker/"
echo ""
echo "Or just the bundle:"
echo "  scp -r $BUNDLE_DIR user@target-host:/opt/devopsworker/migration-bundle/"
echo ""
echo "Then on the target host:"
echo "  cd /opt/devopsworker && ./scripts/migrate-import.sh migration-bundle/"
