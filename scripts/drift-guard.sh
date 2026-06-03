#!/usr/bin/env bash
#
# drift-guard.sh — catch the MECHANIZABLE slices of documentation/code drift
# that gitleaks + public-repo-guard don't (those are for secrets/infra leaks).
#
# Drift is mostly semantic and can't be fully guarded, but three classes are
# deterministic and high-value:
#   A. Merge-conflict markers committed by accident (caught the v1.8.2
#      `lynox --help` garble that shipped to npm).
#   B. Removed features (Telegram / WhatsApp / MCP server) reappearing as LIVE
#      docs — i.e. outside docs/**/archive/.
#   C. Dead doc-path references — backtick `src/…` paths in CLAUDE.md / docs /
#      READMEs that point at files which no longer exist.
#
# Semantic drift (a doc claim that contradicts code) is NOT covered here — the
# doc<->code coupling vitest tests (tests/doc-drift.test.ts) cover the specific
# high-churn surfaces, and a periodic audit covers the rest.
#
# Enforcement: pre-push (lefthook) + CI (.github/workflows/drift-guard.yml).
#
# Usage: scripts/drift-guard.sh        # scan whole tracked tree
#
# Escape hatch (class B/C only — A is never exempt): put the pragma
# `drift-guard:allow <reason>` anywhere on the offending line.

set -euo pipefail

PRAGMA='drift-guard:allow'
SELF_EXCLUDE='scripts/drift-guard.sh .github/workflows/drift-guard.yml'

# B: removed features that must not appear in LIVE docs (archive/ is exempt).
REMOVED='[Tt]elegram|[Ww]hats[Aa]pp|MCP[ -]server'

# C: backtick path prefixes treated as real repo paths to verify.
PATH_RE='`(src|packages|scripts|tests|docs)/[A-Za-z0-9_./-]+`'

is_excluded() {
  local f="$1"
  for x in $SELF_EXCLUDE; do [ "$f" = "$x" ] && return 0; done
  return 1
}

# A doc path is "alive" if it exists relative to the repo root OR as a suffix
# of any tracked path — docs legitimately use package-relative paths
# (e.g. `src/lib/...` meaning packages/web-ui/src/lib/...).
ALL_TRACKED="$(git ls-files)"
exists_path() {
  local p="${1%/}"
  [ -e "$p" ] && return 0
  local esc
  esc="$(printf '%s' "$p" | sed 's/[.[\*^$/]/\\&/g')"
  # Here-string, not `printf | grep -q`: under `set -o pipefail`, grep -q closing
  # the pipe early on a match sends SIGPIPE to printf (exit 141), which pipefail
  # then propagates as the pipeline's status — so `&& return 0` would not fire and
  # an existing path would be falsely reported dead (intermittent, list-size/timing
  # dependent). A here-string has no producer process, so no SIGPIPE.
  grep -qE "(^|/)${esc}(/|\$)" <<< "$ALL_TRACKED" && return 0
  return 1
}

violations=0

# ── A. Merge-conflict markers (every tracked text file) ──────────────────
# Match only the unambiguous git markers (<<<<<<< and >>>>>>> at col 0); the
# ======= separator is skipped to avoid clashing with markdown setext rules.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  grep -Iq . "$f" 2>/dev/null || continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ A/merge-conflict marker in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nE '^(<<<<<<<|>>>>>>>)' "$f" 2>/dev/null || true)
done < <(git ls-files)

# ── B. Removed feature in a LIVE doc (outside archive/) ───────────────────
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  case "$f" in */archive/*) continue ;; esac
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in *"$PRAGMA"*) continue ;; esac
    echo "⚠️  B/removed-feature in LIVE doc $f (move to archive/ or add '${PRAGMA}'):"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$REMOVED" "$f" 2>/dev/null || true)
done < <(git ls-files 'docs/src/content/docs/*')

# ── C. Dead doc-path references in CLAUDE.md / docs / READMEs ─────────────
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"
    rest="${hit#*:}"
    case "$rest" in *"$PRAGMA"*) continue ;; esac
    # Extract each backtick path on the line and verify existence.
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      path="${p//\`/}"
      # Skip globs / placeholders.
      case "$path" in *'<'*|*'>'*|*'*'*|*'{'*|*'…'*|*' '*) continue ;; esac
      if ! exists_path "$path"; then
        echo "⚠️  C/dead-path ref in $f:$lineno — \`$path\` does not exist (add '${PRAGMA}' if intentional):"
        violations=$((violations + 1))
      fi
    done < <(printf '%s\n' "$rest" | grep -oE "$PATH_RE" || true)
  done < <(grep -nE "$PATH_RE" "$f" 2>/dev/null || true)
done < <(git ls-files '*CLAUDE.md' '*README.md' 'docs/src/content/docs/*')

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "drift-guard: ${violations} drift marker(s) found."
  echo "A (merge markers) is never exempt — resolve the conflict."
  echo "B/C can be annotated with '${PRAGMA}: <reason>' on the line if intentional."
  exit 1
fi

echo "drift-guard: clean ✓"
