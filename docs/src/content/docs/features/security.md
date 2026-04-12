---
title: Security
description: How lynox protects your data and credentials.
sidebar:
  order: 3
---

lynox is designed for self-hosting. Your data stays on your machine, your API key talks directly to Anthropic, and all secrets are encrypted locally.

## Bring Your Own Key (BYOK)

lynox never proxies your API calls. Your credentials talk directly to your chosen provider — Claude (Anthropic), Claude (Google Vertex AI), OpenAI-compatible (Mistral, Gemini), or a custom proxy. Claude providers serve the same Claude models. There's no middleman, no data collection, no usage tracking. The installer lets you choose your provider and enter credentials on first run. All credentials are stored encrypted in the local vault.

## Authentication

lynox supports two authentication modes depending on your deployment:

### Self-Hosted (Token)

Set `LYNOX_HTTP_SECRET` to enable authentication. The Web UI shows a token login form. Sessions last 30 days. QR-code login is available for mobile devices.

### Managed Hosting (Email OTP + Passkeys)

Managed instances use email-based one-time codes instead of permanent tokens:

1. **Email OTP** — Enter your email, receive a 6-digit code, sign in. No token to save or lose.
2. **Passkeys** — After your first login, a prompt offers to set up Face ID, Touch ID, or a security key. Next time you log in, just confirm with your biometric — no email code needed.
3. **Login notifications** — Every login triggers an email with timestamp, device, and IP address. If you didn't log in, contact support immediately.

Sessions last 30 days. Passkey credentials use WebAuthn (FIDO2) with the `lynox.cloud` relying party. You can always fall back to email OTP if your passkey device isn't available.

### Logout

Click **Abmelden / Log out** in the sidebar (below Settings) to end your session. This clears the session cookie and redirects to the login page.

## Encrypted Vault

All sensitive data (API keys, OAuth tokens, credentials) is stored in an AES-256-GCM encrypted vault.

### How it works

1. **Setup** — The installer generates a random vault key (Docker auto-generates it on first start)
2. **Storage** — Secrets are encrypted before being written to `~/.lynox/vault.db`
3. **Access** — The vault key is loaded from `LYNOX_VAULT_KEY` environment variable at startup

### Managing the vault key

The vault key is your master encryption key. Keep it safe:

- It's generated during setup and stored in `~/.lynox/.env`
- Docker auto-generates and persists it to the volume
- For Docker, pass it as `LYNOX_VAULT_KEY` environment variable
- **View and copy** your vault key anytime in **Settings → Config → Security**
- **Save it to a password manager** — if you lose the vault key, encrypted secrets cannot be recovered (but you can re-enter them)
- Store your vault key **separately from your backups** — if both are lost, the data is unrecoverable
- **Environment variables always override vault** — if a vault entry becomes stale, set the env var (e.g. `ANTHROPIC_API_KEY`) to override it without needing the Web UI

### Key rotation

You can rotate the vault key via the Web UI (Settings → Config → Security) or the API. This re-encrypts all stored secrets with a new key.

## Secure Secret Collection

When lynox needs a credential (API key, token, password), it uses the `ask_secret` tool instead of regular chat. This ensures secrets **never enter the conversation** sent to the AI provider.

### How it works

1. **Agent requests a secret** — calls `ask_secret` with a name and prompt
2. **Consent step** — the UI shows "Stored encrypted locally and never sent to AI"
3. **Password input** — you type the secret in a masked field
4. **Direct vault storage** — the value goes straight to the encrypted vault via REST API, completely bypassing the chat
5. **Confirmation only** — the agent receives "Secret saved" — never the actual value

### Security guarantees

- The secret value **never enters the conversation history** (the messages sent to Anthropic)
- The secret value **never appears in SSE events** (the real-time stream to the UI)
- The secret value **never appears in logs** or observability channels
- The secret is **encrypted at rest** in the AES-256-GCM vault

### Using secrets in tools

After storing a secret, lynox references it as `secret:KEY_NAME` in tool inputs. The actual value is resolved at execution time in a local variable, used for the API call, and immediately discarded. If the secret accidentally appears in a tool response, it's automatically masked to `***<last4>`.

### Chat input guard

As an extra safety layer, the chat input detects common API key patterns (Anthropic, OpenAI, Stripe, GitHub, AWS, Google, Slack) and blocks the message with a warning if you accidentally try to paste a secret in the chat.

## Permission Guard

When lynox wants to perform a potentially impactful action (writing files, sending emails, executing commands), it asks for your approval first. The permission system ensures:

- **Read operations** are generally allowed without prompting
- **Write operations** require confirmation unless pre-approved
- **Network requests** are validated against SSRF protections
- **System commands** require explicit approval

In the CLI, you get an interactive approval dialog. In the Web UI, a confirmation prompt appears inline.

