#!/bin/sh
# Start lynox demo instance with pre-seeded business data.
#
# Usage:
#   ./scripts/demo.sh                  # browse-only (no AI, dummy key)
#   ./scripts/demo.sh --live           # live mode (real AI, needs ANTHROPIC_API_KEY)
#
# Seed data first:  npx tsx scripts/seed-test-data.ts --clean
# Open:             http://localhost:3300

set -e
cd "$(dirname "$0")/.."

LIVE=false
for arg in "$@"; do
  case "$arg" in --live) LIVE=true ;; esac
done

if [ "$LIVE" = true ]; then
  if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "Error: ANTHROPIC_API_KEY required for --live mode" >&2
    echo "  ANTHROPIC_API_KEY=sk-ant-... ./scripts/demo.sh --live" >&2
    exit 1
  fi
  echo "🟢 Live mode — AI responses enabled"
else
  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-dummy}"
  echo "🔵 Browse mode — viewing seeded data only (no AI)"
  echo "   Use --live for real AI responses"
fi

export LYNOX_HTTP_PORT=3200
export LYNOX_EMBEDDING_PROVIDER=onnx

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$ENGINE_PID" "$WEBUI_PID" 2>/dev/null
  wait "$ENGINE_PID" "$WEBUI_PID" 2>/dev/null
  echo "Done."
}
trap cleanup INT TERM

# Start Engine
echo "Starting Engine on :$LYNOX_HTTP_PORT..."
node dist/index.js --http-api &
ENGINE_PID=$!

# Wait for health
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:$LYNOX_HTTP_PORT/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Start Web UI
echo "Starting Web UI on :3300..."
PORT=3300 LYNOX_ENGINE_URL="http://127.0.0.1:$LYNOX_HTTP_PORT" \
  node packages/web-ui/build/index.js &
WEBUI_PID=$!

sleep 1
echo ""
echo "════════════════════════════════════"
echo "  lynox demo ready"
echo "  http://localhost:3300"
echo "════════════════════════════════════"
echo ""

wait
