#!/bin/bash
# What this push transfers, as one `<base> <tip>` line per ref — the ONE derivation of that answer
# for the pre-push hooks that scan a range (public-repo-guard-commits, -meta and -files). They used
# to compute it twice over: one read the pushed refs, the other two took `merge-base origin/main
# HEAD`, so a push of a branch you are not standing on (`git push origin other` from main) scanned
# nothing of `other`.
#
#   bash .lefthook/pre-push/pushed-ranges.sh <hook-name>      (the pre-push ref lines on stdin)
#
# The refs come from git on stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line):
#   · a deleted ref (local sha all zeros) adds nothing and yields no line;
#   · a ref whose remote sha this clone has is measured from it: exactly what this push adds;
#   · a new ref is measured from where it leaves origin/main;
#   · a ref the remote has at a sha this clone LACKS (someone else pushed it) is measured like a new
#     ref — more than this push adds, never less.
# Where no range can be told it is refused (exit 2) with the reason and the command that fixes it,
# not passed as an empty range: no origin/main to measure from, no shared history, a line that is
# not a ref line. An empty range only announces itself to someone reading the output, and the -meta
# and -files classes have no CI twin to catch what it lets through.
#
# "No ref lines" has two causes that need opposite answers, and they are told apart by whether
# stdin could be READ, not by what came out of it:
#   · stdin read to its end and empty — git sends no line for a push with nothing to do (up to
#     date, or every ref rejected): nothing is transferred, so nothing is scanned and none is
#     yielded;
#   · stdin not readable (closed, a read error) — what is pushed is unknown: refused (exit 2).
# `cat` reports a read error in its exit status, which a `while read` loop cannot: there, an error
# and the end of input both just end the loop.
#
# A terminal on stdin is a hand run (`bash .lefthook/pre-push/<hook>.sh`) and measures the current
# branch as a new ref. A run from a SCRIPT has no terminal: it reads that script's stdin, and if
# that is empty it scans nothing and says so. A wrapper must pass git's ref lines through on stdin
# — silence there is not a verdict.
#
# Like every hook file, this only runs where it exists: a branch cut from an older main pushes with
# the older hooks until it merges origin/main, which brings the guards along with the base.
cd "$(git rev-parse --show-toplevel)" || exit 2
label=${1:-pre-push}
zero='0000000000000000000000000000000000000000'
ref_line='^[^ ]+ [0-9a-f]{40}([0-9a-f]{24})? [^ ]+ [0-9a-f]{40}([0-9a-f]{24})?$'
pairs=()
if [ -t 0 ]; then
  pairs=("HEAD $zero")
else
  if ! input=$(cat); then
    echo "$label: could not read the refs git hands this hook on stdin, so what this push" >&2
    echo "  transfers is unknown. Push again; a wrapper must pass git's pre-push lines through." >&2
    exit 2
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! [[ $line =~ $ref_line ]]; then
      echo "$label: not a pre-push ref line, so the range cannot be told: ${line:0:80}" >&2
      exit 2
    fi
    read -r _local_ref local_sha remote_ref remote_sha <<<"$line"
    [ "$local_sha" = "$zero" ] && continue
    pairs+=("$local_sha $remote_sha $remote_ref")
  done <<<"$input"
  if [ "${#pairs[@]}" -eq 0 ]; then
    echo "$label: no ref is pushed (up to date, rejected, or deletions only) — nothing scanned." >&2
    exit 0
  fi
fi
for pair in "${pairs[@]}"; do
  read -r tip remote remote_ref <<<"$pair"
  if [ "$remote" != "$zero" ] && git cat-file -e "${remote}^{commit}" 2>/dev/null; then
    base="$remote"
  elif ! git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
    if [ "$remote" != "$zero" ]; then
      echo "$label: the remote has ${remote_ref:-this ref} at ${remote:0:9}, which this clone does not have," >&2
      echo "  and there is no origin/main to measure from instead." >&2
      echo "  Fetch it, then push again:  git fetch origin $remote_ref" >&2
    else
      echo "$label: there is no origin/main here to measure a new branch against." >&2
      echo "  Fetch it, then push again:  git fetch origin main:refs/remotes/origin/main" >&2
    fi
    exit 2
  elif ! base="$(git merge-base origin/main "$tip" 2>/dev/null)"; then
    echo "$label: ${tip:0:9} shares no history with origin/main, so the commits it" >&2
    echo "  adds cannot be told apart. Branch it from main." >&2
    exit 2
  fi
  printf '%s %s\n' "$base" "$tip"
done
exit 0
