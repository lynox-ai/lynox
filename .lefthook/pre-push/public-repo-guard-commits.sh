#!/bin/bash
# The lines each commit this push adds, for an internal register id or wording that marks a
# security finding as open. This hook is what keeps such a line from being PUBLISHED: the CI job
# runs after the push, when the commit is already readable on the pull request.
#
# The refs come from git on stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line),
# so a push of a branch you are not standing on is checked as what it pushes, not as HEAD.
#   · a deleted ref (local sha all zeros) adds nothing;
#   · a ref the remote already has is checked from the remote's sha: exactly what this push adds;
#   · a new ref is checked from where it leaves origin/main.
# A new ref with no origin/main to compare against, or one that shares no history with it, has
# no range that can be told; that is refused (exit 2) with the reason, not passed.
# Without stdin — a manual run — the current branch is checked as a new ref.
#
# This file only runs where it exists: a branch cut from a main older than this hook pushes
# unchecked until it merges origin/main — which brings the guards along with the base. The CI job
# covers pull requests and main; a pushed branch without a pull request is covered by neither.
cd "$(git rev-parse --show-toplevel)" || exit 2
zero='0000000000000000000000000000000000000000'
pairs=()
if [ ! -t 0 ]; then
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "$local_sha" = "$zero" ] && continue
    pairs+=("$local_sha ${remote_sha:-$zero}")
  done
fi
[ "${#pairs[@]}" -gt 0 ] || pairs=("HEAD $zero")
for pair in "${pairs[@]}"; do
  tip="${pair%% *}"
  remote="${pair##* }"
  if [ "$remote" != "$zero" ] && git cat-file -e "${remote}^{commit}" 2>/dev/null; then
    base="$remote"
  elif ! git rev-parse -q --verify refs/remotes/origin/main >/dev/null; then
    echo "public-repo-guard-commits: there is no origin/main here to measure a new branch against." >&2
    echo "  Fetch it, then push again:  git fetch origin main:refs/remotes/origin/main" >&2
    exit 2
  elif ! base="$(git merge-base origin/main "$tip" 2>/dev/null)"; then
    echo "public-repo-guard-commits: ${tip:0:9} shares no history with origin/main, so the commits it" >&2
    echo "  adds cannot be told apart. Branch it from main." >&2
    exit 2
  fi
  bash scripts/public-repo-guard.sh check-commits "$base" "$tip" --allow-empty || exit $?
done
exit 0
