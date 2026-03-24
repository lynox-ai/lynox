#!/bin/sh
# nodyn install script
# Usage: curl -fsSL https://nodyn.dev/install.sh | sh
#
# Auto-detects Node.js or Docker and runs the setup wizard.
# Inspect before running: curl -fsSL https://nodyn.dev/install.sh | less

set -eu

# --- Colors (with fallback for dumb terminals) ---

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1)
  DIM=$(tput dim)
  RESET=$(tput sgr0)
else
  BOLD="" GREEN="" YELLOW="" RED="" DIM="" RESET=""
fi

# --- Helpers ---

info()  { printf "%s%s%s\n" "$GREEN" "$1" "$RESET"; }
warn()  { printf "%s%s%s\n" "$YELLOW" "$1" "$RESET"; }
error() { printf "%s%s%s\n" "$RED" "$1" "$RESET" >&2; }
dim()   { printf "%s%s%s\n" "$DIM" "$1" "$RESET"; }

# --- Detect environment ---

HAS_NODE=0
HAS_DOCKER=0
NODE_VERSION=""

if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
  MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$MAJOR" -ge 22 ] 2>/dev/null; then
    HAS_NODE=1
  fi
fi

if command -v docker >/dev/null 2>&1; then
  HAS_DOCKER=1
fi

# --- Header ---

printf "\n"
printf "  %snodyn%s — Open Agent Engine\n" "$BOLD" "$RESET"
printf "  %shttps://nodyn.dev%s\n" "$DIM" "$RESET"
printf "\n"

# --- Check API key ---

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ ! -t 0 ]; then
    error "ANTHROPIC_API_KEY not set and stdin is not interactive."
    printf "\n  Set it first:\n"
    printf "    export ANTHROPIC_API_KEY=sk-ant-...\n"
    printf "    curl -fsSL https://nodyn.dev/install.sh | sh\n\n"
    exit 1
  fi

  printf "  You need an Anthropic API key to use nodyn.\n"
  printf "  Get one at: %shttps://console.anthropic.com/%s\n\n" "$DIM" "$RESET"
  printf "  API key: "
  read -r ANTHROPIC_API_KEY

  if [ -z "$ANTHROPIC_API_KEY" ]; then
    error "No API key provided. Exiting."
    exit 1
  fi

  export ANTHROPIC_API_KEY
fi

# --- Choose install method ---

if [ $HAS_NODE -eq 1 ] && [ $HAS_DOCKER -eq 1 ]; then
  info "  Detected: Node.js $NODE_VERSION + Docker"
  printf "\n  How would you like to run nodyn?\n"
  printf "    1) Node.js (npx) %s— recommended%s\n" "$DIM" "$RESET"
  printf "    2) Docker\n\n"
  printf "  Choice [1]: "
  read -r CHOICE
  CHOICE=${CHOICE:-1}
elif [ $HAS_NODE -eq 1 ]; then
  info "  Detected: Node.js $NODE_VERSION"
  CHOICE=1
elif [ $HAS_DOCKER -eq 1 ]; then
  info "  Detected: Docker"
  CHOICE=2
else
  error "  Neither Node.js 22+ nor Docker found."
  printf "\n  Install one of these first:\n"
  printf "    Node.js 22+:  %shttps://nodejs.org%s\n" "$DIM" "$RESET"
  printf "    Docker:       %shttps://docs.docker.com/get-docker/%s\n\n" "$DIM" "$RESET"
  exit 1
fi

# --- Run ---

printf "\n"

case "$CHOICE" in
  1)
    info "  Starting nodyn via npx..."
    printf "  %sThe setup wizard will configure everything.%s\n" "$DIM" "$RESET"
    printf "  %sTip: Connect Telegram in the wizard for daily use from your phone.%s\n\n" "$DIM" "$RESET"
    exec npx @nodyn-ai/core --init
    ;;
  2)
    info "  Starting nodyn via Docker..."
    printf "  %sThe setup wizard will configure everything.%s\n" "$DIM" "$RESET"
    printf "  %sTip: Connect Telegram in the wizard for daily use from your phone.%s\n\n" "$DIM" "$RESET"
    mkdir -p "$HOME/.nodyn"
    exec docker run -it --rm \
      -e ANTHROPIC_API_KEY \
      -v "$HOME/.nodyn:/home/nodyn/.nodyn" \
      ghcr.io/nodyn-ai/nodyn:latest --init
    ;;
  *)
    error "Invalid choice. Exiting."
    exit 1
    ;;
esac
