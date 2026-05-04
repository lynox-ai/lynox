#!/usr/bin/env bash
# pre-release-smoke.sh — full auth'd-path smoke test against the staging
# engine before tagging a release.
#
# What it does:
#   1. SSHes to the staging control plane (default: control-staging.lynox.cloud).
#   2. Reads the target instance's live LYNOX_HTTP_SECRET from its tenant
#      container via the existing CP SSH chain (postgres → tenant SSH key →
#      tenant host → /opt/lynox/tenants/<id>/.env).
#   3. Mints a session cookie locally on the CP using the same HMAC chain
#      as packages/web-ui/src/lib/server/auth.ts: the cookie is
#      `<nonce>.<ts>.<HMAC-SHA256(HMAC-SHA256('lynox-session', SECRET), payload)>`.
#      The shared secret never leaves the staging boundary.
#   4. Hits the four critical paths the original v1.3.8 incident slipped past:
#         a) GET  /api/health                 → expect 200, captures version
#         b) GET  /api/threads with cookie    → expect 200 (auth wired up)
#         c) POST /api/sessions               → expect 201, captures sessionId
#         d) POST /api/sessions/<id>/run      → expect SSE stream with events
#
# Why:
#   The 2026-05-01 v1.3.8 incident slipped through staging because staging
#   only ran an unauthenticated GET /healthz check — never exercised the
#   cookie-signing path that broke. This script closes that gap. Run it
#   before every tag (or wire into CI).
#
# Usage:
#   ./scripts/pre-release-smoke.sh                              # defaults
#   ./scripts/pre-release-smoke.sh --instance engine2           # different subdomain
#   ./scripts/pre-release-smoke.sh --cp root@control-staging.lynox.cloud
#   ./scripts/pre-release-smoke.sh --expect-version 1.3.9       # version gate
#   ./scripts/pre-release-smoke.sh --verbose                    # echo response bodies on failure
#
# Exits non-zero on any failed step. By default only HTTP status codes are
# printed — response bodies (thread titles, LLM replies) stay on the staging
# boundary. Use --verbose / LYNOX_SMOKE_VERBOSE=1 if you need to debug a
# failure with the actual response payloads.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Defaults + args
# ─────────────────────────────────────────────────────────────────────

CP_TARGET="${LYNOX_STAGING_CP:-root@control-staging.lynox.cloud}"
INSTANCE_SUBDOMAIN="${LYNOX_STAGING_INSTANCE:-engine}"
EXPECT_VERSION=""
# Default off — failure messages print only sentinel codes (HTTP status,
# session id presence). Response bodies stay on the staging boundary unless
# the operator explicitly opts in. Avoids leaking thread titles / LLM
# replies into a developer's terminal scrollback or a CI log.
VERBOSE_BODIES="${LYNOX_SMOKE_VERBOSE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cp)              CP_TARGET="$2"; shift 2 ;;
    --instance)        INSTANCE_SUBDOMAIN="$2"; shift 2 ;;
    --expect-version)  EXPECT_VERSION="$2"; shift 2 ;;
    --verbose)         VERBOSE_BODIES=1; shift ;;
    -h|--help)
      sed -n '2,33p' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Validate INSTANCE_SUBDOMAIN before it crosses the SSH boundary into a
