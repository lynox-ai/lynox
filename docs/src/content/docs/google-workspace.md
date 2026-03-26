---
title: "Google Workspace"
description: "Gmail, Sheets, Drive, Calendar, and Docs integration"
---

lynox connects to Google Workspace (Gmail, Sheets, Drive, Calendar, Docs) via OAuth 2.0. No third-party packages required — uses native `fetch()` against Google REST APIs.

## Quick Setup (via Telegram)

The easiest way to connect Google — no terminal needed:

1. Send `/google` to your lynox bot in Telegram
2. Open the link lynox sends you (works on phone or computer)
3. Sign in with your Google account and enter the code shown
4. Authorize access — lynox confirms in Telegram when connected

That's it. Gmail, Sheets, Drive, Calendar, and Docs are ready to use.

:::note[Prerequisites]
Your deployment needs Google OAuth credentials (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). If you haven't set these up yet, follow the [credential setup](#credential-setup) below first.
:::

## Credential Setup

You need OAuth credentials from Google before you can connect. This is a one-time setup.

### 1. Create a GCP Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the following APIs:
   - Gmail API
   - Google Sheets API
   - Google Drive API
   - Google Calendar API
   - Google Docs API

### 2. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Desktop app**
4. Note the **Client ID** and **Client Secret**

### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. User type: **External** (or Internal for Google Workspace domains)
3. Add test users (required while app is in "Testing" status — add your own email)

### 4. Add Credentials to lynox

**Option A: Environment variables** (recommended for server deployments)

Add to your server's `~/.lynox/.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Then restart lynox (`docker restart lynox`).

**Option B: Config file** (`~/.lynox/config.json`)

```json
{
  "google_client_id": "your-client-id.apps.googleusercontent.com",
  "google_client_secret": "your-client-secret"
}
```

### 5. Authenticate

**Via Telegram (recommended):**

Send `/google` in Telegram. lynox uses Google's Device Flow — you get a link and a code, authorize in any browser, and tokens are stored encrypted automatically.

**Via CLI:**

```
/google auth
```

This starts a localhost redirect OAuth flow — lynox opens the Google consent screen in your browser and handles the redirect automatically.

Tokens auto-refresh. Run `/google status` to check connection.

## Service Account (Alternative)

For automated environments without user interaction, use a service account:

1. Go to **IAM & Admin > Service Accounts** in GCP Console
2. Create a service account
3. Download the JSON key file
4. Set the environment variable:

```bash
export GOOGLE_SERVICE_ACCOUNT_KEY=/path/to/service-account.json
```

**Key file requirements:**
- Must be an **absolute path** (no relative paths)
- File permissions must be `0600` or `0400` (warns if too loose)
- Must contain valid JSON with `type: "service_account"`, `project_id`, `private_key`, `client_email`

Service accounts don't require interactive authentication but need domain-wide delegation for accessing user data in Google Workspace domains.

## CLI Commands

| Command | Description |
|---------|-------------|
| `/google auth` | Start OAuth device flow |
| `/google status` | Show connection status, scopes, token expiry |
| `/google disconnect` | Revoke tokens and remove stored credentials |

## Tools

5 tools are registered when Google credentials are configured:

- `google_gmail` — Email: search, read, send, reply, draft, archive, labels
- `google_sheets` — Spreadsheets: read, write, append, create, list, format
- `google_drive` — Files: search, read, upload, create docs, list, move, share
- `google_calendar` — Events: list, create, update, delete, free/busy
- `google_docs` — Documents: read, create, append, find & replace

See [tools.md](/tools/) for full action reference.

## Scopes

Default OAuth scopes are **read-only** for security. Write scopes are opt-in:

- `READ_ONLY_SCOPES` (default): Gmail read, Sheets read, Drive read, Calendar read, Docs read
- `WRITE_SCOPES` (opt-in): Gmail send/modify, Sheets write, Drive write, Calendar events, Docs write

To enable write scopes, set `google_oauth_scopes` in config:

```json
{
  "google_oauth_scopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets"
  ]
}
```

Alternatively, the agent can request additional scopes at runtime via `requestScope()`, which triggers re-authentication with the new scope set.

## Permission Model

- **Read-only actions** (search, read, list) work immediately after auth
- **Write actions** (send, write, upload, create, delete) require user confirmation in interactive mode and the corresponding write scope
- **Scope escalation**: If write scope is missing, the tool returns an error with instructions to re-auth. Use `requestScope()` to upgrade incrementally

## Security

### Credential Protection

- OAuth tokens encrypted in SecretVault (`GOOGLE_OAUTH_TOKENS` key, requires `LYNOX_VAULT_KEY`)
- Tokens auto-refresh via refresh token — no re-authentication needed
- `/google disconnect` revokes tokens at Google and deletes vault entry
- Service account key files validated: absolute path, 0o600/0o400 permissions, valid JSON structure
- OAuth tokens (`ya29.*`) and JWTs masked in debug output via `maskTokenPatterns()`
- No credentials are ever logged, stored in memory, or sent to external services
- Gmail blocks sending emails that contain detected secrets (API keys, bearer tokens)

### Prompt Injection Defense (3-Layer)

Google Workspace data is external and attacker-controlled (anyone can send you an email, share a doc, or create a calendar invite). All read results are defended against indirect prompt injection:

1. **Tool-level**: All read handlers wrap external content via `wrapUntrustedData()` — marks data as untrusted before the LLM sees it. Boundary-escape tags (`</untrusted_data>`) in content are neutralized
2. **Agent-level**: All 5 Google tools are in `EXTERNAL_TOOLS` — every response is scanned via `scanToolResult()` for 17 injection patterns (12 categories) (tool invocation, instruction overrides, ChatML/Llama tokens, role impersonation, exfiltration, boundary escape)
3. **Behavioral**: `ToolCallTracker` detects suspicious tool call sequences: Google read → email send (data exfiltration), Google read → HTTP POST (data exfiltration), Google read → sensitive file read (credential harvesting)

### Gmail HTML Hardening

`stripHtml()` removes content that could hide injection payloads:
- HTML comments (`<!-- hidden instructions -->`)
- CDATA sections (`<![CDATA[...]]>`)
- Hidden elements (`display:none`, `visibility:hidden`, `opacity:0`)
- Script and style blocks (including their content)

### Write Protection

- All write actions require interactive user confirmation (fail-safe: blocked if no prompt available)
- All write actions hard-blocked in autonomous mode via `permission-guard.ts`
- Default OAuth scopes are read-only — write scopes require explicit opt-in
