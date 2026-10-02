#!/bin/bash
# What this push transfers, as one `<base> <tip>` line per ref — the ONE derivation of that answer
# for the pre-push hooks that scan a range (public-repo-guard-commits, -meta and -files). They used
# to compute it twice over: one read the pushed refs, the other two took `merge-base origin/main
# HEAD`, so a push of a branch you are not standing on (`git push origin other` from main) scanned
# nothing of `other`.
#
#   bash .lefthook/pre-push/pushed-ranges.sh <hook-name>      (the pre-push ref lines on stdin)
#
# The refs come from git on stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line).
# Only the BACK three fields have a guaranteed form, so a line is matched anchored from the RIGHT:
# the first field is called "local ref" but holds the source exactly as the user typed it
# (`HEAD@{1 second ago}`, with spaces and characters no ref name may carry). It is never put into
# a command and never printed unquoted. A command a person is told to copy names only the remote
# ref (field 3), which git restricts to a real ref name.
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
#   · stdin not readable — closed, or a read error — what is pushed is unknown: refused (exit 2).
# A closed fd 0 is checked FIRST, before any command substitution: the pipe of the first `$(…)`
# would take the free fd 0, and `cat` would later wait on a pipe nobody writes. It is checked by
# duplicating fd 0, because `0<&0` is a no-op that succeeds on a closed fd. `cat` then reports a
# read error in its exit status, which a `while read` loop cannot: there, an error and the end of
# input both just end the loop. The hooks run the same fd check first, for the same reason: their
# own `cd "$(…)"` comes before this script is started.
#
# A terminal on stdin is a hand run (`bash .lefthook/pre-push/<hook>.sh`) and measures the current
# branch as a new ref. That holds only while the hook's lefthook entry sets `use_stdin: true`:
# without it, lefthook hands a script run from a terminal that terminal, and it would measure HEAD
# instead of the pushed refs (the push-level tests run without a terminal and fail on that removal).
# A run from a SCRIPT has no terminal: it reads that script's stdin, and if that is empty it scans
# nothing and says so. A wrapper must pass git's ref lines through on stdin — silence there is not
# a verdict.
#
# Like every hook file, this only runs where it exists: a branch cut from an older main pushes with
# the older hooks until it merges origin/main, which brings the guards along with the base.
label=${1:-pre-push}
unreadable() {
  echo "$label: could not read the refs git hands this hook on stdin, so what this push" >&2
  echo "  transfers is unknown. Push again; a wrapper must pass git's pre-push lines through." >&2
  exit 2
}
if { exec 3<&0; } 2>/dev/null; then exec 3<&-; else unreadable; fi
cd "$(git rev-parse --show-toplevel)" || exit 2
# An object name is 40 hex digits (sha1) or 64 (sha256). This repo is sha1; the check knows both,
# and "zero" means all zeros at either length, so the two can never disagree about a length.
sha='([0-9a-f]{40}|[0-9a-f]{64})'
ref_line="^(.+) $sha ([^ ]+) $sha\$"
is_zero() { [[ $1 =~ ^(0{40}|0{64})$ ]]; }
pairs=()
if [ -t 0 ]; then
  pairs=("HEAD 0000000000000000000000000000000000000000")
else
  input=$(cat) || unreadable
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if ! [[ $line =~ $ref_line ]]; then
      printf '%s: not a pre-push ref line, so the range cannot be told: %q\n' "$label" "${line:0:80}" >&2
      exit 2
    fi
    local_sha=${BASH_REMATCH[2]} remote_ref=${BASH_REMATCH[3]} remote_sha=${BASH_REMATCH[4]}
    is_zero "$local_sha" && continue
    pairs+=("$local_sha $remote_sha $remote_ref")
  done <<<"$input"
  if [ "${#pairs[@]}" -eq 0 ]; then
    echo "$label: no ref is pushed (up to date, rejected, or deletions only) — nothing scanned." >&2
    exit 0
  fi
fi
for pair in "${pairs[@]}"; do
  read -r tip remote remote_ref <<<"$pair"
  if ! is_zero "$remote" && git cat-file -e "${remote}^{commit}" 2>/dev/null; then
    base="$remote"
  elif ! git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
    if ! is_zero "$remote"; then
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
