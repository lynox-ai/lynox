#!/bin/bash
# The customer-name class over the PATHS and CONTENT of every commit in the range. A lefthook
# script rather than a command, because a command is skipped whenever the checked-out HEAD has no
# file diff against its upstream — e.g. a range that adds a file and deletes it again, the case
# this half walks every commit to catch. Range expression and reasons: lefthook.yml.
cd "$(git rev-parse --show-toplevel)" && exec bash scripts/public-repo-guard.sh check-files "$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)" HEAD
