#!/usr/bin/env bash
#
# positioning-guard.sh — keep public marketing/category copy aligned with the
# canonical positioning (pro/docs/internal/POSITIONING.md → Vocabulary → Avoid).
#
# Positioning drift is as real as doc drift: hero taglines and the npm
# description quietly pick up legacy category labels ("AI engine", "agent
# runtime"), OSI-flavoured "open source" (lynox is ELv2, not OSI-approved),
# and tired AI-startup patterns ("The AI that…"). None of these are bugs a
# typecheck or the doc-drift tests catch, so they rot until someone notices.
# This guard flags them on the handful of pure-copy surfaces where they are
# (almost) never legitimate.
#
# SCOPE — deliberately tight. Only hero/landing copy + the npm description
# are scanned. The developer README is intentionally NOT scanned: per
# POSITIONING.md it "retains its technical description permanently" (engine /
# runtime are fine there as feature names), and it carries the deliberate
# "not OSI-approved 'open source'" licence clarification.
#
# NOTE on "engine": v10 allows "workflow engine" as a FEATURE name — only
# "engine"/"runtime" as an external CATEGORY label for lynox is avoided. So we
# match the category-label forms ("AI engine", "agent runtime", bare
# "runtime"/"framework" on a hero), never a bare "engine".
#
# Two enforcement points (lefthook.yml pre-push + the CI workflow):
#   - pre-push hook — scans staged copy surfaces, fast local feedback
#   - CI on PRs     — scans the whole curated set (cannot be --no-verify'd)
#
# Usage:
#   scripts/positioning-guard.sh           # scan all copy surfaces (CI)
#   scripts/positioning-guard.sh --staged  # scan staged copy surfaces (hook)
#
# Exit 0 = clean, exit 1 = an avoid-word was found, exit 2 = the guard could not
# run (its curated file list resolved to nothing, i.e. the list is stale).
#
# Escape hatch: put the pragma `positioning:allow` on the line, with a short
# reason. Contrast copy ("not a chatbot", "assistants respond, lynox operates",
# the "is lynox open source?" answer) is the legitimate use — these words
# appear on purpose there.

set -euo pipefail

PRAGMA='positioning:allow'

# Curated marketing/category surfaces. Bare hero/landing copy + npm
# description — extend deliberately, NOT with broad globs (false positives on
# technical docs are the failure mode that makes a guard get disabled).
COPY_FILES='docs/src/content/docs/index.mdx docs/README.md'

# package.json gets a targeted check on its "description" line only (a blind
# scan would flag the node "engines" field).
PKG_JSON='package.json'

SELF_EXCLUDE='scripts/positioning-guard.sh .github/workflows/positioning-guard.yml'

# Avoid-words / category-drift forms. All pragma-exemptable because every one
# has a legitimate contrastive use ("not a chatbot", "not open source").
#  - AI-powered / "The AI that…"  → tired AI-startup patterns
#  - chatbot                       → wrong category signal
#  - open source / open-source     → ELv2 is not OSI-approved; use "open"/"source-available"
#  - (AI|agent|business) engine|runtime → external category label for lynox
#  - bare runtime / framework      → developer jargon / "library you wire together"
AVOID='AI-powered|[Tt]he AI that|[Cc]hatbot|open[- ]source|\b(AI|agent|business) (engine|runtime)\b|\bruntime\b|\bframework\b'

mode_staged=false
[ "${1:-}" = "--staged" ] && mode_staged=true

is_excluded() {
  local f="$1"
  for x in $SELF_EXCLUDE; do [ "$f" = "$x" ] && return 0; done
  return 1
}

# Build the candidate list: the curated copy files (+ package.json), filtered
# to staged when in hook mode. Kept as a while-read loop (no mapfile) for
# macOS bash 3.2.
staged_set=''
if $mode_staged; then
  staged_set="$(git diff --cached --name-only --diff-filter=ACM)"
fi

is_staged() {
  local f="$1"
  printf '%s\n' "$staged_set" | grep -qxF "$f"
}

violations=0

# The curated list must still resolve to something. COPY_FILES is a hand-written
# set of paths, and `scan_line_set` skips a path that does not exist — so renaming
# or moving a copy file silently empties this guard's entire input and it reports
# `clean ✓` while checking nothing. That is the same failure direction as a file
# listing whose producer errored (scripts/lib/guard-file-list.sh): a guard must
# never exit 0 after examining nothing.
#
# Only in tree mode. Under `--staged` an empty candidate set is the normal case —
# most commits touch no copy file at all — so the assertion there would be noise.
if ! $mode_staged; then
  # EVERY entry, not merely one: with two curated files, "at least one present"
  # still let a renamed hero page go unscanned and green — the guard would have
  # kept reporting clean on the half it could still see. The list is curated, so
  # removing a file from the repo is exactly the moment COPY_FILES must be updated.
  _missing=''
  for _f in $COPY_FILES; do [ -f "$_f" ] || _missing="$_missing $_f"; done
  if [ -n "$_missing" ]; then
    echo "❌ positioning-guard: curated COPY_FILES missing:$_missing" >&2
    echo "   Refusing to report clean copy while part of the candidate set is gone;" >&2
    echo "   update COPY_FILES to match the files that exist." >&2
    exit 2
  fi
fi

scan_line_set() {
  # $1 = file, $2 = grep pattern to pre-filter relevant lines (or empty for all)
  local f="$1" prefilter="${2:-}"
  [ -f "$f" ] || return 0
  is_excluded "$f" && return 0
  $mode_staged && ! is_staged "$f" && return 0

  local src
  if [ -n "$prefilter" ]; then
    src="$(grep -nIE "$prefilter" "$f" 2>/dev/null || true)"
  else
    src="$(grep -nIE "$AVOID" "$f" 2>/dev/null || true)"
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;  # inline-allowed (contrast copy)
    esac
    # When a prefilter was used, re-check the avoid pattern on the matched line.
    if [ -n "$prefilter" ]; then
      printf '%s' "$line" | grep -qIE "$AVOID" || continue
    fi
    echo "⚠️  positioning avoid-word in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done <<EOF
$src
EOF
}

for f in $COPY_FILES; do
  scan_line_set "$f" ""
done

# package.json — only the description line.
scan_line_set "$PKG_JSON" '"description"'

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "positioning-guard: ${violations} avoid-word(s) on public copy surfaces."
  echo "Align with POSITIONING.md (Vocabulary → Avoid), or add '${PRAGMA}: <reason>'"
  echo "to the line if it is deliberate contrast copy."
  exit 1
fi

echo "positioning-guard: clean ✓"
