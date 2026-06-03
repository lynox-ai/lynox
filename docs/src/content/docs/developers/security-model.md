---
title: Security Model
description: Technical security architecture of the lynox engine — cryptography, authentication, SSRF, sandboxing, permission guards. References the actual code paths.
sidebar:
  order: 4
---

This page documents the security primitives lynox actually ships, with pointers to the source files. It is the technical companion to [`SECURITY.md`](https://github.com/lynox-ai/lynox/blob/main/SECURITY.md) (which covers vulnerability reporting + safe harbor).

For a full audit of the running code, run `pnpm run security` (security scan + vitest security tests) and `pnpm audit --prod` (dependency CVEs).

## Authentication

- **Session cookies** — HMAC-signed, `httpOnly` + `Secure` (on HTTPS) + `SameSite=Lax`. Source: `packages/web-ui/src/lib/server/auth.ts`. 30-day TTL by default; reduced to 7-day for users that opt out of "remember me".
- **Bearer tokens** — programmatic clients use `Authorization: Bearer <token>`. Tokens are stored hashed (HMAC-SHA256); raw values exist only at issue-time.
- **One-time login codes (magic link / QR)** — 256-bit (`crypto.randomBytes(32)`), 5-minute TTL, atomic single-use consumption, rate-limited 5 attempts per 15 minutes per IP. Source: `packages/web-ui/src/lib/server/auth.ts`.

## Cryptography

| Primitive | Algorithm | Source |
|---|---|---|
| Vault encryption | AES-256-GCM, unique IV per write | `src/core/secret-vault.ts` |
| Vault key derivation | PBKDF2 with 600,000 iterations (SHA-512) | `src/core/secret-vault.ts` |
| Session tokens | HMAC-SHA256 with HKDF-derived keys | `packages/web-ui/src/lib/server/auth.ts` |
| Migration handshake | X25519 ECDH → AES-256-GCM per chunk + HMAC-signed handshake | `src/core/migration-crypto.ts` |
| Random | `crypto.randomBytes` for all nonces, IVs, tokens, salts | — |
| Comparison | `crypto.timingSafeEqual` for all secret comparisons | — |

## SSRF protection

Every outbound URL from the agent flows through `fetchWithPublicRedirects` in `src/core/network-guard.ts`:

- DNS is resolved once; the connection is pinned to the validated IP at TCP-connect time (rebind-safe).
- Each redirect hop is re-validated against the same allowlist.
- Cloud metadata endpoints blocked (`169.254.x`, `metadata.google.internal`, `metadata.azure.com`).
- Scheme restricted to `http` / `https`.
- 5-second connect timeout per hop.
- Private IP ranges (RFC 1918, loopback, link-local) blocked by default; an opt-in escape hatch exists for Docker / LAN deployments via configured allow-list.

## Bash tool guard

`src/tools/permission-guard.ts` blocks destructive shell patterns before execution:

- `rm -rf /` and variants
- `git push --force` to `main` / `master`
- Forks bombs, kernel-level destructive ops
- ~50 other dangerous patterns

Patterns are documented in the file; user-configurable additions live in the per-tenant config.

## Input + output guards

- **Input guard** (`src/core/input-guard.ts`) — classifies user requests for malicious intent (malware creation, exploit-framework setup, phishing, credential harvesting, security evasion) using verb+target patterns. Discussing a topic is fine; requesting its weaponization is blocked.
- **Output guard** (`src/core/output-guard.ts`) — scans tool-call payloads being written to disk for reverse shells, crypto miners, keyloggers, persistence mechanisms before they leave the agent loop.

## HTTP API hardening

`src/server/http-api.ts`:

- Security headers set on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy` (disables camera/microphone/geolocation by default), `Content-Security-Policy`, `Strict-Transport-Security` (on TLS).
- Rate-limited: default 120 req/min global, with loopback / trusted-proxy bypass for local development.
- Error responses do not leak stack traces.
- No debug endpoints in production builds.

## Workspace sandbox (Docker)

The shipped `Dockerfile` configures:

- Non-root user (`uid 1001`, name `lynox`)
- Read-only root filesystem (`read_only: true` in `docker-compose.yml`); write-access limited to `/workspace`, `/tmp`, and `/home/lynox/.cache` (tmpfs).
- `no-new-privileges` security option.
- `pids_limit` to cap process explosion.
- `json-file` logging with rotation.

## Secret handling

- Secrets enter the vault only via the `ask_secret` tool, which bypasses the conversation log entirely. The model never sees them post-entry.
- Env vars always override the vault (priority: env > vault > config). This lets ops override compromised vault entries without re-encrypting.
- Bugsink (error reporting) PII-scrubs known secret patterns before sending events.

## Tested attack surface

Run `npx vitest run tests/security/` for the security-specific test suite. Coverage includes:

- Path traversal in tool I/O
- SSRF rebind attempts
- Bash command injection
- SQL injection (parameterized queries via `better-sqlite3`)
- Markdown XSS rendering (DOMPurify)
- SSE replay / session fixation
- HMAC tampering
- Migration handshake replay (single-use token)

## Out of scope

- Multi-tenant isolation on a shared host. lynox engine is **single-tenant by design** — one process per tenant. Tenant isolation in the managed offering comes from the container boundary (Docker), not from in-process partitioning. See `pro/CLAUDE.md` for the managed-hosting architecture.
- Anti-fingerprinting / anti-tracking in the Web UI. The Web UI is meant for the operator's own browser; we don't try to defeat fingerprinting from a hostile host.
- LLM provider exfiltration risk. Conversation content goes to the configured LLM provider (Anthropic, Mistral, BYOK). See [`/privacy`](https://lynox.ai/privacy) and the [DPA](https://lynox.ai/dpa) for the data-transfer story.
