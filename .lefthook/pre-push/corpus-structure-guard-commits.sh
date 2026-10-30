#!/bin/bash
# The files each commit this push ADDS OR CHANGES, read for the shape of an eval corpus (an object carrying a
# `turns` or `gold` array). Of the three callers this hook is the last one that runs BEFORE
# publication: the CI step runs after the push, when the commit is already readable on the pull
# request. A push with hooks switched off (`--no-verify`) is not read here; the CI step still
# refuses the merge. The pre-commit command reads the index; this one also covers a commit made
# without it.
#
# WHAT is pushed — one `<base> <tip>` range per pushed ref — comes from pushed-ranges.sh, shared
# with the other range hooks. A refusal there is exit 2 here, with its reason.
# Before any `$(…)`: a closed stdin would be taken over by the first command substitution's pipe,
# and pushed-ranges.sh would wait on it forever instead of refusing (see the check there).
if { exec 3<&0; } 2>/dev/null; then exec 3<&-; else
  echo "corpus-structure-guard-commits: stdin is closed, so what this push transfers is unknown." >&2; exit 2
fi
cd "$(git rev-parse --show-toplevel)" || exit 2
ranges=$(bash .lefthook/pre-push/pushed-ranges.sh corpus-structure-guard-commits) || exit $?
while read -r base tip; do
  [ -n "$base" ] || continue  # no line at all: the push only deletes refs
  node scripts/corpus-structure-guard.mjs "$base" "$tip" --allow-empty || exit $?
done <<<"$ranges"
exit 0
