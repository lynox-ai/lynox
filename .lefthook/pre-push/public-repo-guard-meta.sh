#!/bin/bash
# The customer-name class over commit MESSAGES. A lefthook script rather than a command, because a
# command is skipped whenever the checked-out HEAD has no file diff against its upstream — an empty
# commit, say — and a message has no file. The
# range expression, its `|| echo HEAD` fallback and the reasons for both are in lefthook.yml.
cd "$(git rev-parse --show-toplevel)" && exec bash scripts/public-repo-guard.sh check-meta "$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD)" HEAD
