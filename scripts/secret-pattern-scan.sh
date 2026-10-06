#!/usr/bin/env bash
#
# secret-pattern-scan.sh — pre-commit: refuse a commit whose staged changes ADD a
# line that looks like a credential. The belt to gitleaks' braces: gitleaks runs in
# CI on every pull request and is the gate; this stops the key before it is a commit.
#
#   exit 0  nothing found
#   exit 1  a staged change adds a line matching a credential pattern
#   exit 2  the staged diff could not be read — the scan did not run
#
# WHAT IS SCANNED: the lines the commit adds, read from the index
# (`git diff --cached`), not whole files from the working tree. Two reasons:
#   - The index is what gets committed. A file read from the working tree can hold
#     an unstaged edit the commit does not carry, either way round.
#   - Whole files would refuse every commit that touches a file which already holds
#     a key-shaped test fixture. About twenty such files exist, and a guard that
#     fires on lines nobody touched is one people learn to bypass. The question this
#     answers is "does THIS commit introduce one".
# Rename detection is explicit (`-M`), whatever `diff.renames` says: a file MOVED
# with a key-shaped fixture in it adds no line, while a line changed during the
# move is still an added line and is scanned.
#
# This file holds the patterns it looks for, so its own added lines are skipped.
# gitleaks still reads it.
set -uo pipefail

# `sk-ant-` needs a key BODY: the bare prefix is code (a validator's `startsWith`).
PATTERN='(sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36}|xoxb-|xapp-|-----BEGIN (RSA |EC )?PRIVATE KEY-----)'
SELF='scripts/secret-pattern-scan.sh'

DIFF="$(mktemp)"
trap 'rm -f "$DIFF"' EXIT

# The producer's STATUS, not the length of its output: an empty diff is a commit
# with nothing staged and is clean; a diff that FAILED is a scan that did not run.
# `--text --no-textconv`: a file git would call binary, or show through a textconv
# driver, is still read as its staged bytes. Explicit prefixes: `diff.noprefix`
# would otherwise change the `b/` the header parse below relies on.
if ! git diff --cached --no-color --no-ext-diff --text --no-textconv --src-prefix=a/ --dst-prefix=b/ -M -U0 > "$DIFF"; then
  printf '\n✗ secret-pattern-scan: could not read the staged changes (not a git work tree?).\n' >&2
  printf '   Refusing to report a clean commit on a scan that did not run.\n\n' >&2
  exit 2
fi

# Each added line, prefixed with its file from the `+++ b/<path>` header. The
# matching is grep's, not awk's: `{20,}` intervals are not portable across awks
# (older mawk and the BSD awk on macOS, where this hook runs, differ).
ADDED="$(mktemp)"
trap 'rm -f "$DIFF" "$ADDED"' EXIT
# A file header counts only between `diff --git` and the first `@@`: an ADDED line
# whose own text begins with `++ ` is still a content line, not a new file name.
if ! awk -v self="$SELF" '
  /^diff --git / { inhunk = 0; next }
  /^@@/ { inhunk = 1; next }
  !inhunk && /^\+\+\+ / { file = substr($0, 7); next }
  inhunk && /^\+/ { if (file != self) print file ": " substr($0, 2) }
' "$DIFF" > "$ADDED"; then
  printf '\n✗ secret-pattern-scan: could not split the staged changes into lines.\n' >&2
  printf '   Refusing to report a clean commit on a scan that did not run.\n\n' >&2
  exit 2
fi

# grep: 0 = a match, 1 = none, anything else = it could not read. `-a` because the
# lines come from `--text` above and may carry a NUL byte.
hits="$(grep -aE -- "$PATTERN" "$ADDED")"
rc=$?
if [ "$rc" -gt 1 ]; then
  printf '\n✗ secret-pattern-scan: the pattern match itself failed (grep exit %s).\n' "$rc" >&2
  printf '   Refusing to report a clean commit on a scan that did not run.\n\n' >&2
  exit 2
fi
hits="$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/  /')"

if [ "$rc" -eq 0 ]; then
  printf '\n✗ Potential secrets in lines this commit adds:\n\n%s\n\n' "$hits"
  printf 'Remove them before committing. A test that needs a key-shaped value can build\n'
  printf 'it at run time (see LOOKS_LIKE_A_KEY in the tests). If this is a false positive,\n'
  printf 'narrow the pattern in %s — do not bypass the hook.\n\n' "$SELF"
  exit 1
fi

exit 0
