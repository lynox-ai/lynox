# Security Policy

## Reporting a Vulnerability

We take security reports seriously and aim to acknowledge within 48 hours.

**Preferred — GitHub Security Advisories:**
[github.com/lynox-ai/lynox/security/advisories/new](https://github.com/lynox-ai/lynox/security/advisories/new) — private, CVE-numbered, lets us coordinate a release. This is the path we'd like every researcher to use.

**Alternative — Email:** security@lynox.ai — for reporters who can't use GitHub Advisories, or want PGP. The PGP fingerprint will appear here once the key is published; until then use the GitHub Advisory path.

Please include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact (data exposure / privilege escalation / etc.)
- Suggested fix (if any)
- Your preferred attribution (handle, name, or anonymous)

We aim to provide a fix within 7 days for critical issues, 14 days for high-severity, 30 days for medium. Lower-severity issues are addressed in the next regular release.

**Do not** open a public GitHub issue for security vulnerabilities.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith. Specifically, you have our authorization to:

- Test any lynox release running on infrastructure you control (self-hosted, your dev box, a fresh `docker compose up`).
- Perform automated vulnerability scanning against your own self-hosted instance.
- Probe edge cases in the public Web UI / API of your own self-hosted instance.

This authorization does not extend to:

- The managed hosting service (`control.lynox.cloud`, `*.lynox.cloud` per-tenant instances). Testing there affects other customers' data — out of scope.
- The website (`lynox.ai`) — out of scope.
- Social engineering of lynox staff, customers, or contractors.
- Denial-of-service attacks, even against your own self-hosted instance, when the attack would degrade GitHub / npm / Anthropic / Mistral infrastructure.
- Physical attacks against infrastructure.

Researchers acting in good faith under this policy: we will work with you, credit you (if you want), and won't notify law enforcement. If you're unsure whether your planned testing is covered, email security@lynox.ai before you start and we'll clarify within 24 hours.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Security Audit (April 2026)

Internal OWASP Top 10 review of the lynox Core engine and Web UI. No critical or high-severity vulnerabilities found.

### Results by Category

| OWASP Category | Status | Details |
|----------------|--------|---------|
| **A01 Broken Access Control** | PASS | Engine runs as single-user process. Session IDs are process-local, not cross-user. Memory namespaces validated against a fixed whitelist (4 values). |
| **A02 Cryptographic Failures** | PASS | AES-256-GCM with unique IV per encryption. PBKDF2 600K iterations (SHA-512). Session tokens use HMAC-SHA256 with HKDF-derived keys. Nonces via `crypto.randomBytes`. Timing-safe comparison for all secrets. |
| **A03 Injection** | PASS | No raw SQL — all queries parameterized (better-sqlite3). Attachment names sanitized via `basename()` + control char removal. Bash tool blocks 50+ dangerous patterns via permission guard. |
| **A04 Insecure Design** | PASS | One-time login codes: 32-byte entropy, 5-minute TTL, atomic consumption. Prompts: SQLite-backed with 24-hour expiry. Secret collection (`ask_secret`) bypasses conversation entirely. |
| **A05 Security Misconfiguration** | PASS | Security headers set (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, CSP, HSTS on TLS). No debug endpoints. Error responses do not leak stack traces. |
| **A06 Vulnerable Components** | PASS | `pnpm audit` clean (0 vulnerabilities). Dependency overrides protect against known CVEs in transitive deps (path-to-regexp, cookie, lodash-es, serialize-javascript). |
| **A07 XSS** | PASS | All markdown rendered through DOMPurify. Error messages HTML-escaped before rendering. Search highlighting escapes both text and query. SSE data JSON-stringified. Artifact iframes sandboxed (`allow-scripts` only). |
| **A08 CSRF** | PASS | API clients use Bearer tokens. Session cookies set `SameSite=Lax` (was `Strict` pre-v1.6.0 — relaxed for OAuth-callback compatibility; documented in CHANGELOG), `HttpOnly`, `Secure` (on HTTPS). |
| **A09 Logging Failures** | PASS | Failed logins, rate limit hits, and security events logged. Bugsink integration (always active on managed, opt-in on self-hosted) with PII scrubbing. |
| **A10 SSRF** | PASS | SearXNG URL validation blocks cloud metadata endpoints (169.254.x, metadata.google.internal). Scheme restricted to http/https. 5-second timeout. Private IPs allowed by design (Docker/LAN deployments). |

### Dependency Audit

```
$ pnpm audit
No known vulnerabilities found
```

### Architecture (6 Security Layers)

1. **TLS** — Optional, typically behind reverse proxy
2. **CORS** — Whitelist-based (`LYNOX_ALLOWED_ORIGINS`)
3. **Rate Limiting** — 120 req/min global, 600 req/min loopback
4. **Authentication** — Bearer token or HMAC session cookie
5. **Authorization** — Admin/user scope (two-tier token system)
6. **Permission Guard** — Blocks destructive bash commands, injection detection, data boundary enforcement

## Security Model

### API Keys

lynox uses a Bring Your Own Key (BYOK) model. Your Anthropic API key is stored locally in `~/.lynox/config.json` and never transmitted to any server other than the Anthropic API (or your configured `ANTHROPIC_BASE_URL`).

### Secret Vault

Sensitive values can be stored in an encrypted vault (`~/.lynox/vault.db`):
- AES-256-GCM encryption
- PBKDF2 with 600,000 iterations (SHA-512)
- Requires `LYNOX_VAULT_KEY` environment variable

### Bash Tool

The bash tool blocks known destructive commands:
- `rm -rf /` and variants
- Force push to main/master
- Other dangerous patterns

### HTTP Tool

The HTTP tool includes SSRF protection to prevent requests to internal networks and metadata endpoints.

### Workspace Sandbox

When running in Docker, lynox operates in a sandboxed workspace:
- Write access limited to `/workspace` and `/tmp`
- Read-only root filesystem
- Non-root user (uid 1001)
- `no-new-privileges` security option

### Pre-Approval System

Tool execution can be controlled via pre-approval patterns:
- Glob-based matching
- Critical tool detection and blocking
- TTL and usage limits
- Full SQLite audit trail

### Plugin Isolation

Plugins are loaded only from `~/.lynox/plugins/node_modules/` with validated package names. Secret content is stripped from plugin context.
