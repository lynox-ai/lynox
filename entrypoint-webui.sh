#!/bin/sh
set -e

# Load vault key from .env if it exists
ENV_FILE="$HOME/.lynox/.env"
if [ -z "${LYNOX_VAULT_KEY:-}" ] && [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ]; then
  FILE_PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "unknown")
  case "$FILE_PERMS" in
    600|400)
      VAULT_KEY=$(grep '^LYNOX_VAULT_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
      if [ -n "$VAULT_KEY" ]; then
        export LYNOX_VAULT_KEY="$VAULT_KEY"
      fi
      ;;
  esac
fi

# Auto-generate access token if not set (Docker always exposes port 3000)
if [ -z "${LYNOX_HTTP_SECRET:-}" ]; then
  LYNOX_HTTP_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  export LYNOX_HTTP_SECRET
  echo ""
  echo "========================================"
  echo "  Access Token (enter in browser):"
  echo "  ${LYNOX_HTTP_SECRET}"
  echo "========================================"
  echo ""
fi

# Require ANTHROPIC_API_KEY
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  CONFIG_FILE="$HOME/.lynox/config.json"
  if [ ! -f "$CONFIG_FILE" ] || ! grep -q '"api_key"' "$CONFIG_FILE" 2>/dev/null; then
    echo "Error: ANTHROPIC_API_KEY is required" >&2
    echo "  docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ..." >&2
    exit 1
  fi
fi

# Warn if data directories are not writable (Docker named volumes may be root-owned)
for dir in "$HOME/.lynox" "$HOME/.cache/huggingface"; do
  if [ ! -w "$dir" ] 2>/dev/null; then
    echo "Warning: $dir is not writable by user $(id -u). Data persistence may fail." >&2
  fi
done

# Start Engine HTTP API in background
LYNOX_HTTP_PORT="${LYNOX_HTTP_PORT:-3100}" \
  node /app/dist/index.js --http-api &
ENGINE_PID=$!

# Wait for Engine health
echo "Waiting for Engine..."
for i in $(seq 1 30); do
  if wget -q -O /dev/null "http://127.0.0.1:${LYNOX_HTTP_PORT:-3100}/health" 2>/dev/null; then
    echo "Engine ready."
    break
  fi
  sleep 0.5
done

# Start Web UI
echo "Starting Web UI on port ${PORT:-3000}..."
LYNOX_ENGINE_URL="http://127.0.0.1:${LYNOX_HTTP_PORT:-3100}" \
LYNOX_HTTP_SECRET="${LYNOX_HTTP_SECRET:-}" \
PORT="${PORT:-3000}" \
  node /app/web-ui/index.js &
WEBUI_PID=$!

# Graceful shutdown
trap "kill $WEBUI_PID $ENGINE_PID 2>/dev/null; wait" TERM INT

wait