# psql `WHERE subdomain='...'` clause on the staging CP. Restricting to the
# DNS-label charset closes the SQL-injection vector and matches what
# Hetzner/Cloudflare would allow as a real subdomain anyway.
if ! [[ "$INSTANCE_SUBDOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "error: --instance must be a DNS label (a-z, 0-9, '-'), got: $INSTANCE_SUBDOMAIN" >&2
  exit 2
fi

ENGINE_HOST="${INSTANCE_SUBDOMAIN}.lynox.cloud"
BASE_URL="https://${ENGINE_HOST}"

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

c_blue()   { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

step() { printf '\n'; c_blue "=== $* ==="; }
die()  { c_red "FAIL: $*"; exit 1; }
ok()   { c_green "OK: $*"; }

step "pre-release smoke against ${BASE_URL}  (CP: ${CP_TARGET})"

# Verify SSH first — fail fast if we can't reach CP.
ssh -o ConnectTimeout=8 -o BatchMode=yes "$CP_TARGET" 'echo cp-reachable' >/dev/null 2>&1 \
  || die "cannot SSH to $CP_TARGET (set LYNOX_STAGING_CP or pass --cp)"

# ─────────────────────────────────────────────────────────────────────
# Step 1 — /api/health (no auth)
# ─────────────────────────────────────────────────────────────────────

step "1/4  GET /api/health"
HEALTH_JSON=$(curl -fsS --max-time 10 "${BASE_URL}/api/health") \
  || die "/api/health did not return 200"

VERSION=$(printf '%s' "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','?'))")
UPTIME=$(printf '%s' "$HEALTH_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uptime_s','?'))")
ok "version=${VERSION}  uptime_s=${UPTIME}"

if [[ -n "$EXPECT_VERSION" && "$VERSION" != "$EXPECT_VERSION" ]]; then
  die "version mismatch — got ${VERSION}, expected ${EXPECT_VERSION}"
fi

# ─────────────────────────────────────────────────────────────────────
# Step 2 — Mint a session cookie + hit /api/threads
# ─────────────────────────────────────────────────────────────────────

step "2/4  forge cookie + GET /api/threads"

# The whole mint+curl chain runs on CP so LYNOX_HTTP_SECRET never leaves
# the staging boundary. The CP has the postgres + SSH plumbing already.
# shellcheck disable=SC2029  # local expansion of INSTANCE_SUBDOMAIN/BASE_URL/VERBOSE is intentional — we want them set on the remote shell.
COOKIE_TEST_OUTPUT=$(ssh "$CP_TARGET" "INSTANCE_SUBDOMAIN='${INSTANCE_SUBDOMAIN}' BASE_URL='${BASE_URL}' VERBOSE='${VERBOSE_BODIES}' bash -se" <<'REMOTE'
# pipefail catches `docker compose exec ... | cut` masking psql errors as
# "instance not found"; INT/TERM/HUP coverage stops a Ctrl-C from leaving
# the tenant SSH key on /tmp.
set -euo pipefail

# Find docker-compose file (prod CP uses docker-compose.yml, staging uses staging.yml)
COMPOSE=""
for f in /opt/lynox-managed/docker-compose.staging.yml /opt/lynox-managed/docker-compose.yml; do
  [[ -f "$f" ]] && { COMPOSE="$f"; break; }
done
[[ -n "$COMPOSE" ]] || { echo "ERR no compose file under /opt/lynox-managed/" >&2; exit 1; }

# Look up instance ID + tenant host from CP postgres
DBROW=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -F'|' -c \
  "SELECT id, tenant_host_id, hosting_mode FROM managed_instances WHERE subdomain='$INSTANCE_SUBDOMAIN' LIMIT 1;")
INSTANCE_ID=$(echo "$DBROW" | cut -d'|' -f1)
TENANT_HOST_ID=$(echo "$DBROW" | cut -d'|' -f2)
HOSTING_MODE=$(echo "$DBROW" | cut -d'|' -f3)
[[ -n "$INSTANCE_ID" ]] || { echo "ERR instance '$INSTANCE_SUBDOMAIN' not found" >&2; exit 1; }

# Resolve engine .env path + SSH key based on hosting mode. Use mktemp for
# every file so a concurrent smoke run + a hostile shell user on the CP
# can't squat on a predictable name and read the auth'd response bodies.
TMPKEY=$(mktemp /tmp/_smoke_key.XXXXXX); chmod 600 "$TMPKEY"
KH=$(mktemp /tmp/_smoke_kh.XXXXXX)
THREADS_RESP=$(mktemp /tmp/_smoke_threads.XXXXXX)
SESS_RESP=$(mktemp /tmp/_smoke_sess.XXXXXX)
trap '
  shred -u "$TMPKEY" 2>/dev/null || rm -f "$TMPKEY"
  rm -f "$KH" "$THREADS_RESP" "$SESS_RESP"
' EXIT INT TERM HUP

if [[ "$HOSTING_MODE" == "tenant_host" ]]; then
  # Two queries instead of one — `psql -t -A -F'|'` collapses multi-line
  # values (ssh_private_key has embedded newlines) into a shape `cut -d'|'`
  # cannot disambiguate. The ~500ms second-call cost is acceptable here.
  docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT ssh_private_key FROM managed_tenant_hosts WHERE id='$TENANT_HOST_ID';" > "$TMPKEY"
  HOST_IP=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT hetzner_server_ip FROM managed_tenant_hosts WHERE id='$TENANT_HOST_ID';")
  ENV_PATH="/opt/lynox/tenants/$INSTANCE_ID/.env"
  SSH_USER=lynox
else
  cp /var/lib/docker/volumes/lynox-managed_ssh-keys/_data/id_ed25519 "$TMPKEY"
  HOST_IP=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT hetzner_server_ip FROM managed_instances WHERE id='$INSTANCE_ID';")
  ENV_PATH="/opt/lynox/.env"
  SSH_USER=lynox
fi

OPTS="-i $TMPKEY -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o BatchMode=yes"
# `< /dev/null` so the inner ssh doesn't slurp the rest of this heredoc as
# its own stdin (same hazard as `docker compose exec -T` above).
SECRET=$(ssh $OPTS "${SSH_USER}@${HOST_IP}" "grep -E '^LYNOX_HTTP_SECRET=' '$ENV_PATH' | cut -d= -f2-" < /dev/null)
[[ -n "$SECRET" ]] || { echo "ERR LYNOX_HTTP_SECRET not found in $ENV_PATH" >&2; exit 1; }

# Mint cookie via documented chain
TOKEN=$(SECRET="$SECRET" python3 -c "
import os, hmac, hashlib, secrets, time
s = os.environ['SECRET'].encode()
key = hmac.new(b'lynox-session', s, hashlib.sha256).digest()
nonce = secrets.token_hex(8)
ts = str(int(time.time()))
payload = f'{nonce}.{ts}'
sig = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
print(f'{payload}.{sig}')
")

# /api/threads — emit only the status sentinel; bodies stay on the
# staging boundary unless VERBOSE=1 (set by --verbose / LYNOX_SMOKE_VERBOSE).
THREADS_HTTP=$(curl -s -o "$THREADS_RESP" -w '%{http_code}' --max-time 10 \
  -H "Cookie: lynox_session=$TOKEN" "${BASE_URL}/api/threads?limit=5")
echo "THREADS_HTTP=$THREADS_HTTP"
[[ "$VERBOSE" == "1" ]] && echo "THREADS_BODY_HEAD=$(head -c 200 "$THREADS_RESP")"

# /api/sessions (POST creates new session)
SESS_HTTP=$(curl -s -o "$SESS_RESP" -w '%{http_code}' --max-time 10 \
  -X POST -H "Cookie: lynox_session=$TOKEN" -H "Content-Type: application/json" \
  -d '{}' "${BASE_URL}/api/sessions")
echo "SESS_HTTP=$SESS_HTTP"
SESSION_ID=$(SESS_RESP="$SESS_RESP" python3 -c "
import json, os
try:
    print(json.load(open(os.environ['SESS_RESP'])).get('sessionId',''))
except Exception:
    print('')
")
echo "SESSION_ID=$SESSION_ID"

# /api/sessions/<id>/run — bounded SSE. We don't echo the SSE body even on
# success — the LLM reply could contain anything depending on what the
# staging engine dragged from history. The success sentinel is a positive
# event type (text/tool/done); `event: error` or `event: aborted` would
# otherwise let a server-side failure pass Step 4 silently.
if [[ -n "$SESSION_ID" ]]; then
  RUN_OUT=$(curl -s --max-time 30 \
    -X POST -H "Cookie: lynox_session=$TOKEN" -H "Content-Type: application/json" \
    -d '{"task":"reply with the single word: pong"}' \
    "${BASE_URL}/api/sessions/${SESSION_ID}/run" \
    | head -c 4096 || true)
  if echo "$RUN_OUT" | grep -qE '^event: (text|tool_call|tool_result|done|turn_end)'; then
    echo "RUN_SSE=ok"
  else
    echo "RUN_SSE=fail"
    [[ "$VERBOSE" == "1" ]] && echo "RUN_OUT_HEAD=$(echo "$RUN_OUT" | head -c 300)"
  fi
fi
REMOTE
)

echo "$COOKIE_TEST_OUTPUT" | grep -q '^THREADS_HTTP=200$' \
  || die "/api/threads failed:\n$COOKIE_TEST_OUTPUT"
ok "/api/threads returned 200 with cookie"

# ─────────────────────────────────────────────────────────────────────
# Step 3 — POST /api/sessions
# ─────────────────────────────────────────────────────────────────────

step "3/4  POST /api/sessions"
echo "$COOKIE_TEST_OUTPUT" | grep -q '^SESS_HTTP=201$' \
  || die "POST /api/sessions did not return 201:\n$(echo "$COOKIE_TEST_OUTPUT" | grep -E '^SESS_')"

SESSION_ID=$(echo "$COOKIE_TEST_OUTPUT" | grep '^SESSION_ID=' | head -1 | cut -d= -f2-)
[[ -n "$SESSION_ID" ]] || die "no sessionId in response body"
ok "session created: $SESSION_ID"

# ─────────────────────────────────────────────────────────────────────
# Step 4 — POST /api/sessions/<id>/run + SSE
# ─────────────────────────────────────────────────────────────────────

step "4/4  POST /api/sessions/$SESSION_ID/run (SSE)"
echo "$COOKIE_TEST_OUTPUT" | grep -q '^RUN_SSE=ok$' \
  || die "SSE run did not produce events:\n$(echo "$COOKIE_TEST_OUTPUT" | grep -E '^RUN_')"
ok "SSE stream produced events"

# ─────────────────────────────────────────────────────────────────────

step "ALL CHECKS PASSED"
c_green "✓ engine ${BASE_URL} is on v${VERSION} and the auth'd path works end-to-end"
