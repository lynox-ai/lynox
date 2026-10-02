#!/bin/bash
# The customer-name class over the PATHS and CONTENT of every commit in the range. A lefthook
# script rather than a command, because a command is skipped whenever the checked-out HEAD has no
# file diff against its upstream — e.g. a range that adds a file and deletes it again, the case
# this half walks every commit to catch.
#
# WHAT is pushed comes from pushed-ranges.sh (the pushed refs on stdin), shared with the -commits
# and -meta hooks. It used to be `merge-base origin/main HEAD`..HEAD, so pushing a branch you are
# not standing on scanned nothing of it. A refusal there (no origin/main, no shared history) is
# exit 2 here, with the command that fixes it.
cd "$(git rev-parse --show-toplevel)" || exit 2
ranges=$(bash .lefthook/pre-push/pushed-ranges.sh public-repo-guard-files) || exit $?
while read -r base tip; do
  [ -n "$base" ] || continue  # no line at all: the push only deletes refs
  bash scripts/public-repo-guard.sh check-files "$base" "$tip" || exit $?
done <<<"$ranges"
exit 0
