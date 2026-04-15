#!/usr/bin/env bash
# smoke-local.sh — local pre-release smoke test via docker compose + playwright.
#
# Usage:
#   ./scripts/smoke-local.sh              # build + start + test + teardown
#   ./scripts/smoke-local.sh --keep       # leave the stack running after tests
#   ./scripts/smoke-local.sh --no-build   # skip image rebuild (use layer cache)
#   ./scripts/smoke-local.sh --verbose    # stream container logs on failure
#
# What it does:
#   1. docker compose up -d --build against docker-compose.smoke.yml
#   2. Poll http://localhost:3333/api/health until 200 (timeout 120s)
#   3. Install Playwright browsers if missing
#   4. Run pnpm exec playwright test against tests/smoke/
#   5. Tear down the stack (unless --keep)
#
# Preconditions:
#   - docker + docker compose installed
#   - @playwright/test installed via `pnpm install` (already a devDep)
#   - Optional: ANTHROPIC_API_KEY in env enables chat flow tests later on

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Args + constants
# ─────────────────────────────────────────────────────────────────────

KEEP=false
NO_BUILD=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --keep)     KEEP=true ;;
    --no-build) NO_BUILD=true ;;
    --verbose)  VERBOSE=true ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    *) echo "error: unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$CORE_DIR/docker-compose.smoke.yml"
PROJECT_NAME="lynox-smoke"
BASE_URL="http://localhost:3333"
HEALTH_TIMEOUT=120

cd "$CORE_DIR"

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

c_blue()   { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

step() { printf '\n'; c_blue "=== $* ==="; }
die()  { c_red "error: $*"; exit 1; }

# ─────────────────────────────────────────────────────────────────────
# Teardown trap
# ─────────────────────────────────────────────────────────────────────

SMOKE_EXIT_CODE=0

cleanup() {
  SMOKE_EXIT_CODE=$?
  if $KEEP; then
    echo ""
    c_yellow "--keep set: leaving smoke stack running on $BASE_URL"
    c_yellow "tear down manually: docker compose -p $PROJECT_NAME -f $COMPOSE_FILE down -v"
    exit "$SMOKE_EXIT_CODE"
  fi

  if (( SMOKE_EXIT_CODE != 0 )) && $VERBOSE; then
    echo ""
    c_yellow "=== Container logs (last 80 lines per service) ==="
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs --tail=80 2>&1 || true
  fi

  echo ""
  c_blue "=== Teardown ==="
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v --remove-orphans 2>&1 | tail -5 || true
  exit "$SMOKE_EXIT_CODE"
}
trap cleanup EXIT INT TERM

# ─────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────

step "Preflight"

command -v docker >/dev/null || die "docker not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not installed"
command -v curl >/dev/null || die "curl not installed"
command -v pnpm >/dev/null || die "pnpm not installed"

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$CORE_DIR/playwright.config.ts" ]] || die "playwright config missing"
[[ -d "$CORE_DIR/tests/smoke" ]] || die "tests/smoke/ directory missing"

echo "  compose file: $COMPOSE_FILE"
echo "  base URL:     $BASE_URL"
echo "  keep:         $KEEP"
echo "  no-build:     $NO_BUILD"

# Stop any leftover smoke stack from a previous interrupted run
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────
# Build + up
# ─────────────────────────────────────────────────────────────────────

step "Build + start stack"

BUILD_ARGS=(-d)
if ! $NO_BUILD; then
  BUILD_ARGS+=(--build)
fi

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up "${BUILD_ARGS[@]}"

# ─────────────────────────────────────────────────────────────────────
# Health wait
# ─────────────────────────────────────────────────────────────────────

step "Wait for /api/health (timeout: ${HEALTH_TIMEOUT}s)"

started=$(date +%s)
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/api/health" || echo "000")
  if [[ "$code" == "200" ]]; then
    c_green "  engine healthy after $(( $(date +%s) - started ))s"
    break
  fi
  if (( $(date +%s) - started > HEALTH_TIMEOUT )); then
    c_red "  engine never became healthy in ${HEALTH_TIMEOUT}s (last HTTP $code)"
    exit 1
  fi
  sleep 2
done

# ─────────────────────────────────────────────────────────────────────
# Playwright
# ─────────────────────────────────────────────────────────────────────

step "Install Playwright browsers (if missing)"
# `install --with-deps` is linux-only; on macOS we just need the browser binary.
if ! pnpm exec playwright --version >/dev/null 2>&1; then
  die "@playwright/test is not installed. Run: pnpm install"
fi
pnpm exec playwright install chromium 2>&1 | tail -3

step "Run smoke tests"
SMOKE_BASE_URL="$BASE_URL" pnpm exec playwright test --config=playwright.config.ts

step "Smoke PASS"
c_green "  all smoke tests passed against $BASE_URL"
