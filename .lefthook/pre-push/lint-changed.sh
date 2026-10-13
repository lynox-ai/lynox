#!/bin/bash
# eslint over the source files each pushed ref changes, linted in a checkout of the pushed commit
# (scripts/lint-changed.mjs). WHAT is pushed — one `<base> <tip>` range per ref, from git's ref
# lines on stdin — comes from pushed-ranges.sh, so a push of a branch you are not standing on is
# linted as that branch, and a push that only deletes refs lints nothing.
# Before any `$(…)`: a closed stdin would be taken over by the first command substitution's pipe,
# and pushed-ranges.sh would wait on it forever instead of refusing (see the check there).
if { exec 3<&0; } 2>/dev/null; then exec 3<&-; else
  echo "lint-changed: stdin is closed, so what this push transfers is unknown." >&2; exit 2
fi
# The linter and pushed-ranges.sh are found next to this hook, not in the current tree: in a push
# both are the same tree, and a test that runs this hook against another clone runs THESE files.
here="$(cd "$(dirname "$0")" && pwd)"
lint="$here/../../scripts/lint-changed.mjs"
cd "$(git rev-parse --show-toplevel)" || exit 2
ranges=$(bash "$here/pushed-ranges.sh" lint-changed) || exit $?
while read -r base tip; do
  [ -n "$base" ] || continue  # no line at all: the push only deletes refs
  node "$lint" "$base" "$tip" || exit $?
done <<<"$ranges"
exit 0