## Content Scanning (Prompt Injection Defense)

lynox treats all external content as untrusted. When tools fetch data from the web, email, APIs, or MCP servers, that content could contain adversarial prompts trying to manipulate the AI agent.

### 4-layer defense

1. **Data Boundary Wrapping** — External content is wrapped in `<untrusted_data>` XML markers with instructions for the LLM to treat it as raw data, not instructions. Boundary-escape attempts (including HTML entity encoding) are neutralized.

2. **Pattern Detection** — Content is scanned for injection patterns: tool invocation language, instruction overrides, role impersonation, prompt structure manipulation (`</system>`, ChatML, Llama tokens), and data exfiltration instructions. Detected patterns trigger a warning prepended to the content.

3. **Tool Result Scanning** — All non-internal tool results are scanned for injection. This covers HTTP responses, web search results, email content, Google Workspace data, MCP tool results, and any custom tools. Only explicitly internal tools (file operations, memory, artifacts) bypass scanning.

4. **Behavioral Anomaly Detection** — Tool call sequences are monitored for suspicious patterns: reading sensitive files followed by HTTP requests, Google data reads followed by outbound sends, and burst HTTP requests to multiple domains.

### What gets scanned

| Source | Wrapped | Scanned | Notes |
|--------|---------|---------|-------|
| HTTP responses | Yes | Yes | Size-limited, headers redacted |
| Web search results | Yes | Yes | HTML stripped, content extracted |
| Email content | Yes | Yes | HTML comments and hidden elements removed |
| Google Drive files | Yes | Yes | Size-limited |
| MCP tool results | Yes | Yes | All MCP tools scanned by default |
| Bash output | No | Yes | Pattern-scanned |
| Internal tools | No | No | File ops, memory, artifacts — trusted |

### Egress controls

- HTTP requests are checked for secrets in the request body before sending
- SSRF protection blocks access to private/internal networks
- Rate limiting on outbound HTTP (per-session and hourly/daily caps)

## Data Boundaries

- All data is stored locally in `~/.lynox/`
- File operations are restricted to the configured workspace directory
- HTTP requests include SSRF protection (no access to internal networks by default)
- `enforce_https` option available for environments that require encrypted connections

## Error Reporting

All error reports are scrubbed of PII before transmission.

- **Managed instances**: Error reporting is always active (Art. 6(1)(f) legitimate interest). Reports are sent to lynox's self-hosted Bugsink on EU infrastructure — no third-party transfer.
- **Self-hosted instances**: Error reporting is opt-in via `LYNOX_BUGSINK_DSN`. It is disabled by default — you choose whether and where to send reports.

## Docker Hardening

The Docker image and Compose file include production-grade hardening out of the box:

| Measure | Description |
|---------|-------------|
| Non-root user | Runs as `lynox` (UID 1001), never root |
| Read-only filesystem | `read_only: true` — no writes to the image |
| Capabilities dropped | `cap_drop: ALL` — no Linux capabilities |
| Privilege escalation blocked | `no-new-privileges` security option |
| No shell or package manager | bash, apt, dpkg, perl removed from image |
| SUID bits stripped | No setuid binaries in the image |
| tmpfs for temp storage | `/tmp` and `/workspace` are memory-backed |
| Process limits | `pids_limit: 512` prevents fork bombs |
| Log rotation | `max-size: 20m, max-file: 3` prevents disk filling |
| Network isolation | Internal Docker network between services |
| Health checks | Built-in Docker `HEALTHCHECK` on `/health` |

See [Docker Deployment](/setup/docker/) for the full hardened setup.

## Self-Hosted: Your Responsibility

lynox ships hardened containers, but running a production system requires additional measures that depend on your infrastructure:

| Area | What you need to do |
|------|---------------------|
| **TLS / HTTPS** | Set up a reverse proxy (Caddy, nginx, Traefik) or a Cloudflare Tunnel for encrypted connections |
| **Firewall** | Restrict inbound traffic to ports you need (typically 443). Block SSH from the public internet |
| **Backups** | Back up `~/.lynox/` regularly — it contains your vault key, knowledge graph, and all conversation history |
| **Host hardening** | Keep your OS updated, enable automatic security updates (`unattended-upgrades`) |
| **Access control** | Set a strong `LYNOX_HTTP_SECRET`. Don't expose port 3000 without authentication |
| **Vault key** | Save your `LYNOX_VAULT_KEY` separately. If you lose it and the volume is destroyed, encrypted data is unrecoverable |

:::tip[Managed hosting handles all of this]
Managed hosting includes TLS, firewall, health monitoring, automatic updates, and encrypted backups — so you can focus on using lynox instead of running it. See [lynox.ai](https://lynox.ai) for plans.
:::
