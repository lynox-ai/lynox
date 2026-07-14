#!/usr/bin/env bash
#
# no-ai-attribution.sh — keep AI self-attribution out of this history.
#
# The rule (CLAUDE.md, both levels): no `Co-Authored-By: Claude` trailer, no
# `Claude-Session:` link, no "Generated with Claude Code". It is self-promotion and
# does not belong in this repo's history.
#
# The rule existed as prose for months and was broken in 332 of 915 commits on main
# (32 of the last 100 — it was still happening), because the agent harness's system
# prompt INSTRUCTS the model to append those trailers, and prose does not beat a
# default. This script is the mechanism the rule was missing.
#
# Two modes, deliberately asymmetric:
#
#   strip <file>          commit-msg hook. Removes the lines and exits 0 — it does NOT
#                         fail the commit. A hook that aborts mid-commit teaches people
#                         to reach for --no-verify, and the trailer is the harness's
#                         doing, not the committer's. So: fix it silently, every time.
#
#   check <base> <head>   CI. FAILS on any commit in the range that still carries one,
#                         which is the backstop for `--no-verify` and for commits made
#                         where the hook isn't installed. Scans only the range, never
#                         the whole history — the ~917 pre-existing commits are not
#                         being rewritten and must not fail every future PR.
#
# Only Claude's own attribution is touched. A human `Co-Authored-By:` is left alone.

set -uo pipefail

# Match the TRAILER FORM, not merely a line that starts with the word.
#
# The first version of this matched `^claude-session:` and promptly ate a line of this
# very repo's prose — a commit body that began "Claude-Session:, no 'Generated with
# Claude Code'..." while EXPLAINING the rule. A guard that fires on obviously-safe
# lines is the exact failure it was written to prevent, and this one did it silently.
#
# So each pattern demands the shape of the real trailer:
#   Co-Authored-By: Claude … <someone@somewhere>   → must end in an email in angle brackets
#   Claude-Session: https://…                      → must be a bare URL
#   🤖 Generated with [Claude Code](…)             → must start the line
# Prose that merely mentions or quotes them does not match.
PATTERN='^[[:space:]]*co-authored-by:.*claude.*<[^>]+@[^>]+>[[:space:]]*$|^[[:space:]]*claude-session:[[:space:]]*https?://[^[:space:]]+[[:space:]]*$|^[[:space:]]*(🤖[[:space:]]*)?generated with \[?claude code\]?'

usage() {
  echo "usage: no-ai-attribution.sh strip <commit-msg-file>" >&2
  echo "       no-ai-attribution.sh check <base-ref> <head-ref>" >&2
  exit 2
}

strip_file() {
  local f="${1:-}"
  [ -n "$f" ] || usage
  [ -f "$f" ] || { echo "no-ai-attribution: no such file: $f" >&2; exit 0; }

  grep -viE "$PATTERN" -- "$f" > "$f.tmp" || true

  # Deleting a trailer block can leave the message ending in blank lines. Trim them
  # (command substitution eats trailing newlines), then restore exactly one.
  local body
  body="$(cat "$f.tmp")"
  printf '%s\n' "$body" > "$f"
  rm -f "$f.tmp"
  exit 0
}

check_range() {
  local base="${1:-}" head="${2:-}"
  [ -n "$base" ] && [ -n "$head" ] || usage

  local bad=0
  local sha
  # `git rev-list base..head` — only the commits this PR ADDS.
  for sha in $(git rev-list "${base}..${head}" 2>/dev/null); do
    if git show -s --format='%B' "$sha" | grep -qiE "$PATTERN"; then
      if [ "$bad" -eq 0 ]; then
        echo ""
        echo "✗ AI self-attribution found in commit messages:"
        echo ""
      fi
      echo "    $(git show -s --format='%h  %s' "$sha")"
      bad=$((bad + 1))
    fi
  done

  if [ "$bad" -gt 0 ]; then
    cat >&2 <<'EOF'

These carry a `Co-Authored-By: Claude` / `Claude-Session:` trailer or a
"Generated with Claude Code" line. Per CLAUDE.md that must not enter this history.

The commit-msg hook strips them automatically — these were made with the hook
bypassed or absent. To fix, rewrite the messages on your branch:

    git rebase -i <base>          # mark the commits above as `reword`
    # or, for the last commit only:
    git commit --amend            # the hook will strip it on save

Do NOT bypass this check.
EOF
    exit 1
  fi

  echo "no-ai-attribution: clean ✓ ($(git rev-list --count "${base}..${head}" 2>/dev/null || echo 0) commits scanned)"
  exit 0
}

case "${1:-}" in
  strip) shift; strip_file "$@" ;;
  check) shift; check_range "$@" ;;
  *)     usage ;;
esac
