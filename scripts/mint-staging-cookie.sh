#!/usr/bin/env bash
# mint-staging-cookie.sh — print a 30-day staging session cookie to stdout
#
# Uses the same SSH chain as pre-release-smoke.sh:
#   1. SSH to control-staging.lynox.cloud
#   2. Read tenant SSH key + host from CP postgres
#   3. SSH from CP → tenant host, grep LYNOX_HTTP_SECRET from instance .env
#   4. Mint the HMAC-signed cookie on the CP and return it
#
# The secret never leaves the staging boundary; only the derived cookie
# crosses back. Cookie is good for SESSION_MAX_AGE_S (30 days) from now.
#
# Usage:
#   cookie=$(./scripts/mint-staging-cookie.sh)
#   STAGING_COOKIE="$cookie" pnpm exec playwright test …
#   unset cookie  # don't leave it in shell history / env
#
# Never write the cookie to a file unless you also `chmod 600` AND
# `shred -u` it after use — the cookie authenticates as the staging
# user for the full 30-day TTL.
#
# Override the target subdomain (default: engine):
#   LYNOX_STAGING_INSTANCE=engine2 ./scripts/mint-staging-cookie.sh

set -euo pipefail

CP_TARGET="${LYNOX_STAGING_CP:-root@control-staging.lynox.cloud}"
INSTANCE_SUBDOMAIN="${LYNOX_STAGING_INSTANCE:-engine}"

# Pre-flight: refuse to point at the production CP. The user might have
# overridden LYNOX_STAGING_CP for some other reason; we never mint a
# production cookie from this helper.
if [[ "$CP_TARGET" == *"control.lynox.cloud"* ]] && [[ "$CP_TARGET" != *"control-staging"* ]]; then
  echo "REFUSED: this helper is staging-only; got CP_TARGET=$CP_TARGET" >&2
  exit 2
fi

# `INSTANCE_SUBDOMAIN` flows unescaped into a remote `psql … WHERE
# subdomain='$x' …` query. Validate the shape locally so a hostile
# value can never reach postgres. Hetzner subdomains are
# `^[a-z0-9-]{1,32}$` by convention; reject anything else.
if [[ ! "$INSTANCE_SUBDOMAIN" =~ ^[a-z0-9-]{1,32}$ ]]; then
  echo "REFUSED: INSTANCE_SUBDOMAIN must match ^[a-z0-9-]{1,32}\$; got '$INSTANCE_SUBDOMAIN'" >&2
  exit 2
fi

ssh -o ConnectTimeout=8 -o BatchMode=yes "$CP_TARGET" \
  "INSTANCE_SUBDOMAIN='${INSTANCE_SUBDOMAIN}' bash -se" <<'REMOTE'
set -euo pipefail
COMPOSE=""
for f in /opt/lynox-managed/docker-compose.staging.yml /opt/lynox-managed/docker-compose.yml; do
  [[ -f "$f" ]] && { COMPOSE="$f"; break; }
done
[[ -n "$COMPOSE" ]] || { echo "ERR no compose file under /opt/lynox-managed/" >&2; exit 1; }

DBROW=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -F'|' -c \
  "SELECT id, tenant_host_id, hosting_mode FROM managed_instances WHERE subdomain='$INSTANCE_SUBDOMAIN' LIMIT 1;")
INSTANCE_ID=$(echo "$DBROW" | cut -d'|' -f1)
TENANT_HOST_ID=$(echo "$DBROW" | cut -d'|' -f2)
HOSTING_MODE=$(echo "$DBROW" | cut -d'|' -f3)
[[ -n "$INSTANCE_ID" ]] || { echo "ERR instance '$INSTANCE_SUBDOMAIN' not found" >&2; exit 1; }

# Same mktemp+trap shred discipline as pre-release-smoke.sh — concurrent
# runs + hostile shell users on the CP can't squat on a predictable name
# and pull the SSH key.
TMPKEY=$(mktemp /tmp/_mint_key.XXXXXX); chmod 600 "$TMPKEY"
KH=$(mktemp /tmp/_mint_kh.XXXXXX)
trap 'shred -u "$TMPKEY" 2>/dev/null || rm -f "$TMPKEY"; rm -f "$KH"' EXIT INT TERM HUP

if [[ "$HOSTING_MODE" == "tenant_host" ]]; then
  docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT ssh_private_key FROM managed_tenant_hosts WHERE id='$TENANT_HOST_ID';" > "$TMPKEY"
  HOST_IP=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT hetzner_server_ip FROM managed_tenant_hosts WHERE id='$TENANT_HOST_ID';")
  ENV_PATH="/opt/lynox/tenants/$INSTANCE_ID/.env"
else
  cp /var/lib/docker/volumes/lynox-managed_ssh-keys/_data/id_ed25519 "$TMPKEY"
  HOST_IP=$(docker compose -f "$COMPOSE" exec -T postgres psql -U managed -d lynox_managed -t -A < /dev/null -c \
    "SELECT hetzner_server_ip FROM managed_instances WHERE id='$INSTANCE_ID';")
  ENV_PATH="/opt/lynox/.env"
fi

OPTS="-i $TMPKEY -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o BatchMode=yes"
SECRET=$(ssh $OPTS "lynox@${HOST_IP}" "grep -E '^LYNOX_HTTP_SECRET=' '$ENV_PATH' | cut -d= -f2-" < /dev/null)
[[ -n "$SECRET" ]] || { echo "ERR LYNOX_HTTP_SECRET not found in $ENV_PATH" >&2; exit 1; }

# Mirror the HMAC chain in packages/web-ui/src/lib/server/auth.ts —
# nonce + ts + HMAC-SHA256(HMAC-SHA256('lynox-session', SECRET), payload).
SECRET="$SECRET" python3 -c "
import os, hmac, hashlib, secrets, time
s = os.environ['SECRET'].encode()
key = hmac.new(b'lynox-session', s, hashlib.sha256).digest()
nonce = secrets.token_hex(8)
ts = str(int(time.time()))
payload = f'{nonce}.{ts}'
sig = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
print(f'{payload}.{sig}')
"
REMOTE
