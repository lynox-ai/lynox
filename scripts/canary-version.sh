#!/usr/bin/env bash
# The semver a canary image is named and stamped with (canary-build.yml):
#   <highest published release reachable from HEAD, patch + 1>-canary.<first 8 of the sha>
#
# The control plane lets an image run under a held connection only at or past a floor
# release, and it orders tags by semver. A branch's package.json version says nothing
# about what the branch contains: any branch can set it. The version comes from the release
# tags reachable from HEAD instead. A branch cut before the floor release does not reach its
# tag and gets a version below the floor, whatever its package.json says. Reaching a release
# is history, not content: a branch that merges a release and then reverts part of it still
# reaches it.
#
# What this does not hold against: whoever can push a branch can change this script or the
# workflow that runs it, and whoever can publish a release or move a tag decides what counts
# as a release. That is the release path's own trust, the same the floors place in a release
# tag. Which instances accept a `-canary.` tag at all is the control plane's decision, not
# this script's.
#
# A tag only counts if it is a published release (not a draft, not a prerelease), read
# from the file given as $1, one tag per line. A bare `v*` tag pushed by hand is not the
# release path. Nothing qualifying: prints nothing and exits 0, so the build carries no
# semver tag and keeps its branch and sha tags.
set -euo pipefail

released="${1:-}"
if [ -z "$released" ] || [ ! -r "$released" ]; then
  echo "canary-version: no readable list of published releases" >&2
  exit 2
fi

# Plain releases only, each part without a leading zero and at most six digits, so the
# arithmetic below cannot overflow.
RELEASE_TAG='^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'

best=""
while IFS= read -r tag; do
  [[ "$tag" =~ $RELEASE_TAG ]] || continue
  grep -qxF -- "$tag" "$released" || continue
  best="$tag"
  break
done < <(git tag --merged HEAD --list 'v*' --sort=-v:refname)

[ -n "$best" ] || exit 0

[[ "$best" =~ $RELEASE_TAG ]]
major=${BASH_REMATCH[1]}
minor=${BASH_REMATCH[2]}
patch=$((BASH_REMATCH[3] + 1))
sha=$(git rev-parse HEAD)
printf '%s.%s.%s-canary.%s\n' "$major" "$minor" "$patch" "${sha:0:8}"
