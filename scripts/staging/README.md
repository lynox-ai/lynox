# Staging helper scripts

Tooling for the staging engine at `engine.lynox.cloud` + the staging CP at
`control-staging.lynox.cloud`. Each script documents its own prereqs at the
top; this README is the index.

## Greenmail end-to-end smoke

Live IMAP/SMTP backend so the four wave-2/3 fixes (counter dekrement, long-
subject preservation, unsnooze-on-reply, bulk-prefilter pass-through) can be
verified end-to-end against the merged staging code, not just unit tests.

### One-time setup (after first deploy of Greenmail to control-staging)

```bash
# 1. Seed the four test accounts in the staging engine via admin API.
#    Idempotent — re-running deletes + re-posts.
./scripts/staging/seed-greenmail-accounts.sh
```

### Run the smoke

```bash
# 2. Mint a 30-day staging cookie.
STAGING_COOKIE=$(./scripts/mint-staging-cookie.sh)

# 3. Run the four scenarios. Each PURGES Greenmail's mailboxes first.
STAGING_COOKIE=$STAGING_COOKIE pnpm tsx scripts/staging/inbox-greenmail-smoke.ts
```

Exit code 0 = all four scenarios pass. Non-zero = first failing scenario name
printed to stderr; check the engine logs on `host-staging-02` via the admin
API if anything looks classifier-related.

### Why plain TCP, not IMAPS/SMTPS?

The engine's `POST /api/mail/accounts` API does not expose the provider's
`insecureTls` flag (production paths must reject self-signed certs). Greenmail
ships only a self-signed RSA cert. Staging-only accommodation: connect the
engine to ports `3025` (plain SMTP) and `3143` (plain IMAP). Hetzner firewall
restricts inbound to the staging tenant host's public IP — DO NOT remove that
rule, the plain ports are an open mail relay without it.
