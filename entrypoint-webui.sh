#!/bin/sh
set -e

# ── Pre-flight: verify volume mount ──────────────────────────
# Without a volume mount, the vault key and all data are lost on restart.
PREFLIGHT_FILE="$HOME/.lynox/.volume-check"
if printf 'ok' > "$PREFLIGHT_FILE" 2>/dev/null && [ -f "$PREFLIGHT_FILE" ]; then
  rm -f "$PREFLIGHT_FILE"
else
  echo "" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "  WARNING: Volume mount not detected or not writable!" >&2
  echo "  Data will be LOST when this container restarts." >&2
  echo "" >&2
  echo "  Add to your docker run command:" >&2
  echo "    -v ~/.lynox:/home/lynox/.lynox" >&2
  echo "" >&2
  echo "  Or in docker-compose.yml:" >&2
  echo "    volumes:" >&2
  echo "      - \${HOME}/.lynox:/home/lynox/.lynox" >&2
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  echo "" >&2
fi

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

# Auto-generate access token if not set
TOKEN_FILE="$HOME/.lynox/.access-token"
if [ -z "${LYNOX_HTTP_SECRET:-}" ]; then
  # Reuse persisted token from previous run (survives container restarts)
  if [ -f "$TOKEN_FILE" ]; then
    LYNOX_HTTP_SECRET=$(cat "$TOKEN_FILE")
    export LYNOX_HTTP_SECRET
    echo "  Access token loaded from volume (not shown in logs)." >&2
    echo "  Retrieve: docker exec lynox cat \$HOME/.lynox/.access-token" >&2
    echo "" >&2
  else
    LYNOX_HTTP_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
    export LYNOX_HTTP_SECRET
    # Persist to volume so it survives container restarts
    mkdir -p "$HOME/.lynox"
    printf '%s' "$LYNOX_HTTP_SECRET" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "" >&2
    echo "========================================" >&2
    echo "  Access Token (enter in browser):" >&2
    echo "  ${LYNOX_HTTP_SECRET}" >&2
    echo "========================================" >&2
    echo "  Stored in volume — same token on every restart." >&2
    echo "  Retrieve: docker exec lynox cat \$HOME/.lynox/.access-token" >&2
    echo "  Override: set LYNOX_HTTP_SECRET in .env or docker run" >&2
    echo "" >&2
  fi
fi

# Auto-generate vault key if not set (persist to volume)
if [ -z "${LYNOX_VAULT_KEY:-}" ]; then
  LYNOX_VAULT_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64'))")
  export LYNOX_VAULT_KEY
  mkdir -p "$HOME/.lynox"
  printf 'LYNOX_VAULT_KEY=%s\n' "$LYNOX_VAULT_KEY" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  Vault key generated and saved to volume."
  echo "  Save it to a password manager: Settings → Config → Security"
  echo ""
else
  echo "  Vault key active — data is encrypted."
  echo ""
fi

# Check ANTHROPIC_API_KEY (warn but don't exit — browse mode still works)
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  CONFIG_FILE="$HOME/.lynox/config.json"
  if [ ! -f "$CONFIG_FILE" ] || ! grep -q '"api_key"' "$CONFIG_FILE" 2>/dev/null; then
    echo "" >&2
    echo "  Warning: ANTHROPIC_API_KEY not set" >&2
    echo "  AI responses disabled — browse mode only" >&2
    echo "  Set: docker run -e ANTHROPIC_API_KEY=sk-ant-... ..." >&2
    echo "" >&2
    export ANTHROPIC_API_KEY="not-configured"
  fi
fi

# Warn if data directories are not writable
for dir in "$HOME/.lynox" "$HOME/.cache/huggingface"; do
  if [ ! -w "$dir" ] 2>/dev/null; then
    echo "Warning: $dir is not writable by user $(id -u). Data persistence may fail." >&2
  fi
done

# SvelteKit CSRF: set ORIGIN so protocol matches (defaults to https otherwise)
if [ -z "${ORIGIN:-}" ]; then
  if [ -n "${LYNOX_TLS_CERT:-}" ]; then
    export ORIGIN="https://localhost:${LYNOX_HTTP_PORT:-3000}"
  else
    export ORIGIN="http://localhost:${LYNOX_HTTP_PORT:-3000}"
  fi
fi

# Single process: Engine auto-loads Web UI handler from /app/web-ui/handler.js
echo "Starting lynox on port ${LYNOX_HTTP_PORT:-3000}..."
echo "  Phone access: Settings → Mobile Access → scan QR code" >&2
exec node /app/dist/index.js --http-api
