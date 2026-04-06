---
title: Security
description: How lynox protects your data and credentials.
sidebar:
  order: 3
---

lynox is designed for self-hosting. Your data stays on your machine, your API key talks directly to Anthropic, and all secrets are encrypted locally.

## Bring Your Own Key (BYOK)

lynox never proxies your API calls. Your credentials talk directly to your chosen provider — Claude (Anthropic), Claude (AWS Bedrock), or a custom proxy. All providers serve the same Claude models. There's no middleman, no data collection, no usage tracking. The installer lets you choose your provider and enter credentials on first run. All credentials are stored encrypted in the local vault.

## Authentication

lynox supports two authentication modes depending on your deployment:

### Self-Hosted (Token)

Set `LYNOX_HTTP_SECRET` to enable authentication. The Web UI shows a token login form. Sessions last 30 days. QR-code login is available for mobile devices.

### Managed Hosting (Email OTP + Passkeys)

Managed instances use email-based one-time codes instead of permanent tokens:

1. **Email OTP** — Enter your email, receive a 6-digit code, sign in. No token to save or lose.
2. **Passkeys** — After your first login, set up Face ID, Touch ID, or a security key for instant login. OTP remains as fallback.
3. **Login notifications** — Every login triggers an email with device and IP information.

Sessions last 30 days. Passkey credentials use WebAuthn (FIDO2) with the `lynox.cloud` relying party.

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

## Input & Output Scanning

lynox scans both incoming and outgoing content:

- **Input guard** — Validates and sanitizes user input before processing
- **Output guard** — Checks responses before delivering them

## Data Boundaries

- All data is stored locally in `~/.lynox/`
- File operations are restricted to the configured workspace directory
- HTTP requests include SSRF protection (no access to internal networks by default)
- `enforce_https` option available for environments that require encrypted connections

## Error Reporting

If you opt in to error reporting (via `LYNOX_SENTRY_DSN`), all reports are scrubbed of PII before transmission. This is entirely optional and disabled by default.

## Docker Hardening

The Docker images include additional security measures:

- Non-root user (`lynox`, UID 1001)
- Read-only root filesystem
- `no-new-privileges` security option
- No shell, package manager, or unnecessary binaries in the image
- tmpfs for temporary storage

See [Docker Deployment](/daily-use/docker/) for the full hardened setup.
