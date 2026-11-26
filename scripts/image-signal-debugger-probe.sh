#!/usr/bin/env bash
# image-signal-debugger-probe.sh — check a running container of the production image: a signal
# from a process of the engine's own user does not open a debugger on the engine (every node in
# the image starts with --disable-sigusr1, see entrypoint-webui.sh and the Dockerfile).
#
#   scripts/image-signal-debugger-probe.sh <container>
#
# Exit 0 = every check held, 1 = a check failed, 2 = usage or the probe itself could not run.
# Run by scripts/smoke-local.sh against the smoke stack.
#
# It reads only whether a port is in LISTEN in /proc/net/tcp{,6}. It never connects to a
# debugger, evaluates nothing and reads no environment.
#
# The positive control signals a node of the same user that the probe starts itself, without the
# flag: its debugger port must open. Without it, a probe whose signal or port reading does nothing
# would pass every check.
set -euo pipefail

CONTAINER="${1:-}"
[[ -n "$CONTAINER" ]] || { echo "usage: $0 <container>" >&2; exit 2; }

fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }

# Count of sockets in LISTEN (state 0A) on a local port, given in hex.
listening() {
  docker exec "$CONTAINER" sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print \$2, \$4}' | grep -ciE ':$1 0A\$' || true"
}

# The engine is pid 1 and runs as the image's user; the signal comes from that user.
rt=$(docker exec "$CONTAINER" id -u)
[[ "$rt" != "0" ]] || { echo "probe error: the image runs as root" >&2; exit 2; }
pid1_uid=$(docker exec "$CONTAINER" awk '/^Uid:/{print $2}' /proc/1/status)
[[ "$pid1_uid" == "$rt" ]] || { echo "probe error: pid 1 runs as uid $pid1_uid, the image's user is $rt" >&2; exit 2; }

# 9229 = 0x240D, node's default debugger port.
[[ "$(listening 240D)" == "0" ]] || { echo "probe error: port 9229 listens before any signal" >&2; exit 2; }
docker exec "$CONTAINER" kill -USR1 1 || bad "could not signal pid 1 as uid $rt"
sleep 3
[[ "$(listening 240D)" == "0" ]] || bad "the engine opened its debugger on a signal from uid $rt"
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" == "true" ]] || bad "the engine stopped after the signal"

# Positive control: a node of the same user, started without the flag (NODE_OPTIONS cleared), on
# port 9230 (0x240E) so it cannot be mistaken for the engine.
ctl=$(docker exec "$CONTAINER" sh -c 'env -u NODE_OPTIONS node --inspect-port=9230 -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!')
[[ "$ctl" =~ ^[0-9]+$ ]] || { echo "probe error: the control process did not start" >&2; exit 2; }
sleep 1
docker exec "$CONTAINER" kill -USR1 "$ctl" || { echo "probe error: could not signal the control process" >&2; exit 2; }
sleep 3
ctl_listen=$(listening 240E)
docker exec "$CONTAINER" kill -KILL "$ctl" >/dev/null 2>&1 || true
[[ "$ctl_listen" != "0" ]] || { echo "probe error: the control opened no debugger, so the probe cannot see one" >&2; exit 2; }

if [[ "$fail" == "0" ]]; then echo "signal debugger: closed for pid 1 (uid $rt); control opened one"; fi
exit "$fail"
