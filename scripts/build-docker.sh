#!/usr/bin/env bash
# Docker build + push script for ad-hoc manual image rebuilds.
#
# For regular releases prefer ./scripts/cut-release.sh X.Y.Z which bumps
# versions, creates PRs, polls for merge, tags, and delegates docker + npm
# publish to the release.yml workflow on tag push. This script exists only
# for manual out-of-band docker rebuilds (homelab, debugging, hotfix).
#
# Build + push only. Deployment/rollout is handled by the release pipeline,
# not from this public script.
#
# Usage:
#   ./scripts/build-docker.sh              # uses version from package.json
#   ./scripts/build-docker.sh 1.2.3        # explicit version override
#   ./scripts/build-docker.sh --dry-run    # show what would happen
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
DOCKERFILE="Dockerfile"
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
echo "Image pushed."
echo "Deployment/rollout is driven by the release pipeline (release.yml), not from here."
