#!/bin/bash
# The customer-name class over commit MESSAGES. A lefthook script rather than a command, because a
# command is skipped whenever the checked-out HEAD has no file diff against its upstream — an empty
# commit, say — and a message has no file.
#
# WHAT is pushed comes from pushed-ranges.sh (the pushed refs on stdin), shared with the -commits
# and -files hooks. It used to be `merge-base origin/main HEAD`..HEAD, so pushing a branch you are
# not standing on scanned nothing of it. A refusal there (no origin/main, no shared history) is
# exit 2 here, with the command that fixes it.
cd "$(git rev-parse --show-toplevel)" || exit 2
ranges=$(bash .lefthook/pre-push/pushed-ranges.sh public-repo-guard-meta) || exit $?
while read -r base tip; do
  [ -n "$base" ] || continue  # no line at all: the push only deletes refs
  bash scripts/public-repo-guard.sh check-meta "$base" "$tip" || exit $?
done <<<"$ranges"
exit 0
