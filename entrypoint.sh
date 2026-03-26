#!/bin/sh
set -e

# Ensure workspace exists and is writable
if [ -n "$LYNOX_WORKSPACE" ]; then
  mkdir -p "$LYNOX_WORKSPACE" 2>/dev/null || true
  if [ ! -w "$LYNOX_WORKSPACE" ]; then
    echo "ERROR: Workspace $LYNOX_WORKSPACE is not writable" >&2
    exit 1
  fi
fi

# Load vault key from .env if it exists (written by setup wizard).
# Security: Parse line-by-line with grep — never source the file as a script.
# Only extracts LYNOX_VAULT_KEY. Validates file permissions first.
ENV_FILE="$HOME/.lynox/.env"
if [ -z "${LYNOX_VAULT_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  # Reject symlinks
  if [ -L "$ENV_FILE" ]; then
    echo "Warning: ~/.lynox/.env is a symlink — ignoring for security" >&2
  else
    # Check permissions (must be 0600 or 0400 — no group/other access)
    # stat format: GNU uses -c, macOS/BSD uses -f
    FILE_PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "unknown")
    case "$FILE_PERMS" in
      600|400)
        # Safe permissions — extract only LYNOX_VAULT_KEY via grep
        VAULT_KEY=$(grep '^LYNOX_VAULT_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
        if [ -n "$VAULT_KEY" ]; then
          export LYNOX_VAULT_KEY="$VAULT_KEY"
        fi
        ;;
      unknown)
        # Could not determine permissions — skip loading for safety
        echo "Warning: Cannot verify ~/.lynox/.env permissions — skipping vault key load. Run: chmod 600 ~/.lynox/.env" >&2
        ;;
      *)
        echo "Warning: ~/.lynox/.env has insecure permissions ($FILE_PERMS). Run: chmod 600 ~/.lynox/.env" >&2
        ;;
    esac
  fi
fi

# Allow --init, --version, --help to run without API key
SKIP_KEY_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --init|init|--version|-v|--help|-h) SKIP_KEY_CHECK=true ;;
  esac
done

# Require ANTHROPIC_API_KEY unless running a no-key command
if [ "$SKIP_KEY_CHECK" = "false" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # Check if config has a key before failing
  CONFIG_FILE="$HOME/.lynox/config.json"
  if [ ! -f "$CONFIG_FILE" ] || ! grep -q '"api_key"' "$CONFIG_FILE" 2>/dev/null; then
    echo "Error: ANTHROPIC_API_KEY is required" >&2
    echo "Run with --init to start the setup wizard, or set the env var:" >&2
    echo "  docker run -it -e ANTHROPIC_API_KEY=sk-ant-... ..." >&2
    exit 1
  fi
fi

# Warn if MCP server runs without authentication
if [ -z "${LYNOX_MCP_SECRET:-}" ]; then
  for arg in "$@"; do
    case "$arg" in
      --mcp-server)
        echo "Warning: LYNOX_MCP_SECRET is not set — MCP server will run without authentication" >&2
        echo "Generate one: openssl rand -hex 32" >&2
        break
        ;;
    esac
  done
fi

# Forward SIGTERM to Node for graceful shutdown (KG writes, agent runs)
# Using exec replaces the shell — Node receives signals directly
exec node /app/dist/index.js "$@"
