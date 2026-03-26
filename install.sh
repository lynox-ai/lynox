#!/bin/sh
# nodyn — local install script
# Usage: curl -fsSL https://nodyn.dev/install.sh | sh
#
# Installs Node.js 22+ (via nvm) if needed, then starts the setup wizard.
# Inspect before running: curl -fsSL https://nodyn.dev/install.sh | less
#
# What this script does:
#   1. Checks for Node.js 22+ (installs via nvm if missing — no sudo needed)
#   2. Runs npx @nodyn-ai/core --init (the interactive setup wizard)
#   3. The wizard handles: API key, encryption, integrations, everything

SCRIPT_VERSION="2.0.0"
NVM_VERSION="v0.40.3"

set -eu

# --- Recover interactive input when piped via curl | sh ---
if [ ! -t 0 ] && [ -e /dev/tty ]; then
  exec < /dev/tty
fi

# --- Colors (with fallback for dumb terminals) ---
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold) GREEN=$(tput setaf 2) YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1) DIM=$(tput dim) RESET=$(tput sgr0)
else
  BOLD="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi

# --- Helpers ---
info()  { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn()  { printf "  %s⚠%s %s\n" "$YELLOW" "$RESET" "$1"; }
error() { printf "  %s✗ %s%s\n" "$RED" "$1" "$RESET" >&2; }
step()  { printf "\n  %s[%s/%s]%s %s\n" "$DIM" "$1" "$2" "$RESET" "$3"; }

# --- Cleanup on exit ---
cleanup() { :; }
trap cleanup EXIT

# --- OS Detection ---
detect_os() {
  case "$(uname -s)" in
    Darwin)  PLATFORM="macos" ;;
    Linux)   PLATFORM="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      error "Windows is not supported directly."
      printf "\n  Use WSL (Windows Subsystem for Linux) instead:\n"
      printf "  %shttps://learn.microsoft.com/en-us/windows/wsl/install%s\n\n" "$DIM" "$RESET"
      exit 1 ;;
    *)
      error "Unsupported operating system: $(uname -s)"
      exit 1 ;;
  esac
}

# --- Node.js Check ---
check_node() {
  HAS_NODE=0
  NODE_VERSION=""
  if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
    MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
    if [ "$MAJOR" -ge 22 ] 2>/dev/null; then
      HAS_NODE=1
    fi
  fi
}

# --- Install Node.js via nvm ---
install_node() {
  printf "\n  Node.js 22+ is required but not installed.\n"

  if [ -n "$NODE_VERSION" ]; then
    printf "  Found Node.js %s (too old, need 22+).\n" "$NODE_VERSION"
  fi

  printf "\n  Install Node.js 22 via nvm? (no sudo needed) [Y/n] "
  read -r CONFIRM
  case "${CONFIRM:-Y}" in
    [Nn]*)
      printf "\n  Install Node.js 22+ manually:\n"
      printf "  %shttps://nodejs.org%s\n\n" "$DIM" "$RESET"
      exit 0 ;;
  esac

  # Install nvm if not present
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    step "1" "3" "Installing nvm..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | PROFILE=/dev/null sh
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | PROFILE=/dev/null sh
    else
      error "Neither curl nor wget found. Install one and retry."
      exit 1
    fi
  else
    step "1" "3" "nvm already installed"
  fi

  # Load nvm
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"

  step "2" "3" "Installing Node.js 22..."
  nvm install 22 >/dev/null 2>&1
  nvm use 22 >/dev/null 2>&1

  # Verify
  check_node
  if [ "$HAS_NODE" -eq 0 ]; then
    error "Node.js installation failed."
    printf "  Install manually: %shttps://nodejs.org%s\n\n" "$DIM" "$RESET"
    exit 1
  fi

  step "3" "3" "Node.js $(node -v) installed"
}

# --- Main ---

printf "\n"
printf "  %snodyn%s — the AI that knows your business\n" "$BOLD" "$RESET"
printf "  %shttps://nodyn.dev%s\n" "$DIM" "$RESET"

detect_os
check_node

if [ "$HAS_NODE" -eq 1 ]; then
  info "Node.js v${NODE_VERSION} found"
else
  install_node
fi

printf "\n  Starting setup wizard...\n"
printf "  %sThe wizard will walk you through:%s\n" "$DIM" "$RESET"
printf "  %s→ API key (from console.anthropic.com)%s\n" "$DIM" "$RESET"
printf "  %s→ Encryption (automatic)%s\n" "$DIM" "$RESET"
printf "  %s→ Integrations (Telegram, Google, Web Search)%s\n" "$DIM" "$RESET"
printf "\n"

exec npx @nodyn-ai/core --init
