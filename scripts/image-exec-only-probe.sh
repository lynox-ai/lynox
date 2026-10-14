#!/usr/bin/env bash
# image-exec-only-probe.sh — check a running container of the production image:
# no process in it is dumpable, because every program is execute-only for the
# runtime user (see the Dockerfile step before `USER lynox`).
#
#   scripts/image-exec-only-probe.sh <container>
#
# Exit 0 = every check held, 1 = a check failed, 2 = usage or the probe itself
# could not run. Run by scripts/smoke-local.sh against the smoke stack.
#
# It decides what a program is on its own, from the files in the container, and
# does not reuse the Dockerfile's command: a mistake in one place would
# otherwise hide in both. And it checks the property itself, not only the mode:
# a process with a marker in its environment, started from a program, and a
# second process of the same user that tries to read it.
#
# The positive control runs the same reader where the program IS readable to
# the process: root owns the binaries, so a process root starts from one is
# dumpable, and a reader of the same uid must find the marker. Without it, a
# reader that can read nothing would pass every check.
set -euo pipefail

CONTAINER="${1:-}"
[[ -n "$CONTAINER" ]] || { echo "usage: $0 <container>" >&2; exit 2; }

MARKER=EXEC_ONLY_PROBE_MARKER
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

# As root, reading the script from stdin. The checks themselves run as the
# image's USER, the runtime user.
as_root() { docker exec -i --user 0 "$CONTAINER" sh -s; }

[[ "$(docker exec "$CONTAINER" id -u)" != "0" ]] || { echo "probe error: the image runs as root" >&2; exit 2; }

# 1. Every program cannot be read by the runtime user. A program is an
#    executable regular file that starts with the ELF magic and has no library
#    name (.so, .so.N…, .node); a library must stay readable, the loader maps it.
#    Listed as root, so a directory the runtime user cannot list hides nothing.
programs=$(as_root <<'EOF'
find / -xdev -type f -perm /111 2>/dev/null | while IFS= read -r f; do
  case "$f" in *.so|*.so.*|*.node) continue ;; esac
  [ "$(head -c4 "$f" 2>/dev/null | od -An -c | tr -d ' \n')" = "177ELF" ] && echo "$f"
done
true
EOF
)
count=$(printf '%s\n' "$programs" | grep -c . || true)
(( count > 50 )) || { echo "probe error: found only $count programs; the listing does not work" >&2; exit 2; }
readable=$(printf '%s\n' "$programs" | docker exec -i "$CONTAINER" sh -c 'while IFS= read -r f; do head -c1 "$f" >/dev/null 2>&1 && echo "$f"; done; true')
if [[ -n "$readable" ]]; then
  bad "the runtime user can read $(printf '%s\n' "$readable" | grep -c .) of $count programs, e.g. $(printf '%s\n' "$readable" | head -3 | tr '\n' ' ')"
else
  echo "ok: none of $count programs can be read by the runtime user"
fi

# 2. Counter-witness: a library stays readable. An image where nothing can be
#    read would pass check 1, and nothing in it would start.
libc=$(as_root <<'EOF'
for f in /lib/*/libc.so.6 /usr/lib/*/libc.so.6; do [ -f "$f" ] && { echo "$f"; break; }; done
true
EOF
)
[[ -n "$libc" ]] || { echo "probe error: no libc.so.6 found" >&2; exit 2; }
if docker exec "$CONTAINER" head -c1 "$libc" >/dev/null 2>&1; then
  echo "ok: the library $libc stays readable"
else
  bad "the library $libc cannot be read; the loader maps it"
fi

# 3. The property itself. Each case starts a process with the marker in its
#    environment, then a second `docker exec` (a different process of the same
#    user, as a shell child of the engine would be) reads its environment.
#    READABLE means the marker was found, DENIED that the read failed.
read_env() { # <user> <pid>
  docker exec --user "$1" "$CONTAINER" sh -c "if { tr '\\0' '\\n' < /proc/$2/environ; } 2>/dev/null | grep -q '^$MARKER='; then echo READABLE; elif { cat /proc/$2/environ; } >/dev/null 2>&1; then echo NO-MARKER; else echo DENIED; fi"
}
start_and_read() { # <want> <label> <user> <command…>
  local want=$1 label=$2 user=$3; shift 3
  local pid
  pid=$(docker exec --user "$user" -e "$MARKER=1" "$CONTAINER" sh -c "$* >/dev/null 2>&1 & echo \$!")
  sleep 1
  local got; got=$(read_env "$user" "$pid")
  docker exec --user 0 "$CONTAINER" kill "$pid" >/dev/null 2>&1 || true
  if [[ "$got" == "$want" ]]; then echo "ok: $label → $got"; else bad "$label → $got, want $want"; fi
}
# `exec` so the pid is the program itself, not the shell that started it.
start_and_read DENIED "node" 1001 "exec node -e 'setTimeout(()=>{},30000)'"
start_and_read DENIED "sh" 1001 "exec sh -c 'sleep 30'"
start_and_read DENIED "wget" 1001 "exec wget -q -O /dev/null --tries=1 --timeout=30 http://10.255.255.1/"
start_and_read DENIED "ffmpeg" 1001 "exec ffmpeg -nostdin -re -f lavfi -i anullsrc -t 30 -f null -"
# The engine itself, which carries the instance's environment.
got=$(docker exec "$CONTAINER" sh -c 'cat /proc/1/environ >/dev/null 2>&1 && echo READABLE || echo DENIED')
if [[ "$got" == "DENIED" ]]; then echo "ok: the engine (pid 1) → DENIED"; else bad "the engine (pid 1) → $got, want DENIED"; fi

# 4. Positive control: the same start and the same reader, as root, the owner
#    of the binaries. root may read /bin/sleep, so the process is dumpable and
#    the reader (also root) must find the marker.
start_and_read READABLE "sleep started and read by its owner, root (control)" 0 "exec sleep 30"

exit "$fail"
