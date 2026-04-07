#!/usr/bin/env bash
# Release script: build, tag, and push Docker image with proper versioning.
#
# Usage:
#   ./scripts/release.sh              # uses version from package.json
#   ./scripts/release.sh 1.2.3        # explicit version override
#   ./scripts/release.sh --dry-run    # show what would happen
#
# Prerequisites:
#   - Run on amd64 build server (not Mac/ARM64)
#   - docker login ghcr.io done
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
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
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
echo "Done. To deploy to managed instances:"
echo "  curl -X POST https://control.lynox.cloud/admin/updates/rollout \\"
echo "    -H 'Authorization: Bearer \$MANAGED_ADMIN_TOKEN' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"targetVersion\": \"$VERSION\"}'"
