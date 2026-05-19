#!/usr/bin/env bash
# PRD-LIGHT-MODE PR 3 — hex-guard pre-commit lint.
#
# Fails if a .svelte component (or any file under web-ui/src/) introduces a
# new 6-digit hex literal. The point: light/dark token discipline. Once a
# component reaches for raw hex, it stops being theme-aware.
#
# Allowlist (deliberate fixed-light or fixed-dark surfaces with rationale):
#   - MarkdownRenderer.svelte buildPrintDocument  (print stylesheet, always white paper)
#   - MarkdownRenderer.svelte mermaid PNG export  (asset-export decision)
#   - MarkdownRenderer.svelte html2canvas         (asset-export decision)
#   - KnowledgeGraphView.svelte typeHues          (categorical mid-tone palette, AA on both themes)
#   - MobileAccess.svelte QR cell                 (QR-codes dark-on-white by convention)
#   - app.css                                     (the token definitions themselves)
#   - logo-*.svg                                  (brand artwork)
#   - logo-brand*.svg                             (brand artwork)
#
# Run manually: bash packages/web-ui/scripts/hex-guard.sh
# Wired into lefthook pre-commit (see lefthook.yml).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCOPE="${REPO_ROOT}/packages/web-ui/src"

if [ ! -d "$SCOPE" ]; then
  # not a web-ui change; pass silently
  exit 0
fi

ALLOWLIST=(
  "packages/web-ui/src/app.css"
  "packages/web-ui/src/lib/components/MarkdownRenderer.svelte"
  "packages/web-ui/src/lib/components/KnowledgeGraphView.svelte"
  "packages/web-ui/src/lib/components/MobileAccess.svelte"
)

# Build a grep -v regex of allowlisted paths.
ALLOWLIST_REGEX="$(IFS=\|; echo "${ALLOWLIST[*]}")"

violations="$(
  grep -rnE '#[0-9a-fA-F]{6}' \
    --include='*.svelte' \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.css' \
    "$SCOPE" \
    | grep -vE "${ALLOWLIST_REGEX}" \
    | grep -vE ':[[:space:]]*\*' \
    | grep -vE ':[[:space:]]*//' \
    | grep -vE '<!--' \
    || true
)"

if [ -z "$violations" ]; then
  exit 0
fi

printf '\n\033[31m✗ hex-guard: found hardcoded hex in non-allowlisted files:\033[0m\n\n'
printf '%s\n\n' "$violations"
printf '  Use a token from app.css (--color-*) or extend the allowlist in\n'
printf '  packages/web-ui/scripts/hex-guard.sh with a one-line rationale.\n\n'
exit 1
