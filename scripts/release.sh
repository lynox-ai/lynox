#!/usr/bin/env bash
# Release script: build, tag, and push Docker image with proper versioning.
#
# Usage:
#   ./scripts/release.sh              # uses version from package.json
#   ./scripts/release.sh 1.2.3        # explicit version override
#   ./scripts/release.sh --dry-run    # show what would happen
#   ./scripts/release.sh --deploy     # also deploy pilots + managed after push
#
# Prerequisites:
#   - Run on amd64 build server (not Mac/ARM64)
#   - docker login ghcr.io done
#   - For --deploy: SSH access to control plane (root@46.224.229.143)
#
# Tags produced:
#   ghcr.io/lynox-ai/lynox:1.2.3     (exact version — immutable)
#   ghcr.io/lynox-ai/lynox:latest     (rolling alias)

set -euo pipefail

REPO="ghcr.io/lynox-ai/lynox"
DOCKERFILE="Dockerfile.web-ui"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse args
DRY_RUN=false
DEPLOY=false
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --deploy) DEPLOY=true ;;
    *) VERSION="$arg" ;;
  esac
done

# Read version from package.json if not provided
if [[ -z "$VERSION" ]]; then
  VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
fi

if [[ -z "$VERSION" || "$VERSION" == "undefined" ]]; then
  echo "Error: Could not determine version" >&2
  exit 1
fi

TAG_VERSION="$REPO:$VERSION"
TAG_LATEST="$REPO:latest"

echo "=== lynox release ==="
echo "Version:  $VERSION"
echo "Image:    $TAG_VERSION"
echo "Also:     $TAG_LATEST"
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would build and push:"
  echo "  docker build -t $TAG_VERSION -t $TAG_LATEST -f $DOCKERFILE ."
  echo "  docker push $TAG_VERSION"
  echo "  docker push $TAG_LATEST"
  exit 0
fi

cd "$ROOT_DIR"

echo "Building..."
docker build -t "$TAG_VERSION" -t "$TAG_LATEST" -f "$DOCKERFILE" .

echo ""
echo "Pushing $TAG_VERSION..."
docker push "$TAG_VERSION"

echo "Pushing $TAG_LATEST..."
docker push "$TAG_LATEST"

echo ""
echo "Image pushed."

# ── Deploy ──────────────────────────────────────────────────────────

CONTROL_PLANE="root@46.224.229.143"
PILOT_COMPOSE="/opt/lynox-pilot"

if ! $DEPLOY; then
  echo ""
  echo "To deploy, re-run with --deploy or manually:"
  echo "  # Pilots"
  echo "  docker tag $TAG_LATEST lynox:webui"
  echo "  cd $PILOT_COMPOSE && docker compose up -d --force-recreate rafael-lynox alessia-lynox rafael-searxng alessia-searxng"
  echo "  # Managed (per instance)"
  echo "  ssh $CONTROL_PLANE 'TOKEN=\$(grep MANAGED_ADMIN_TOKEN /opt/lynox-managed/.env | cut -d= -f2) && \\"
  echo "    curl -s -X POST http://localhost:4000/admin/instances/<ID>/redeploy -H \"Authorization: Bearer \$TOKEN\"'"
  exit 0
fi

echo ""
echo "=== Deploying pilots ==="
docker tag "$TAG_LATEST" lynox:webui
cd "$PILOT_COMPOSE" && docker compose up -d --force-recreate rafael-lynox alessia-lynox rafael-searxng alessia-searxng
cd "$ROOT_DIR"

echo ""
echo "=== Deploying managed instances ==="
# Fetch instance IDs from control plane, redeploy each one.
# This requires SSH access to the control plane — if running on the build
# server (homelab) which may not have it, print manual commands instead.
if ssh -o ConnectTimeout=5 -o BatchMode=yes "$CONTROL_PLANE" true 2>/dev/null; then
  INSTANCE_IDS=$(ssh "$CONTROL_PLANE" 'TOKEN=$(grep MANAGED_ADMIN_TOKEN /opt/lynox-managed/.env | cut -d= -f2) && \
    curl -sf http://localhost:4000/admin/instances -H "Authorization: Bearer $TOKEN"' \
    | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{JSON.parse(d).forEach(i=>console.log(i.id))})")

  if [[ -z "$INSTANCE_IDS" ]]; then
    echo "  Warning: No managed instances found"
  else
    for ID in $INSTANCE_IDS; do
      echo -n "  Redeploying $ID... "
      ssh "$CONTROL_PLANE" "TOKEN=\$(grep MANAGED_ADMIN_TOKEN /opt/lynox-managed/.env | cut -d= -f2) && \
        curl -sf -X POST http://localhost:4000/admin/instances/$ID/redeploy \
          -H \"Authorization: Bearer \$TOKEN\"" && echo "ok" || echo "FAILED"
    done
  fi
else
  echo "  No SSH access to control plane from this machine."
  echo "  Run from a machine with access:"
  echo "    ssh $CONTROL_PLANE 'TOKEN=\$(grep MANAGED_ADMIN_TOKEN /opt/lynox-managed/.env | cut -d= -f2) && \\"
  echo "      for ID in \$(curl -sf http://localhost:4000/admin/instances -H \"Authorization: Bearer \$TOKEN\" | node -e \"process.stdin.resume();let d=\\\"\\\";process.stdin.on(\\\"data\\\",c=>d+=c);process.stdin.on(\\\"end\\\",()=>{JSON.parse(d).forEach(i=>console.log(i.id))})\"); do \\"
  echo "        curl -sf -X POST http://localhost:4000/admin/instances/\$ID/redeploy -H \"Authorization: Bearer \$TOKEN\" && echo \"Redeployed \$ID\"; done'"
fi

echo ""
echo "=== Release $VERSION complete ==="
