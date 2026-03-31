---
title: Security
description: How lynox protects your data and credentials.
sidebar:
  order: 3
---

lynox is designed for self-hosting. Your data stays on your machine, your API key talks directly to Anthropic, and all secrets are encrypted locally.

## Bring Your Own Key (BYOK)

lynox never proxies your API calls. Your Anthropic API key is used directly — there's no middleman, no data collection, no usage tracking.

## Encrypted Vault

All sensitive data (API keys, OAuth tokens, credentials) is stored in an AES-256-GCM encrypted vault.

### How it works

1. **Setup** — The setup wizard generates a random vault key and saves it to `~/.lynox/.env`
2. **Storage** — Secrets are encrypted before being written to `~/.lynox/vault.db`
3. **Access** — The vault key is loaded from `LYNOX_VAULT_KEY` environment variable at startup

### Managing the vault key

The vault key is your master encryption key. Keep it safe:

- It's generated during setup and stored in `~/.lynox/.env`
- The setup wizard can add it to your shell profile for auto-loading
- For Docker, pass it as `LYNOX_VAULT_KEY` environment variable
- **View and copy** your vault key anytime in **Settings → Config → Security**
- **Save it to a password manager** — if you lose the vault key, encrypted secrets cannot be recovered (but you can re-enter them)
- Store your vault key **separately from your backups** — if both are lost, the data is unrecoverable

### Key rotation

You can rotate the vault key via the Web UI (Settings → Config → Security) or the API. This re-encrypts all stored secrets with a new key.

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
