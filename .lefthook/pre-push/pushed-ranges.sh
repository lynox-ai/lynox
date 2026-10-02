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
#   · a deleted ref (local sha all zeros) adds nothing and yields no line, so a push that only
#     deletes yields none at all;
#   · a ref the remote already has is measured from the remote's sha: exactly what this push adds;
#   · a new ref is measured from where it leaves origin/main.
# A new ref with no origin/main to compare against, or one that shares no history with it, has no
# range that can be told; that is refused (exit 2) with the reason and the command that fixes it,
# not passed as an empty range. An empty range only announces itself to someone reading the
# output, and the -meta and -files classes have no CI twin to catch what it lets through.
# Without any ref on stdin — a manual run — the current branch is measured as a new ref.
#
# Like every hook file, this only runs where it exists: a branch cut from an older main pushes with
# the older hooks until it merges origin/main, which brings the guards along with the base.
cd "$(git rev-parse --show-toplevel)" || exit 2
label=${1:-pre-push}
zero='0000000000000000000000000000000000000000'
pairs=()
refs=0
if [ ! -t 0 ]; then
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    refs=$((refs + 1))
    [ "$local_sha" = "$zero" ] && continue
    pairs+=("$local_sha ${remote_sha:-$zero}")
  done
fi
# Only a run that was handed no ref at all measures HEAD. A push that only deletes refs was handed
# refs and transfers nothing, so it yields no line — measuring HEAD there would scan, and could
# refuse, commits that are not being pushed.
[ "$refs" -gt 0 ] || pairs=("HEAD $zero")
for pair in "${pairs[@]}"; do
  tip="${pair%% *}"
  remote="${pair##* }"
  if [ "$remote" != "$zero" ] && git cat-file -e "${remote}^{commit}" 2>/dev/null; then
    base="$remote"
  elif ! git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
    echo "$label: there is no origin/main here to measure a new branch against." >&2
    echo "  Fetch it, then push again:  git fetch origin main:refs/remotes/origin/main" >&2
    exit 2
  elif ! base="$(git merge-base origin/main "$tip" 2>/dev/null)"; then
    echo "$label: ${tip:0:9} shares no history with origin/main, so the commits it" >&2
    echo "  adds cannot be told apart. Branch it from main." >&2
    exit 2
  fi
  printf '%s %s\n' "$base" "$tip"
done
exit 0
