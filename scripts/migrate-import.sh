#!/usr/bin/env bash
#
# migrate-import.sh — Run on the TARGET (Ubuntu) host.
# Imports a migration bundle created by migrate-export.sh.
#
# Usage: ./scripts/migrate-import.sh [bundle-dir]
#        Default bundle-dir: ./migration-bundle/
#
set -euo pipefail

BUNDLE_DIR="${1:-./migration-bundle}"

echo "=== DevOpsWorker Migration Import ==="
echo "Bundle: $BUNDLE_DIR"
echo ""

# Validate bundle
if [ ! -d "$BUNDLE_DIR" ]; then
  echo "ERROR: Bundle directory not found: $BUNDLE_DIR"
  exit 1
fi

DB_DUMP=$(find "$BUNDLE_DIR" -name 'pipeline-*.sql.gz' -type f | head -1)
if [ -z "$DB_DUMP" ]; then
  echo "ERROR: No pipeline-*.sql.gz found in $BUNDLE_DIR"
  exit 1
fi

echo "Found DB dump: $DB_DUMP"
echo ""

# 1. Install .env if present in bundle and not already on target
echo "[1/6] Checking .env..."
if [ -f "$BUNDLE_DIR/.env" ] && [ ! -f .env ]; then
  cp "$BUNDLE_DIR/.env" .env
  echo "  → Installed .env from bundle"
elif [ -f .env ]; then
  echo "  → .env already exists, keeping current version"
  echo "    (bundle copy at $BUNDLE_DIR/.env if you need to compare)"
else
  echo "  → WARNING: No .env found. Create one before starting services."
  echo "    Required vars: AZURE_DEVOPS_PAT, CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)"
fi

# 2. Verify Docker is available
echo "[2/6] Verifying Docker..."
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running or not installed."
  echo "  Install: https://docs.docker.com/engine/install/ubuntu/"
  exit 1
fi
echo "  → Docker is available"

# 3. Build images
echo "[3/6] Building Docker images..."
docker build -t devopsworker:latest .
docker compose build
echo "  → Images built"

# 4. Start only PostgreSQL and wait for it to be healthy
echo "[4/6] Starting PostgreSQL..."
docker compose up -d postgres
echo "  Waiting for PostgreSQL to be healthy..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U pipeline >/dev/null 2>&1; then
    echo "  → PostgreSQL is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: PostgreSQL failed to start within 30 seconds"
    docker compose logs postgres
    exit 1
  fi
  sleep 1
done

# 5. Restore the database
echo "[5/6] Restoring database from $DB_DUMP..."
# The dump uses --clean --if-exists, so it drops and recreates objects safely.
# Pipe through gunzip → psql. Errors on DROP IF EXISTS for non-existent objects are normal.
gunzip -c "$DB_DUMP" | docker compose exec -T postgres psql -U pipeline -d pipeline \
  --quiet --no-psqlrc -v ON_ERROR_STOP=0 2>&1 | grep -v "does not exist, skipping" || true
echo "  → Database restored"

# Verify
ROW_COUNT=$(docker compose exec -T postgres psql -U pipeline -d pipeline -t -c \
  "SELECT count(*) FROM pipeline_state;" 2>/dev/null | tr -d ' ' || echo "0")
PR_COUNT=$(docker compose exec -T postgres psql -U pipeline -d pipeline -t -c \
  "SELECT count(*) FROM pr_reviews;" 2>/dev/null | tr -d ' ' || echo "0")
echo "  → Verified: $ROW_COUNT pipeline sessions, $PR_COUNT PR reviews"

# 6. Restore state volume (optional)
if [ -f "$BUNDLE_DIR/do-pipeline-state.tar.gz" ]; then
  echo "[6/6] Restoring do-pipeline-state volume..."
  docker volume create do-pipeline-state 2>/dev/null || true
  docker run --rm \
    -v do-pipeline-state:/data \
    -v "$(pwd)/$BUNDLE_DIR":/backup:ro \
    alpine sh -c "cd /data && tar xzf /backup/do-pipeline-state.tar.gz"
  echo "  → State volume restored"
else
  echo "[6/6] No state volume archive found, skipping (watcher will create on first run)"
fi

# 7. Start everything
echo ""
echo "Starting all services..."
docker compose up -d
echo ""

# 8. Summary
echo "=== Migration Complete ==="
echo ""
echo "Services:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Dashboard:      http://$(hostname -I | awk '{print $1}'):3000"
echo "Webhook server: http://$(hostname -I | awk '{print $1}'):3001"
echo ""
echo "Verify:"
echo "  docker compose logs -f --tail 50    # Watch logs"
echo "  curl -s http://localhost:3000/api/runners | python3 -m json.tool"
echo ""
echo "If you used an Azure DevOps webhook, update the URL to point to this host."
