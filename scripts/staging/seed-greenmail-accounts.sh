#!/usr/bin/env bash
#
# seed-greenmail-accounts.sh — install the four staging-Greenmail test mail
# accounts in the staging engine via the admin API.
#
# Idempotent: deletes existing accounts with the same id before posting, so
# rerunning is safe.
#
# The engine talks to Greenmail on control-staging.lynox.cloud's PUBLIC IP
# (Hetzner firewall whitelists the staging tenant host's outbound). Plain
# 3025/3143 because the engine API does not expose `insecureTls` and
# Greenmail ships only a self-signed cert.
#
# Prereqs:
#   - Greenmail running on control-staging.lynox.cloud:3025/3143
#   - Hetzner firewall rule `greenmail-staging-allowlist` is active
#   - Staging engine LYNOX_HTTP_SECRET available via the standard SSH chain
#     (same one mint-staging-cookie.sh uses)
#
# Usage:
#   ./scripts/staging/seed-greenmail-accounts.sh

set -euo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.lynox.cloud}"
GREENMAIL_HOST="${GREENMAIL_HOST:-control-staging.lynox.cloud}"

# Pull the engine's LYNOX_HTTP_SECRET via the existing SSH chain. In
# single-token mode this secret has admin scope, which #338's gating on
# POST /api/mail/accounts now requires.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Resolving staging engine HTTP secret via control-staging chain…"
SECRET=$(
  ssh -i ~/.ssh/lynox-staging -o ConnectTimeout=5 root@control-staging.lynox.cloud \
    "docker compose -f /opt/lynox-managed/docker-compose.staging.yml exec -T postgres \
     psql -U managed -d lynox_managed -At -c \
     \"SELECT instance_secret FROM managed_instances WHERE id = '96w887doddigx7qdr3gtl'\"" \
  | tr -d '\r'
)
if [ -z "$SECRET" ]; then
  echo "FAIL: could not resolve LYNOX_HTTP_SECRET from staging CP postgres"
  exit 1
fi

post_account() {
  local id="$1" display="$2" address="$3"
  echo "  → seeding $id ($address)"
  # Idempotent: DELETE first (404 is fine), then POST.
  curl -sS -o /dev/null -w "    DELETE: %{http_code}\n" \
    -X DELETE -H "Authorization: Bearer $SECRET" \
    "$ENGINE_URL/api/mail/accounts/$id" || true
  # skipTest=true keeps the seed flow offline-clean — the engine would
  # otherwise refuse without a live IMAP login round-trip, but we want to
  # accept dummy creds against Greenmail's auth.disabled.
  curl -sS -o /tmp/seed-resp.json -w "    POST: %{http_code}\n" \
    -X POST \
    -H "Authorization: Bearer $SECRET" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
          --arg id "$id" \
          --arg display "$display" \
          --arg address "$address" \
          --arg host "$GREENMAIL_HOST" \
          '{
            id: $id,
            displayName: $display,
            address: $address,
            preset: "custom",
            type: "personal",
            credentials: { user: $address, pass: "staging" },
            custom: {
              imap: { host: $host, port: 3143, secure: false },
              smtp: { host: $host, port: 3025, secure: false }
            },
            skipTest: true
          }')" \
    "$ENGINE_URL/api/mail/accounts"
  # Surface failures — the script bombs out if any account didn't land.
  if ! jq -e '.ok == true' /tmp/seed-resp.json >/dev/null 2>&1; then
    echo "FAIL on $id:"
    cat /tmp/seed-resp.json
    exit 1
  fi
}

echo "Seeding 4 staging-Greenmail test accounts on $ENGINE_URL"
post_account "staging-business" "Staging Business" "business-customer@test.lynox.cloud"
post_account "staging-rule"     "Staging Rule"     "auto-confirm@test.lynox.cloud"
post_account "staging-stripe"   "Staging Stripe"   "invoice@mail.stripe-fake.test.lynox.cloud"
post_account "staging-noise"    "Staging Noise"    "noreply-promo@news.example.com"
echo "Done."
