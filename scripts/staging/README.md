# Staging helper scripts

Tooling for the staging engine at `engine.lynox.cloud` + the staging CP at
`control-staging.lynox.cloud`. Each script documents its own prereqs at the
top; this README is the index.

## Greenmail end-to-end smoke

Live IMAP/SMTP backend so the four wave-2/3 fixes (counter dekrement, long-
subject preservation, unsnooze-on-reply, bulk-prefilter pass-through) can be
verified end-to-end against the merged staging code, not just unit tests.

### Network topology

The Greenmail container runs on `control-staging.lynox.cloud` (the CP host),
not on the staging tenant host (`host-staging-02`). The Hetzner firewall
`control-plane-staging` restricts the Greenmail ports (3025 SMTP, 3143 IMAP,
8080 admin REST) to `78.47.14.168/32` — the staging tenant host's public IP.
**Your dev machine cannot reach those ports directly.** That's by design:
plain SMTP without auth is an open mail relay.

The smoke runner talks to Greenmail over an SSH tunnel that pops out on
control-staging's `localhost`, which the firewall doesn't filter. SSH (port
22) is reachable from anywhere with the right key, so the tunnel works
without a firewall change.

### One-time setup (after first deploy of Greenmail to control-staging)

```bash
# Seed the four test accounts in the staging engine via admin API.
# Idempotent — re-running deletes + re-posts.
./scripts/staging/seed-greenmail-accounts.sh
```

Accounts:
- `staging-business` (business-customer@test.lynox.cloud) — classifier path
- `staging-rule` (auto-confirm@test.lynox.cloud) — auto_handled rule path
- `staging-stripe` (invoice@mail.stripe-fake.test.lynox.cloud) — bulk-prefilter pass-through
- `staging-noise` (noreply-promo@news.example.com) — bulk-prefilter rejects

Each account uses `credentials.user = <full-email>` so Greenmail routes mail
to that user's mailbox (Greenmail's `auth.disabled` mode accepts any creds
but each user only sees their own box).

### Run the smoke

```bash
# 1. Open the SSH tunnel (background). Forwards localhost:13025 →
#    control-staging:3025 (SMTP), :13143 → :3143 (IMAP), :18080 →
#    :8080 (admin REST). Stays up until you kill it.
ssh -i ~/.ssh/lynox-staging \
    -L 13025:localhost:3025 \
    -L 13143:localhost:3143 \
    -L 18080:localhost:8080 \
    -N -f -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    root@control-staging.lynox.cloud

# 2. Mint a 30-day staging cookie.
cookie=$(./scripts/mint-staging-cookie.sh)

# 3. Run the four scenarios. Each PURGES Greenmail's mailboxes first AND
#    triggers an engine cold-start so the IMAP pull happens within the
#    polling timeout (Greenmail's IMAP IDLE support is partial).
STAGING_COOKIE=$cookie \
GREENMAIL_HOST=127.0.0.1 \
GREENMAIL_SMTP_PORT=13025 \
GREENMAIL_ADMIN_PORT=18080 \
  pnpm tsx scripts/staging/inbox-greenmail-smoke.ts

# 4. Close the tunnel when done.
pkill -f 'ssh.*-L 13025:localhost:3025'
```

Exit code 0 = all four scenarios pass. Non-zero = first failing scenario
name printed to stderr.

### Why plain TCP, not IMAPS/SMTPS?

The engine's `POST /api/mail/accounts` API does not expose the provider's
`insecureTls` flag — production paths must reject self-signed certs by
design. Greenmail ships only a self-signed RSA cert. Staging-only
accommodation: connect the engine to ports `3025` (plain SMTP) and `3143`
(plain IMAP) with `secure: false`. The Hetzner firewall + Greenmail's
`auth.disabled` mode keep this safe inside the staging boundary.

### Manual debug

If a scenario fails, useful manual queries (with the tunnel up):

```bash
# Greenmail mailbox count for a specific user
curl -sS "http://localhost:18080/api/user/business-customer%40test.lynox.cloud/messages" | jq 'length'

# Engine mail-account list
curl -sS -H "Cookie: lynox_session=$cookie" \
  https://engine.lynox.cloud/api/mail/accounts | jq '.accounts[].id'

# Force engine to poll a specific account NOW
curl -sS -X POST -H "Cookie: lynox_session=$cookie" \
  -H "Content-Type: application/json" \
  -d '{"accountId":"staging-business","force":true}' \
  https://engine.lynox.cloud/api/inbox/cold-start/run

# Engine cold-start status (most recent run per account)
curl -sS -H "Cookie: lynox_session=$cookie" \
  https://engine.lynox.cloud/api/inbox/cold-start | jq '.recent[]'

# Purge Greenmail mailboxes (Greenmail 2.x — was /api/user/purge in v1)
curl -sS -X POST http://localhost:18080/api/mail/purge
```
