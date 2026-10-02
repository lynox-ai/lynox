#!/usr/bin/env bash
# ci-docs-only.sh <base> <head> — print `docs-only=true` when EVERY file changed between the two
# commits lives under docs/, else `docs-only=false`. Used by the `detect` job in ci.yml.
#
# The answer decides whether the expensive required jobs (docker-scan, greenmail, smoke) run,
# so every doubt answers `false` — they then run for real:
#   · an empty change list (nothing to prove docs-only),
#   · a base of all zeros (the first push of a branch; there is no "before"),
#   · a base or head git cannot resolve.
# A git failure is NOT turned into `false` silently: the script exits non-zero, the `detect` job
# fails, and the required jobs' condition runs them anyway (see ci.yml). Two different paths, both
# towards "run the checks".
set -euo pipefail
base=${1:-}
head=${2:-}
if [ -z "$base" ] || [ -z "$head" ] || [[ "$base" =~ ^0+$ ]]; then
  echo "docs-only=false"
  echo "verdict: no usable base ($base) — running every check" >&2
  exit 0
fi
changed=$(git diff --name-only "$base...$head")
if [ -z "$changed" ]; then
  echo "docs-only=false"
  echo "verdict: empty change list — running every check" >&2
  exit 0
fi
echo "changed files:" >&2
printf '%s\n' "$changed" | sed 's/^/  /' >&2
if printf '%s\n' "$changed" | grep -qv '^docs/'; then
  echo "docs-only=false"
  echo "verdict: code touched — running every check" >&2
else
  echo "docs-only=true"
  echo "verdict: docs-only — docker-scan, greenmail and smoke are SKIPPED, their core step does not run; gitleaks and test still run" >&2
fi
