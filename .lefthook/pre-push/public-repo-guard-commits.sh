#!/bin/bash
# The lines each commit this push adds, for an internal register id or wording that marks a
# security finding as open. This hook is what keeps such a line from being PUBLISHED: the CI job
# runs after the push, when the commit is already readable on the pull request.
#
# WHAT is pushed — one `<base> <tip>` range per pushed ref, from the ref lines on stdin — comes
# from pushed-ranges.sh, shared with the -meta and -files hooks so the three cannot disagree about
# it. A refusal there (no origin/main, no shared history) is exit 2 here, with its reason.
#
# This file only runs where it exists: a branch cut from a main older than this hook pushes
# unchecked until it merges origin/main — which brings the guards along with the base. The CI job
# covers pull requests and main; a pushed branch without a pull request is covered by neither.
cd "$(git rev-parse --show-toplevel)" || exit 2
ranges=$(bash .lefthook/pre-push/pushed-ranges.sh public-repo-guard-commits) || exit $?
while read -r base tip; do
  [ -n "$base" ] || continue  # no line at all: the push only deletes refs
  bash scripts/public-repo-guard.sh check-commits "$base" "$tip" --allow-empty || exit $?
done <<<"$ranges"
exit 0
