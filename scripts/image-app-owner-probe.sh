#!/usr/bin/env bash
# image-app-owner-probe.sh — check a running container of the production image:
# the runtime user cannot change the code it runs. Nothing under /app, not the
# entrypoint and not their parent directory belongs to that user or is writable
# for it by mode.
#
#   scripts/image-app-owner-probe.sh <container>
#
# Exit 0 = the check held, 1 = it failed, 2 = usage or the probe itself could not
# run. Run by scripts/smoke-local.sh against the smoke stack.
#
# It reads ownership and mode, not a write attempt: the smoke stack runs with a
# read-only root filesystem, where every write fails whoever owns the file, so a
# write probe there would pass for an image that hands the code to the runtime
# user. The image has to hold without that mount too (`docker run`, an own
# compose file).
#
# The control runs the same predicate over the runtime user's own data directory,
# which it does own: a predicate that finds nothing would pass every image.
set -euo pipefail

CONTAINER="${1:-}"
[[ -n "$CONTAINER" ]] || { echo "usage: $0 <container>" >&2; exit 2; }

# The runtime user and its groups, read from the container, never assumed.
rt=$(docker exec "$CONTAINER" id -u)
[[ "$rt" != "0" ]] || { echo "probe error: the image runs as root" >&2; exit 2; }
groups=$(docker exec "$CONTAINER" id -G)

# writable_by_rt <path…>: as root, every file or directory under the paths that
# the runtime user owns, or may write through its group or as anyone. Symlinks
# are left out: their mode is always 777 and says nothing about the target.
writable_by_rt() {
  local gexpr="" g
  for g in $groups; do gexpr="$gexpr -o \\( -group $g -perm -g+w \\)"; done
  docker exec --user 0 "$CONTAINER" sh -c "find $* -xdev ! -type l \( -user $rt -o -perm -o+w $gexpr \) -print 2>/dev/null; true"
}

# The code paths themselves must exist: find's error is discarded above, so a
# missing path would otherwise list nothing and pass.
for p in /app /entrypoint-webui.sh; do
  docker exec "$CONTAINER" test -e "$p" || { echo "probe error: $p does not exist in the container" >&2; exit 2; }
done

# Control: the runtime user's data directory belongs to it, so the predicate must
# list it.
home=$(docker exec "$CONTAINER" sh -c 'echo "$HOME"')
ctl=$(writable_by_rt "$home/.lynox")
printf '%s\n' "$ctl" | grep -qx "$home/.lynox" || { echo "probe error: the predicate does not list $home/.lynox, which the runtime user owns; it does not work" >&2; exit 2; }

# The listing must see the code at all.
count=$(docker exec --user 0 "$CONTAINER" sh -c 'find /app -xdev ! -type l | wc -l')
(( count > 1000 )) || { echo "probe error: found only $count entries under /app; the listing does not work" >&2; exit 2; }

# A writable parent directory would let the runtime user rename a code path
# away and put its own in its place, so the parents count too (not their other
# entries: `-maxdepth 0`).
found=$(writable_by_rt /app /entrypoint-webui.sh; writable_by_rt / -maxdepth 0)
if [[ -n "$found" ]]; then
  echo "FAIL: the runtime user (uid $rt) can change $(printf '%s\n' "$found" | grep -c .) of the image's code paths, e.g. $(printf '%s\n' "$found" | head -3 | tr '\n' ' ')" >&2
  exit 1
fi
echo "ok: none of $count entries under /app, nor the entrypoint or /, belongs to or is writable for uid $rt (control: $home/.lynox is)"
