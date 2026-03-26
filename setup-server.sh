#!/bin/sh
# nodyn — server deployment script
# Usage: curl -fsSL https://nodyn.dev/setup-server.sh | sh
#
# Sets up a 24/7 nodyn instance with Docker and Telegram.
# Inspect before running: curl -fsSL https://nodyn.dev/setup-server.sh | less
#
# What this script does:
#   1. Checks/installs Docker
#   2. Asks for your Anthropic API key
#   3. Optionally sets up Telegram bot
#   4. Generates encryption key
#   5. Starts nodyn in a hardened Docker container
#   6. Verifies everything works

SCRIPT_VERSION="1.0.0"
NODYN_IMAGE="ghcr.io/nodyn-ai/nodyn:latest"
NODYN_CONTAINER="nodyn"
NODYN_DIR="$HOME/.nodyn"
ENV_FILE="$NODYN_DIR/.env"

set -eu

# --- Recover interactive input when piped via curl | sh ---
if [ ! -t 0 ] && [ -e /dev/tty ]; then
  exec < /dev/tty
fi

# --- Prevent secrets in shell history ---
unset HISTFILE 2>/dev/null || true

# --- Colors ---
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold) GREEN=$(tput setaf 2) YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1) DIM=$(tput dim) RESET=$(tput sgr0)
else
  BOLD="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi

# --- Helpers ---
info()    { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn()    { printf "  %s⚠%s %s\n" "$YELLOW" "$RESET" "$1"; }
error()   { printf "  %s✗ %s%s\n" "$RED" "$1" "$RESET" >&2; }
step()    { printf "\n  %s[%s/%s]%s %s%s%s\n" "$DIM" "$1" "$2" "$RESET" "$BOLD" "$3" "$RESET"; }
confirm() {
  printf "  %s [Y/n] " "$1"
  read -r _ans
  case "${_ans:-Y}" in [Nn]*) return 1 ;; esac
  return 0
}
read_secret() {
  printf "  %s: " "$1"
  stty -echo 2>/dev/null || true
  read -r _secret
  stty echo 2>/dev/null || true
  printf "\n"
}

# --- Cleanup ---
_tmpfiles=""
cleanup() {
  stty echo 2>/dev/null || true
  for f in $_tmpfiles; do rm -f "$f" 2>/dev/null || true; done
  unset API_KEY VAULT_KEY TELEGRAM_TOKEN TELEGRAM_CHAT_ID _secret 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- OS Check ---
case "$(uname -s)" in
  Linux|Darwin) ;;
  *)
    error "This script requires Linux or macOS."
    exit 1 ;;
esac

# --- Header ---
printf "\n"
printf "  %snodyn%s — server deployment\n" "$BOLD" "$RESET"
printf "  %shttps://nodyn.dev%s\n" "$DIM" "$RESET"
printf "\n"
printf "  This script sets up nodyn to run 24/7 on this server.\n"
printf "  You'll need: an Anthropic API key and optionally a Telegram bot.\n"

# --- Existing installation check ---
EXISTING=0
if [ -f "$ENV_FILE" ]; then
  EXISTING=1
fi
CONTAINER_EXISTS=0
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$NODYN_CONTAINER"; then
  CONTAINER_EXISTS=1
fi

if [ "$EXISTING" -eq 1 ] || [ "$CONTAINER_EXISTS" -eq 1 ]; then
  printf "\n  %sExisting installation detected.%s\n" "$YELLOW" "$RESET"
  if [ "$CONTAINER_EXISTS" -eq 1 ]; then
    CSTATUS=$(docker inspect --format='{{.State.Status}}' "$NODYN_CONTAINER" 2>/dev/null || echo "unknown")
    printf "  Container: %s (%s)\n" "$NODYN_CONTAINER" "$CSTATUS"
  fi
  [ "$EXISTING" -eq 1 ] && printf "  Config: %s\n" "$ENV_FILE"
  printf "\n  What would you like to do?\n"
  printf "    1) Update to latest version\n"
  printf "    2) Reconfigure (change keys, add Telegram)\n"
  printf "    3) Exit\n"
  printf "\n  Choice [1]: "
  read -r ECHOICE
  case "${ECHOICE:-1}" in
    1)
      step "1" "3" "Pulling latest image"
      docker pull "$NODYN_IMAGE"
      step "2" "3" "Restarting container"
      docker stop "$NODYN_CONTAINER" 2>/dev/null || true
      docker rm "$NODYN_CONTAINER" 2>/dev/null || true
      docker run -d \
        --name "$NODYN_CONTAINER" \
        --restart unless-stopped \
        --read-only \
        --tmpfs /tmp:size=512M \
        --tmpfs /workspace:size=256M,uid=1001,gid=1001 \
        --security-opt no-new-privileges \
        --memory 2g --cpus 2.0 \
        --env-file "$ENV_FILE" \
        -v "$NODYN_DIR:/home/nodyn/.nodyn" \
        "$NODYN_IMAGE" >/dev/null
      step "3" "3" "Verifying"
      sleep 3
      if docker ps --format '{{.Names}}' | grep -qx "$NODYN_CONTAINER"; then
        info "nodyn updated and running"
      else
        error "Container failed to start. Check: docker logs $NODYN_CONTAINER"
        exit 1
      fi
      exit 0 ;;
    2) ;; # continue to reconfigure
    *) printf "\n"; exit 0 ;;
  esac
