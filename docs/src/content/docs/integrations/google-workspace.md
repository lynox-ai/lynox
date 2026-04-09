---
title: Google Workspace
description: Connect Gmail, Calendar, Drive, Sheets, and Docs.
sidebar:
  order: 2
---

lynox integrates with Google Workspace to read and write your business data. Once connected, you can ask lynox to check your email, create calendar events, analyze spreadsheets, and more.

## Setup

You need a Google Cloud project with OAuth 2.0 credentials. This takes about 5 minutes.

### 1. Create a Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project selector at the top → **New Project**
3. Name it (e.g. "lynox") and click **Create**

If you already have a project, select it instead.

### 2. Enable APIs

1. In the sidebar, go to **APIs & Services** → **Library**
2. Search for each of these APIs and click **Enable**:

| API name | What it's used for |
|----------|-------------------|
| `Gmail API` | Read and send email |
| `Google Drive API` | Access files in Drive |
| `Google Calendar API` | Read and manage events |
| `Google Sheets API` | Read and edit spreadsheets |
| `Google Docs API` | Read and edit documents |

:::tip
You can copy each API name and paste it directly into the Library search bar.
:::

### 3. Configure the OAuth consent screen

1. In the sidebar, go to **OAuth consent screen**
2. If you see "Google Auth Platform not configured yet", click **Get Started**
3. **App information** — Enter an app name (e.g. "lynox") and select your email as support email → **Next**
4. **Audience** — Select **External** → **Next**
5. **Contact information** — Enter your email → **Next**
6. **Finish** → Click **Create**

:::note
Your app starts in "Testing" mode. This is fine — you just need to add yourself as a test user. Go to **OAuth consent screen** → **Test users** → **Add users** → enter your Google email.
:::

### 4. Create OAuth credentials

1. In the sidebar, go to **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. **Application type** → select **Desktop app** (not "Web application")
4. **Name** → enter anything (e.g. "lynox")
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

:::caution
The application type must be **Desktop app**. If you choose "Web application", the OAuth device flow will not work.
:::

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
