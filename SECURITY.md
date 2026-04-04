# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in lynox, please report it responsibly:

**Email:** security@lynox.ai

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to provide a fix within 7 days for critical issues.

**Do not** open a public GitHub issue for security vulnerabilities.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Security Audit (April 2026)

Independent OWASP Top 10 review of the lynox Core engine and Web UI. No critical or high-severity vulnerabilities found.

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
| **A08 CSRF** | PASS | API clients use Bearer tokens. Session cookies set `SameSite=Strict`, `HttpOnly`, `Secure` (on HTTPS). |
| **A09 Logging Failures** | PASS | Failed logins, rate limit hits, and security events logged. Sentry integration (opt-in) with PII scrubbing. |
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