fi

# ============================================================
# Step 1: Docker
# ============================================================
TOTAL_STEPS=7
step "1" "$TOTAL_STEPS" "Docker"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  info "Docker is installed and running"
elif command -v docker >/dev/null 2>&1; then
  warn "Docker is installed but not running"
  printf "  Start it with: %ssudo systemctl start docker%s\n" "$BOLD" "$RESET"
  exit 1
else
  printf "  Docker is required for server deployment.\n"
  if confirm "Install Docker now? (may require sudo)"; then
    printf "\n  Installing Docker via official script...\n"
    curl -fsSL https://get.docker.com | sh
    # Add user to docker group
    if command -v usermod >/dev/null 2>&1; then
      sudo usermod -aG docker "$USER" 2>/dev/null || true
    fi
    # Try to activate without re-login
    if ! docker info >/dev/null 2>&1; then
      warn "Docker installed. You may need to log out and back in."
      printf "  Then re-run this script.\n"
      exit 0
    fi
    info "Docker installed"
  else
    printf "\n  Install Docker manually:\n"
    printf "  %shttps://docs.docker.com/engine/install/%s\n\n" "$DIM" "$RESET"
    exit 0
  fi
fi

# ============================================================
# Step 2: Anthropic API Key
# ============================================================
step "2" "$TOTAL_STEPS" "Anthropic API Key"

API_KEY=""
printf "  Get one at: %shttps://console.anthropic.com%s → API Keys → Create Key\n" "$DIM" "$RESET"
printf "  Typical cost: \$1–5 per business day. Set spending limits in the console.\n\n"

ATTEMPTS=0
while [ -z "$API_KEY" ]; do
  read_secret "API key (paste, then Enter)"
  API_KEY="$_secret"

  # Validate format
  case "$API_KEY" in
    sk-ant-*) ;;
    sk-*)     ;;
    *)
      error "Key must start with sk-ant-"
      API_KEY=""
      ATTEMPTS=$((ATTEMPTS + 1))
      [ "$ATTEMPTS" -ge 3 ] && error "Too many attempts." && exit 1
      continue ;;
  esac

  if [ "${#API_KEY}" -lt 20 ]; then
    error "Key is too short. Make sure you copied the full key."
    API_KEY=""
    ATTEMPTS=$((ATTEMPTS + 1))
    [ "$ATTEMPTS" -ge 3 ] && error "Too many attempts." && exit 1
    continue
  fi

  # Optional: verify against API
  printf "  Verifying key..."
  HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "x-api-key: $API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -X POST "https://api.anthropic.com/v1/messages" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
    --connect-timeout 10 2>/dev/null || echo "000")

  case "$HTTP_STATUS" in
    200) printf "\r"; info "API key verified" ;;
    401|403)
      printf "\r"; error "Invalid API key. Check and try again."
      API_KEY=""
      ATTEMPTS=$((ATTEMPTS + 1))
      [ "$ATTEMPTS" -ge 3 ] && error "Too many attempts." && exit 1
      continue ;;
    000)
      printf "\r"; warn "Could not reach Anthropic API (offline?). Key saved, will validate on first use." ;;
    *)
      printf "\r"; info "API key accepted (HTTP $HTTP_STATUS)" ;;
  esac
done

# ============================================================
# Step 3: Telegram Bot (optional)
# ============================================================
step "3" "$TOTAL_STEPS" "Telegram Bot"

TELEGRAM_TOKEN=""
TELEGRAM_CHAT_ID=""

printf "  Telegram is your daily interface — use nodyn from your phone.\n\n"

