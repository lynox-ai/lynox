#!/usr/bin/env bash
# default-on-inventory.sh — pin every CONFIG flag whose absence means ENABLED.
#
# WHY THIS EXISTS
#
# v2.11.0 shipped `http_html_extract` reading `?? true` (tools/builtin/http.ts).
# Unset meant ON, so a brand-new 594-line HTML parser went live on every instance
# the moment they took the release — nobody decided that, and nobody noticed until
# the operator asked a question three hours after the tag. The flag was reviewed,
# the tests were green, the release gates passed. None of them ask "what runs when
# an operator sets nothing?"
#
# That is the whole failure class: a gated path is only as gated as its DEFAULT.
# An opt-OUT flag is a rollout with no rollout plan.
#
# WHAT IT DOES
#
# Extracts the config fields (from the config schema), finds where each one is
# read, and flags reads that apply a truthy default:
#     x ?? true        — unset means on
#     x !== false      — anything but an explicit false means on
#     .default(true)   — the schema itself decides on
# Then diffs that set against `scripts/default-on-inventory.txt`. A new default-ON
# flag that is not in the file fails. Adding the line is the deliberate act — it
# is a one-line acknowledgement that this ships enabled, which is exactly the
# decision that was missing.
#
# WHAT IT DELIBERATELY DOES NOT DO
#
# It ignores plain function options (`opts?.mergeTurns ?? true`). There are ~23 of
# those and they are not a rollout surface; flagging them would make this noisy,
# and a noisy guard gets ignored, which is worse than no guard at all.
#
# Usage:  scripts/default-on-inventory.sh [--update]
#   --update  rewrite the inventory from the current tree (review the diff!)

set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA="src/types/schemas.ts"
INVENTORY="scripts/default-on-inventory.txt"
[ -f "$SCHEMA" ] || { echo "default-on-inventory: cannot find $SCHEMA" >&2; exit 1; }

# The config field names, straight from the schema. Anything not declared there is
# not an operator-facing flag and is out of scope by construction.
FIELDS="$(grep -oE '^\s{2}[a-z_][a-z0-9_]*:' "$SCHEMA" | tr -d ' :' | sort -u)"
[ -n "$FIELDS" ] || { echo "default-on-inventory: read zero fields from $SCHEMA — the file's shape changed, refusing to report a clean run" >&2; exit 1; }

found=""
for f in $FIELDS; do
  # A read of this field that installs a truthy default. Both the `?? true` and the
  # `!== false` shapes, on the same line as the field name.
  if grep -rnE "(${f}[^a-z0-9_].{0,40}\?\?[[:space:]]*true|${f}[^a-z0-9_].{0,40}!==[[:space:]]*false)" \
       src/ --include='*.ts' 2>/dev/null | grep -qv '\.test\.'; then
    found="${found}${f}"$'\n'
    continue
  fi
  # …or the schema hands it a true default itself.
  if grep -qE "^\s{2}${f}:.*\.default\(true\)" "$SCHEMA" 2>/dev/null; then
    found="${found}${f}"$'\n'
  fi
done
found="$(printf '%s' "$found" | sed '/^$/d' | sort -u)"

if [ "${1:-}" = "--update" ]; then
  { echo "# Config flags whose ABSENCE means ENABLED — regenerate with scripts/default-on-inventory.sh --update"
    echo "# Adding a line here is a deliberate statement: this ships ON for every instance that sets nothing."
    printf '%s\n' "$found"
  } > "$INVENTORY"
  echo "default-on-inventory: wrote $(printf '%s' "$found" | grep -c . || true) entries to $INVENTORY"
  exit 0
fi

[ -f "$INVENTORY" ] || { echo "default-on-inventory: $INVENTORY missing — run with --update" >&2; exit 1; }
known="$(grep -vE '^\s*(#|$)' "$INVENTORY" | sort -u)"

new="$(comm -23 <(printf '%s\n' "$found") <(printf '%s\n' "$known") | sed '/^$/d')"
gone="$(comm -13 <(printf '%s\n' "$found") <(printf '%s\n' "$known") | sed '/^$/d')"

rc=0
if [ -n "$new" ]; then
  echo "::error::default-on-inventory: config flag(s) now default to ENABLED and are not recorded:"
  printf '  - %s\n' $new
  echo ""
  echo "  Each of these runs on every instance that sets nothing. That is a rollout."
  echo "  If it is intended, record it: scripts/default-on-inventory.sh --update"
  echo "  If it is not, give the flag an explicit false default and ship it opt-IN."
  rc=1
fi
if [ -n "$gone" ]; then
  # Not a failure — a flag becoming opt-in is the good direction. Say so loudly
  # anyway, because a silently disappearing entry is how the file rots.
  echo "default-on-inventory: recorded flag(s) no longer default ON (tidy the inventory):"
  printf '  - %s\n' $gone
fi

[ "$rc" -eq 0 ] && echo "default-on-inventory: clean ✓ ($(printf '%s' "$found" | grep -c . || true) recorded default-ON flags)"
exit "$rc"
