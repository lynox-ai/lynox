#!/usr/bin/env bash
#
# guard-file-list.sh — the one way a guard is allowed to build the list of files
# it scans. Sourced, not executed.
#
# WHY THIS EXISTS. A guard that enumerates files with
#
#     while IFS= read -r -d '' f; do … done < <(git ls-files -z)
#
# cannot see its producer fail. A process substitution hides its exit status from
# `set -e` completely, so when `git ls-files` errors — no work tree, a broken
# repo, a `--range` whose base does not resolve, a missing directory — the loop
# iterates ZERO times, no violation is found, and the guard exits 0 with its
# usual "clean ✓". The tick still appears. For a guard whose entire job is to
# refuse, passing because it looked at nothing is the worst possible failure
# direction, and it is invisible: in the output, "scanned and clean" and "scanned
# nothing" are the same line.
#
# This has already cost us once. The pro secret-pattern-scan ran in hook mode in
# CI, where the index is empty — it scanned zero files and passed, and the fix at
# the time was to switch the invocation to `--range`, i.e. the symptom. The shape
# survived, in this repo too.
#
# WHAT IT DOES, and the two decisions inside it:
#
#   1. It checks the PRODUCER'S STATUS, not the count. An empty listing is a
#      legitimate outcome — `--staged` with nothing staged, a pathspec that
#      matches no file in this tree — and failing on it would make the guard cry
#      wolf. What must never pass silently is a listing that FAILED.
#   2. It writes to a FILE and the caller reads from that file. The redirect at
#      the loop is then a plain `< "$dest"`, which cannot swallow anything,
#      because the producer already ran and was already judged. Command
#      substitution is not an option: `$(git ls-files -z)` strips the NUL bytes
#      that separate the entries.
#
# Callers must read NUL-separated (`read -r -d ''`), matching `-z` above.
#
# The companion to this file is tests/guard-harness.test.ts, which does not read
# this source at all: it feeds every gate script a broken producer and asserts a
# non-zero exit. A guard that stops using this helper, or reimplements the listing
# in a shape no pattern anticipated, fails there rather than here.

# Write a NUL-separated `git ls-files` listing for the given pathspecs into $1,
# aborting the whole guard (exit 2) if git could not produce it.
#
# Usage:  guard_list_files_or_die "$dest" [pathspec…]
guard_list_files_or_die() {
  local dest="${1:?guard_list_files_or_die needs a destination file}"; shift
  if ! git ls-files -z "$@" > "$dest"; then
    guard_listing_failed
  fi
}

# Newline-separated variant, for the one consumer that needs a line-oriented list
# rather than a read loop: drift-guard's `exists_path` greps the whole listing as
# a here-string. `-c core.quotePath=false` because that grep is line-based — git's
# default quoting would wrap a non-ASCII path in quotes and break the suffix
# anchor. (`-z` is right for a read loop and wrong here; the two variants exist so
# neither consumer has to hand-roll the listing and lose the status check.)
guard_list_paths_or_die() {
  local dest="${1:?guard_list_paths_or_die needs a destination file}"; shift
  if ! git -c core.quotePath=false ls-files "$@" > "$dest"; then
    guard_listing_failed
  fi
}

# Same, for a guard that lists the STAGED changes instead of the tree.
guard_list_staged_or_die() {
  local dest="${1:?guard_list_staged_or_die needs a destination file}"; shift
  if ! git diff --cached --name-only -z --diff-filter=ACM -- "$@" > "$dest"; then
    guard_listing_failed
  fi
}

# The shared refusal. Exit 2, distinct from the guards' own exit 1 ("I found
# something"), so a caller can tell "the gate found a violation" from "the gate
# could not run" — the second is an infrastructure fault, not a dirty tree.
guard_listing_failed() {
  echo "❌ ${GUARD_NAME:-guard}: could not list the files to scan (not a git work tree?)." >&2
  echo "   Refusing to report a clean tree on a listing that failed." >&2
  exit 2
}