if confirm "Set up Telegram now?"; then
  printf "\n  %s1.%s Open Telegram → message %s@BotFather%s\n" "$BOLD" "$RESET" "$BOLD" "$RESET"
  printf "  %s2.%s Send %s/newbot%s → follow prompts → copy the token\n\n" "$BOLD" "$RESET" "$BOLD" "$RESET"

  TG_ATTEMPTS=0
  while [ -z "$TELEGRAM_TOKEN" ]; do
    printf "  Bot token: "
    read -r TELEGRAM_TOKEN

    if [ -z "$TELEGRAM_TOKEN" ]; then
      warn "Skipping Telegram. You can add it later by re-running this script."
      break
    fi

    # Validate format
    case "$TELEGRAM_TOKEN" in
      *:*)
        # Verify token
        TG_RESULT=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe" --connect-timeout 10 2>/dev/null || echo '{"ok":false}')
        if printf '%s' "$TG_RESULT" | grep -q '"ok":true'; then
          BOT_NAME=$(printf '%s' "$TG_RESULT" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
          info "Bot verified: @${BOT_NAME}"
        else
          error "Invalid token. Check and try again (or press Enter to skip)."
          TELEGRAM_TOKEN=""
          TG_ATTEMPTS=$((TG_ATTEMPTS + 1))
          [ "$TG_ATTEMPTS" -ge 3 ] && warn "Skipping Telegram." && break
          continue
        fi ;;
      *)
        error "Token format: 123456789:ABCdef..."
        TELEGRAM_TOKEN=""
        TG_ATTEMPTS=$((TG_ATTEMPTS + 1))
        [ "$TG_ATTEMPTS" -ge 3 ] && warn "Skipping Telegram." && break
        continue ;;
    esac
  done

  # Get chat ID by waiting for user to message the bot
  if [ -n "$TELEGRAM_TOKEN" ]; then
    printf "\n  Now open Telegram and send any message to your bot.\n"
    printf "  %sWaiting for your message (up to 2 minutes)...%s" "$DIM" "$RESET"

    DEADLINE=$(($(date +%s) + 120))
    OFFSET=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      UPDATES=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=10&offset=${OFFSET}" --connect-timeout 15 2>/dev/null || echo "")
      CHAT_ID=$(printf '%s' "$UPDATES" | grep -o '"chat":{[^}]*"id":[0-9]*' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
      if [ -n "$CHAT_ID" ]; then
        TELEGRAM_CHAT_ID="$CHAT_ID"
        # Acknowledge: mark as read
        MSG_ID=$(printf '%s' "$UPDATES" | grep -o '"update_id":[0-9]*' | tail -1 | cut -d: -f2)
        [ -n "$MSG_ID" ] && OFFSET=$((MSG_ID + 1))
        curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${OFFSET}" >/dev/null 2>&1 || true
        break
      fi
    done

    if [ -n "$TELEGRAM_CHAT_ID" ]; then
      printf "\r  %s                                              %s\r" " " " "
      info "Chat ID: ${TELEGRAM_CHAT_ID} — only you can talk to this bot"
    else
      printf "\r  %s                                              %s\r" " " " "
      warn "No message received. You can add your chat ID later:"
      printf "  %sAdd TELEGRAM_ALLOWED_CHAT_IDS=<your-id> to ~/.nodyn/.env%s\n" "$DIM" "$RESET"
    fi
  fi
else
  printf "  %sSkipped. Re-run this script anytime to add Telegram.%s\n" "$DIM" "$RESET"
fi

# ============================================================
# Step 4: Encryption
# ============================================================
step "4" "$TOTAL_STEPS" "Encryption"

if command -v openssl >/dev/null 2>&1; then
  VAULT_KEY=$(openssl rand -base64 48)
else
  VAULT_KEY=$(dd if=/dev/urandom bs=48 count=1 2>/dev/null | base64)
fi

info "Encryption key generated (AES-256-GCM)"
printf "  %sStored in ~/.nodyn/.env — keep a backup of this directory.%s\n" "$DIM" "$RESET"

# ============================================================
# Step 5: Write configuration
# ============================================================
step "5" "$TOTAL_STEPS" "Saving configuration"

mkdir -p "$NODYN_DIR"
chmod 700 "$NODYN_DIR"

# Atomic write: temp file → chmod → rename
TMPFILE=$(mktemp "$NODYN_DIR/.env.XXXXXX")
_tmpfiles="$TMPFILE"

cat > "$TMPFILE" << ENVEOF
# nodyn server configuration
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT share this file — contains your encryption key and API credentials

ANTHROPIC_API_KEY=${API_KEY}
NODYN_VAULT_KEY=${VAULT_KEY}
ENVEOF

[ -n "$TELEGRAM_TOKEN" ] && printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_TOKEN" >> "$TMPFILE"
[ -n "$TELEGRAM_CHAT_ID" ] && printf 'TELEGRAM_ALLOWED_CHAT_IDS=%s\n' "$TELEGRAM_CHAT_ID" >> "$TMPFILE"

chmod 600 "$TMPFILE"
mv "$TMPFILE" "$ENV_FILE"
_tmpfiles=""

info "Configuration saved to ~/.nodyn/.env"

# Clear secrets from memory
unset API_KEY VAULT_KEY 2>/dev/null || true

# ============================================================
# Step 6: Pull image
# ============================================================
step "6" "$TOTAL_STEPS" "Downloading nodyn"

docker pull "$NODYN_IMAGE"

# ============================================================
# Step 7: Start container
# ============================================================
step "7" "$TOTAL_STEPS" "Starting nodyn"

# Remove existing container if present
docker stop "$NODYN_CONTAINER" 2>/dev/null || true
docker rm "$NODYN_CONTAINER" 2>/dev/null || true

docker run -d \
  --name "$NODYN_CONTAINER" \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=512M \
  --tmpfs /workspace:size=256M,uid=1001,gid=1001 \
  --security-opt no-new-privileges \
  --memory 2g --cpus 2.0 \
  --env-file "$ENV_FILE" \
  -v "$NODYN_DIR:/home/nodyn/.nodyn" \
  "$NODYN_IMAGE" >/dev/null

# Verify
printf "  Waiting for startup..."
HEALTHY=0
for _ in $(seq 1 15); do
  sleep 2
  if docker ps --format '{{.Names}}' | grep -qx "$NODYN_CONTAINER"; then
    HEALTHY=1
    break
  fi
done

printf "\r                          \r"

if [ "$HEALTHY" -eq 1 ]; then
  # Check logs for errors
  LOGS=$(docker logs "$NODYN_CONTAINER" 2>&1 | tail -5)
  if printf '%s' "$LOGS" | grep -qi "error\|fatal"; then
    warn "Container started with warnings. Check: docker logs $NODYN_CONTAINER"
  else
    info "nodyn is running"
  fi
else
  error "Container failed to start."
  printf "  Check logs: %sdocker logs %s%s\n" "$BOLD" "$NODYN_CONTAINER" "$RESET"
  exit 1
fi

# ============================================================
# Summary
# ============================================================
printf "\n"
printf "  %s╭──────────────────────────────────────╮%s\n" "$GREEN" "$RESET"
printf "  %s│  ✓  nodyn is running                 │%s\n" "$GREEN" "$RESET"
printf "  %s╰──────────────────────────────────────╯%s\n" "$GREEN" "$RESET"
printf "\n"
printf "  %sWhat's set up:%s\n" "$BOLD" "$RESET"
printf "    API Key        ✓  Anthropic Claude\n"
printf "    Encryption     ✓  AES-256-GCM\n"
if [ -n "$TELEGRAM_TOKEN" ]; then
  printf "    Telegram       ✓  @%s" "${BOT_NAME:-bot}"
  [ -n "$TELEGRAM_CHAT_ID" ] && printf " (chat %s)" "$TELEGRAM_CHAT_ID"
  printf "\n"
else
  printf "    Telegram       –  %snot configured (re-run to add)%s\n" "$DIM" "$RESET"
fi
printf "    Container      ✓  %s (auto-restarts)\n" "$NODYN_CONTAINER"
printf "\n"
printf "  %sYour data:%s\n" "$BOLD" "$RESET"
printf "    ~/.nodyn/        Config, knowledge, history, backups\n"
printf "\n"
printf "  %sUseful commands:%s\n" "$BOLD" "$RESET"
printf "    %sdocker logs -f nodyn%s          View live logs\n" "$DIM" "$RESET"
printf "    %sdocker restart nodyn%s          Restart\n" "$DIM" "$RESET"
printf "\n"

if [ -n "$TELEGRAM_TOKEN" ]; then
  printf "  %sGet started:%s\n" "$BOLD" "$RESET"
  printf "    → Open Telegram and message @%s\n" "${BOT_NAME:-your-bot}"
  printf "    → Try: %s\"Check my emails\"%s or %s\"What can you do?\"%s\n" "$BOLD" "$RESET" "$BOLD" "$RESET"
else
  printf "  %sGet started:%s\n" "$BOLD" "$RESET"
  printf "    → Connect interactively:\n"
  printf "      %sdocker exec -it nodyn node /app/dist/index.js%s\n" "$DIM" "$RESET"
  printf "    → Or add Telegram later by re-running this script\n"
fi

printf "\n"
