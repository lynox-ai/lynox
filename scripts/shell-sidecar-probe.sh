#!/usr/bin/env bash
# shell-sidecar-probe.sh — run the exec daemon from a built image with the sidecar's
# container options (PRD 152 v2 §4.1; template by sec-infra) and check what the unit
# tests cannot: the kernel's answers.
#
#   scripts/shell-sidecar-probe.sh <image>
#
# Exit 0 = every check held, 1 = a check failed, 2 = the probe itself could not run.
#
# Each refusal is paired with a control that shows the same reader CAN see the thing
# when it is there; a probe that sees nothing would otherwise pass every check.
set -euo pipefail

IMAGE="${1:-}"
[[ -n "$IMAGE" ]] || { echo "usage: $0 <image>" >&2; exit 2; }
command -v python3 >/dev/null || { echo "probe error: needs python3 on the host" >&2; exit 2; }

ID="sidecar-probe-$$"
C="$ID"
SOCK=/run/lynox-exec/s/exec.sock
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ok() { echo "ok:   $*"; }

cleanup() {
  # PROBE_KEEP=1 leaves the container for inspection (remove it by hand afterwards).
  if [[ "${PROBE_KEEP:-}" == 1 ]]; then echo "kept: container $C, volumes $ID-ws $ID-sock" >&2; return; fi
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker volume rm "$ID-ws" "$ID-sock" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$ID-ws" >/dev/null
docker volume create "$ID-sock" >/dev/null
# The workspace volume belongs to the engine user and the shared group; that is the
# engine's side of the template (P18), set here so calls can write it.
docker run --rm --user 0 -v "$ID-ws:/workspace" --entrypoint /bin/sh "$IMAGE" \
  -c 'chown 1001:1002 /workspace && chmod 2775 /workspace' >/dev/null

docker run -d --name "$C" \
  --user 0 --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges --read-only --network none --ipc none \
  --tmpfs /tmp:size=256m,mode=1755,nosuid,nodev --pids-limit 512 \
  -v "$ID-ws:/workspace" -v "$ID-sock:/run/lynox-exec" \
  -e LYNOX_EXEC_POOL_GID=1002 -e LYNOX_EXEC_POOL_SIZE=4 \
  --entrypoint /usr/bin/tini "$IMAGE" -- node /app/dist/shell-sidecar/exec-daemon.js >/dev/null

for _ in $(seq 1 50); do
  docker exec "$C" test -S "$SOCK" 2>/dev/null && break
  sleep 0.2
done
docker exec "$C" test -S "$SOCK" || { docker logs "$C" >&2; echo "probe error: no socket" >&2; exit 2; }

# One call through the real client, as the engine user. Prints the result as JSON.
call() {
  docker exec --user 1001 "$C" node --input-type=module -e "
    const { execViaSidecar } = await import('/app/dist/shell-sidecar/client.js');
    const [cmd, t] = process.argv.slice(1);
    try {
      const r = await execViaSidecar('$SOCK', { cmd, timeoutMs: t ? Number(t) : undefined, env: { LANG: 'C', LYNOX_WORKSPACE: '/engine/path' } }, 1 << 20);
      console.log(JSON.stringify(r));
    } catch (e) { console.log(JSON.stringify({ clientError: String(e.message) })); }
  " "$1" "${2:-}"
}
field() { python3 -c 'import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"; }

# Root's view: processes, SysV objects and /tmp/calls entries of a uid.
procs_of() { docker exec --user 0 "$C" sh -c "grep -l '^Uid:[[:space:]]*$1[[:space:]]' /proc/[0-9]*/status 2>/dev/null | wc -l"; }
# The uid column is found by its header name in each table, not by position.
ipc_of() { docker exec --user 0 "$C" awk -v u="$1" 'FNR==1 {c=0; for (i=1;i<=NF;i++) if ($i=="uid") c=i; next} c && $c==u {n++} END {print n+0}' /proc/sysvipc/shm /proc/sysvipc/msg /proc/sysvipc/sem; }
calls_entries() { docker exec --user 0 "$C" sh -c 'ls -A /tmp/calls | wc -l'; }
zombies() { docker exec --user 0 "$C" sh -c "grep -l '^State:[[:space:]]*Z' /proc/[0-9]*/status 2>/dev/null | wc -l"; }

wait_free() { # the daemon releases after the exit frame; give it a moment
  for _ in $(seq 1 50); do [[ "$(procs_of "$1")" == 0 && "$(calls_entries)" == 0 ]] && return 0; sleep 0.1; done
  return 1
}

# --- who a call is -------------------------------------------------------------
r=$(call 'id -u; id -G; echo "$HOME|$TMPDIR|$PWD|${LYNOX_WORKSPACE-unset}"')
out=$(field "$r" stdout)
uid=$(sed -n 1p <<<"$out")
[[ "$uid" -ge 20000 && "$uid" -le 20003 ]] && ok "call runs as pool uid $uid" || bad "call uid: $out $r"
[[ "$(sed -n 2p <<<"$out")" == "1002" ]] && ok "call's only group is lynox-ws" || bad "call groups: $(sed -n 2p <<<"$out")"
[[ "$(sed -n 3p <<<"$out")" =~ ^/tmp/calls/[0-9a-f]+\|/tmp/calls/[0-9a-f]+\|/workspace\|unset$ ]] \
  && ok "HOME/TMPDIR per call, starts in /workspace, engine path dropped" || bad "call env: $(sed -n 3p <<<"$out")"
wait_free "$uid" && ok "uid $uid released, /tmp/calls empty" || bad "uid $uid not released"

# --- the socket: engine yes (above), pool uid no, with the call's real groups ----
r=$(call "node -e \"require('net').connect('$SOCK').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(0)})\"")
[[ "$(field "$r" stdout)" == "EACCES"* ]] && ok "pool uid cannot open the socket (EACCES)" || bad "pool uid socket: $r"

# --- case 17: nothing of the call survives it ------------------------------------
r=$(call 'setsid sh -c "sleep 300" >/dev/null 2>&1 & (while :; do sleep 0.01 & done) >/dev/null 2>&1 & sleep 0.3; echo started')
[[ "$(field "$r" stdout)" == "started"* ]] || bad "case 17 call: $r"
sleep 1
left=0; for u in 20000 20001 20002 20003; do left=$((left + $(procs_of $u))); done
[[ "$left" == 0 ]] && ok "case 17: no pool process left after a detached sleeper and a fork loop" || bad "case 17: $left pool processes left"
[[ "$(zombies)" == 0 ]] && ok "no zombies (tini reaps)" || bad "zombies: $(zombies)"

# control: while a call runs, root DOES see its processes
docker exec --user 1001 "$C" node --input-type=module -e "
  const { execViaSidecar } = await import('/app/dist/shell-sidecar/client.js');
  await execViaSidecar('$SOCK', { cmd: 'sleep 3', timeoutMs: undefined, env: {} }, 1024);
" >/dev/null 2>&1 &
sleep 1
seen=0; for u in 20000 20001 20002 20003; do seen=$((seen + $(procs_of $u))); done
[[ "$seen" -gt 0 ]] && ok "control: a running call's processes are visible to the scan ($seen)" || bad "control: scan sees no running call"
wait

# --- case 18: /tmp closed, $HOME gone ---------------------------------------------
r=$(call 'echo x > /tmp/x 2>/dev/null && echo TMP_WRITABLE; echo p > "$HOME/.profile" && echo HOME_OK; echo "$HOME"')
o=$(field "$r" stdout)
grep -q TMP_WRITABLE <<<"$o" && bad "case 18: /tmp writable for a pool uid" || ok "case 18: /tmp not writable for a pool uid"
grep -q HOME_OK <<<"$o" && ok "control: \$HOME writable during the call" || bad "control: \$HOME not writable: $o"
h18=$(tail -1 <<<"$o")
sleep 0.5
r=$(call "test -e '$h18/.profile' && echo SEEN; test -e /tmp/x && echo SEEN_TMP; ls /tmp/calls 2>&1 | head -1")
o=$(field "$r" stdout)
grep -q SEEN <<<"$o" && bad "case 18: next call sees the previous \$HOME" || ok "case 18: next call sees neither"
grep -qi "denied" <<<"$o" && ok "a pool uid cannot list /tmp/calls" || bad "list /tmp/calls: $o"

# --- IPC sweep (v2.1): SysV objects and extra /tmp/calls entries go with the uid ---
r=$(call 'ipcmk -M 4096 >/dev/null && ipcmk -Q >/dev/null && ipcmk -S 1 >/dev/null && mkdir /tmp/calls/extra-$(id -u) && id -u')
ui=$(field "$r" stdout | tr -d '\n')
[[ -n "$ui" ]] || bad "ipc call: $r"
sleep 1
[[ "$(ipc_of "$ui")" == 0 ]] && ok "SysV objects of uid $ui swept" || bad "SysV objects of uid $ui left: $(ipc_of "$ui")"
[[ "$(calls_entries)" == 0 ]] && ok "extra /tmp/calls entry swept" || bad "/tmp/calls entries left: $(calls_entries)"

# --- root cannot remove another uid's IPC (why the sweep runs as the uid) ---------
docker exec --user 20010:1002 "$C" ipcmk -M 4096 >/dev/null
[[ "$(ipc_of 20010)" == 1 ]] && ok "control: a uid's SysV object is visible to the scan" || bad "control: ipc scan blind"
shmid=$(docker exec --user 0 "$C" awk 'FNR==1 {for (i=1;i<=NF;i++) if ($i=="uid") c=i; next} $c==20010 {print $2}' /proc/sysvipc/shm | head -1)
if docker exec --user 0 "$C" ipcrm -m "$shmid" >/dev/null 2>&1; then bad "root removed a pool uid's shm (sweep as root would do)"; else ok "root cannot ipcrm a pool uid's shm"; fi
docker exec --user 20010:1002 "$C" ipcrm -m "$shmid" >/dev/null 2>&1 || true

# --- cgroup: a pool uid cannot write it ------------------------------------------
r=$(call 'for f in /sys/fs/cgroup/cgroup.procs /sys/fs/cgroup/pids.max; do [ -e "$f" ] && { echo 1 > "$f" 2>/dev/null && echo "WROTE $f"; }; done; echo done')
grep -q WROTE <<<"$(field "$r" stdout)" && bad "pool uid wrote cgroup: $r" || ok "pool uid cannot write /sys/fs/cgroup"

# --- timeout ----------------------------------------------------------------------
r=$(call 'sleep 30' 1000)
[[ "$(field "$r" timedOut)" == "True" ]] && ok "timeout reported" || bad "timeout: $r"
sleep 1
left=0; for u in 20000 20001 20002 20003; do left=$((left + $(procs_of $u))); done
[[ "$left" == 0 ]] && ok "nothing left after the timeout" || bad "after timeout: $left processes"

# --- the pool never shares --------------------------------------------------------
for i in 1 2 3 4; do (call 'sleep 2; id -u' > "/tmp/$ID-c$i" ) & done
sleep 0.5
r=$(call 'echo fifth')
[[ "$(field "$r" error)" == "no free uid in the pool" ]] && ok "fifth concurrent call refused, not shared" || bad "fifth call: $r"
wait
uids=$(for i in 1 2 3 4; do field "$(cat "/tmp/$ID-c$i")" stdout; rm -f "/tmp/$ID-c$i"; done | grep -E "^[0-9]+$" | sort -u | wc -l)
[[ "$uids" == 4 ]] && ok "four concurrent calls, four uids" || bad "concurrent calls shared uids ($uids distinct)"

[[ "$(docker exec "$C" sh -c 'cat /proc/1/comm')" == "tini" ]] && ok "pid 1 is tini" || bad "pid 1 is not tini"
docker logs "$C" 2>&1 | grep -q QUARANTINE && bad "daemon quarantined a uid: $(docker logs "$C" 2>&1 | grep QUARANTINE | head -3)" || ok "no uid quarantined"

exit "$fail"
