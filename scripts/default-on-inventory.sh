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
# It also reads the feature flags' own defaults: every `true` entry of
# `CORE_FEATURE_DEFAULTS` in `src/core/features.ts`, recorded as `feature:<name>`.
# `isFeatureEnabled` falls back to that table when the flag's env var is unset, so a
# `false → true` there ships the feature on every instance that sets nothing, the same
# rollout as a `?? true`. Until this read existed, such a flip passed this guard green.
# It reads the table literal, not what `isFeatureEnabled` returns: a special case in the
# resolver is not read. The table's name may stand on exactly two lines of the file, its
# declaration and the one read, which must be the line below word for word; any other
# mention (an assignment, `Object.assign`, an alias, also on the read's own line) stops the
# run, because the literal would no longer be the whole default.
# Flags registered at runtime (`registerFeature`) are not in the table and not read here.
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

# Every `sort` and `comm` below runs under `LC_ALL=C`, per command. `comm` needs
# both inputs in its own order, and with uutils coreutils (Ubuntu 26.04's default)
# `sort` collates by locale while `comm` compares bytes. Under en_US.UTF-8 that
# reported recorded flags as new, and `sort -u` merged names that collate equal
# (`a_b_c` and `abc`), so a schema field could drop out of the scan. Per command,
# not exported, so the greps keep the caller's locale.

SCHEMA="src/types/schemas.ts"
FEATURES="src/core/features.ts"
INVENTORY="scripts/default-on-inventory.txt"
[ -f "$SCHEMA" ] || { echo "default-on-inventory: cannot find $SCHEMA" >&2; exit 1; }
[ -f "$FEATURES" ] || { echo "default-on-inventory: cannot find $FEATURES" >&2; exit 1; }

# The config field names, straight from the schema. Anything not declared there is
# not an operator-facing flag and is out of scope by construction.
FIELDS="$(grep -oE '^\s{2}[a-z_][a-z0-9_]*:' "$SCHEMA" | tr -d ' :' | LC_ALL=C sort -u)"
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

# The feature flags' defaults: the `CORE_FEATURE_DEFAULTS` object literal, one entry per
# line. Read fail-closed: no entry, or any line in it that is neither a `//` comment nor
# a `'name': true|false,` entry (a constant, an expression, a value on the next line, an
# unquoted key, a spread, a `/* */` comment) stops the run instead of reading as "nothing
# default-ON". Block comments are refused rather than parsed: parsing them is where a
# `true` hides.
FEATURE_READ='  return CORE_FEATURE_DEFAULTS[flag as FeatureFlag] ?? _dynamicDefaults.get(flag) ?? false;'
# Lines that name the table. A second name on the read's line fails the word-for-word
# match below; `|| true` keeps a count of 0 from ending the run silently under `set -e`.
feature_mentions="$(grep -c 'CORE_FEATURE_DEFAULTS' "$FEATURES" || true)"
if [ "$feature_mentions" -ne 2 ] || ! grep -qE '^const CORE_FEATURE_DEFAULTS[^=]*= \{[[:space:]]*$' "$FEATURES" \
   || ! grep -qxF "$FEATURE_READ" "$FEATURES"; then
  echo "default-on-inventory: CORE_FEATURE_DEFAULTS is named on ${feature_mentions} lines of $FEATURES, expected its declaration (ending in '{') and the one read in isFeatureEnabled, word for word: '${FEATURE_READ}' — a write elsewhere would change a default the table does not show; refusing to report a clean run" >&2
  exit 1
fi
# The check above made the opening line end at `{`, so no entry can sit on it, outside the
# lines read below.
FEATURE_BLOCK="$(LC_ALL=C sed -n '/^const CORE_FEATURE_DEFAULTS[^=]*= {/,/^};/p' "$FEATURES")"
# The lines between the opening and the closing line that are not blank or a `//` comment.
feature_lines="$(printf '%s\n' "$FEATURE_BLOCK" | sed '1d;$d' | LC_ALL=C grep -cvE '^[[:space:]]*($|//)' || true)"
feature_literal="$(printf '%s\n' "$FEATURE_BLOCK" | sed '1d;$d' \
  | LC_ALL=C grep -cE "^[[:space:]]*'[a-z0-9-]+':[[:space:]]*(true|false),?[[:space:]]*(//.*)?$" || true)"
if [ "$feature_literal" -eq 0 ] || [ "$feature_lines" -ne "$feature_literal" ]; then
  echo "default-on-inventory: read ${feature_literal} of ${feature_lines} lines of CORE_FEATURE_DEFAULTS in $FEATURES as a literal true or false entry — refusing to report a clean run" >&2
  exit 1
fi
for name in $(printf '%s\n' "$FEATURE_BLOCK" | LC_ALL=C sed -nE "s/^[[:space:]]*'([a-z0-9-]+)':[[:space:]]*true,?[[:space:]]*(\/\/.*)?$/\1/p"); do
  found="${found}feature:${name}"$'\n'
done

found="$(printf '%s' "$found" | sed '/^$/d' | LC_ALL=C sort -u)"

if [ "${1:-}" = "--update" ]; then
  { echo "# Config and feature flags whose ABSENCE means ENABLED — regenerate with scripts/default-on-inventory.sh --update"
    echo "# A \`feature:<name>\` line is a \`true\` in CORE_FEATURE_DEFAULTS (src/core/features.ts): unset env var means on."
    echo "# Adding a line here is a deliberate statement: this ships ON for every instance that sets nothing."
    printf '%s\n' "$found"
  } > "$INVENTORY"
  echo "default-on-inventory: wrote $(printf '%s' "$found" | grep -c . || true) entries to $INVENTORY"
  exit 0
fi

[ -f "$INVENTORY" ] || { echo "default-on-inventory: $INVENTORY missing — run with --update" >&2; exit 1; }
known="$(grep -vE '^\s*(#|$)' "$INVENTORY" | LC_ALL=C sort -u)"

new="$(LC_ALL=C comm -23 <(printf '%s\n' "$found") <(printf '%s\n' "$known") | sed '/^$/d')"
gone="$(LC_ALL=C comm -13 <(printf '%s\n' "$found") <(printf '%s\n' "$known") | sed '/^$/d')"

rc=0
if [ -n "$new" ]; then
  echo "::error::default-on-inventory: config or feature flag(s) now default to ENABLED and are not recorded:"
  printf '  - %s\n' $new
  echo ""
  echo "  Each of these runs on every instance that sets nothing. That is a rollout."
  echo "  If it is intended, record it: scripts/default-on-inventory.sh --update"
  echo "  If it is not, give the flag an explicit false default and ship it opt-IN."
  echo "  (A \`feature:<name>\` entry is a \`true\` in CORE_FEATURE_DEFAULTS, src/core/features.ts.)"
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
