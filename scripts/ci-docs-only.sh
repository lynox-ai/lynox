#!/usr/bin/env bash
# ci-docs-only.sh <base> <head> — print `docs-only=true` when EVERY file changed between the two
# commits lives under docs/, else `docs-only=false`. Used by the `detect` job in ci.yml.
#
# The answer decides whether the expensive required jobs (docker-scan, greenmail, smoke) run,
# so every doubt answers `false` — they then run for real:
#   · an empty change list (nothing to prove docs-only),
#   · a base of all zeros (the first push of a branch; there is no "before"), or no base at all.
# A base or head git cannot resolve is NOT turned into `false`: git fails, the script exits
# non-zero, the `detect` job fails, and the gated jobs' condition runs them anyway (see ci.yml).
# Two different paths, both towards "run the checks".
#
# Two traps, both measured by a refute round before this shipped:
#   · `--no-renames`: by default `git diff --name-only` reports a rename by its NEW path only, so
#     `git mv src/core.ts docs/core.ts` listed just `docs/core.ts` and read as docs-only.
#   · the test reads the list from a here-string, not from `printf … | grep -q`: under `pipefail`,
#     `grep -q` exits at its first match, `printf` dies of SIGPIPE on a list larger than the pipe
#     buffer, and the failed pipeline sent an early non-docs path into the docs-only branch.
# And two more, from the round after: a grep that FAILS (exit 2) is not "no match" — it aborts
# here; and a submodule (gitlink, mode 160000) changed under docs/ is code, not docs.
set -euo pipefail
base=${1:-}
head=${2:-}
if [ -z "$base" ] || [ -z "$head" ] || [[ "$base" =~ ^0+$ ]]; then
  echo "docs-only=false"
  echo "verdict: no usable base ($base) — running every check" >&2
  exit 0
fi
changed=$(git diff --no-renames --name-only "$base...$head")
if [ -z "$changed" ]; then
  echo "docs-only=false"
  echo "verdict: empty change list — running every check" >&2
  exit 0
fi
echo "changed files:" >&2
printf '%s\n' "$changed" | sed 's/^/  /' >&2
# A gitlink is a submodule pointer: whatever it points at is code, wherever it is mounted.
# grep's exit code is read, never just tested: 0 = a match, 1 = none, anything else = grep itself
# failed — and a failure must not read as "no match", in either check.
match() { local rc=0; grep "$@" || rc=$?; if [ "$rc" -gt 1 ]; then echo "verdict: grep failed (exit $rc) — refusing to classify" >&2; exit 2; fi; return "$rc"; }
raw=$(git diff --no-renames --raw "$base...$head")
if match -qE '^:(160000 [0-7]{6}|[0-7]{6} 160000) ' <<<"$raw"; then
  echo "docs-only=false"
  echo "verdict: a submodule pointer changed — running every check" >&2
  exit 0
fi
rc=0
match -qv '^docs/' <<<"$changed" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "docs-only=false"
  echo "verdict: code touched — running every check" >&2
else
  echo "docs-only=true"
  echo "verdict: docs-only — docker-scan, greenmail and smoke are SKIPPED, their core step does not run; gitleaks and test still run" >&2
fi
