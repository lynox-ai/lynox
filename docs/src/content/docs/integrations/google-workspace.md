---
title: Google Workspace
description: Connect Gmail, Calendar, Drive, Sheets, and Docs.
sidebar:
  order: 2
---

lynox integrates with Google Workspace to read and write your business data. Once connected, you can ask lynox to check your email, create calendar events, analyze spreadsheets, and more.

## Prerequisites

You need a Google Cloud project with OAuth 2.0 credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the APIs you want:
   - Gmail API
   - Google Sheets API
   - Google Drive API
   - Google Calendar API
   - Google Docs API
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop app** as application type
6. Copy the **Client ID** and **Client Secret**

## Configure

**Via Web UI:** Settings → Integrations → Google Workspace. Enter Client ID and Secret, then authorize.

**Via environment variables:**

```bash
export GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=GOCSPX-...
```

## Authorization

lynox supports three OAuth flows:

| Flow | Best for | How it works |
|------|----------|-------------|
| **Browser** | Local installs | Opens your browser for Google sign-in |
| **Device Flow** | Docker / headless | Shows a code to enter at google.com/device |
| **Service Account** | Server-to-server | Uses a key file, no user interaction |

The Web UI guides you through the appropriate flow. For Docker, the device flow is used automatically.

## Scopes

By default, lynox requests **read-only** access:

- Read Gmail messages
- Read Google Sheets
- Read Google Drive files
- Read Google Calendar events
- Read Google Docs

**Write access** is opt-in. You can enable it per service when needed:

- Send and modify Gmail
- Edit Sheets
- Upload to Drive
- Create/edit Calendar events
- Edit Docs

Scopes can be customized in the config:

```json
{
  "google_oauth_scopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events"
  ]
}
```

## What You Can Do

### Gmail

- *"What's in my inbox today?"*
- *"Find emails from [contact] about [topic]"*
- *"Draft a reply to the last email from [name]"*
- *"Send a follow-up to [contact]"* (requires write scope)

### Google Sheets

- *"Summarize the Q1 revenue sheet"*
- *"Add a row to my expenses tracker"* (requires write scope)
- *"Compare last month's numbers with this month"*

### Google Drive

- *"Find the proposal document from last week"*
- *"Summarize the PDF in my Drive called [name]"*

### Google Calendar

- *"What meetings do I have tomorrow?"*
- *"Schedule a call with [name] next Tuesday at 10am"* (requires write scope)
- *"Block 2 hours for deep work this afternoon"* (requires write scope)

### Google Docs

- *"Summarize the meeting notes in [document]"*
- *"Update the project status section"* (requires write scope)

## Token Storage

OAuth tokens are stored encrypted in the lynox vault (requires `LYNOX_VAULT_KEY`). Tokens refresh automatically — you only need to authorize once.

You can revoke access anytime via the Web UI (Settings → Integrations → Google → Revoke).
