---
title: Google Workspace
description: Connect Gmail, Calendar, Drive, Sheets, and Docs.
sidebar:
  order: 2
---

lynox integrates with Google Workspace to read and write your business data. Once connected, you can ask lynox to check your email, create calendar events, analyze spreadsheets, and more.

## Setup

You need a Google Cloud project with OAuth 2.0 credentials. This takes about 5 minutes.

:::note
This setup applies to **all deployments** — self-hosted, Docker, and managed hosting (lynox.cloud). Each user creates their own Google Cloud project, so no Google security audit is needed.
:::

### 1. Create a Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project selector at the top → **New Project**
3. Name it (e.g. "lynox") and click **Create**

If you already have a project, select it instead.

:::caution
**"You don't have permission `resourcemanager.projects.create`"** — your Google account is part of a Workspace organization but lacks the **Project Creator** role on it. Either:
- Pick **"No organization"** in the project-creation dropdown (works without extra rights), or
- Ask your Workspace Super Admin to grant you the **Project Creator** role at https://console.cloud.google.com/iam-admin/iam (select your org at the top, then **Grant access** → add your email → role *Project Creator*).
:::

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
4. **Audience** — pick the right user type (see below) → **Next**
5. **Contact information** — Enter your email → **Next**
6. **Finish** → Click **Create**

#### Internal vs. External — pick the right one

| User type | Pick when… | Tradeoffs |
|---|---|---|
| **Internal** *(recommended if available)* | You have a **Google Workspace** account and only Workspace users will connect | No Google verification ever, refresh tokens never expire, no test-user list |
| **External** | You use a **personal `@gmail.com`** account, or want non-Workspace users to connect | App starts in "Testing" mode: max 100 test users, **refresh tokens expire after 7 days** until you go through Google verification (CASA for Gmail/Drive scopes) |

"Internal" only appears if your account belongs to a Workspace organization. If you don't see it, pick "External".

:::note
**External only** — your app starts in "Testing" mode. Add yourself as a test user: **OAuth consent screen** → **Test users** → **Add users** → enter your Google email. Internal apps skip this step.
:::

### 4. Create OAuth credentials

The application type depends on your deployment:

#### Self-hosted (Docker / local)

1. In the sidebar, go to **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. **Application type** → select **Desktop app**
4. **Name** → enter anything (e.g. "lynox")
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

#### Managed hosting (lynox.cloud)

1. In the sidebar, go to **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. **Application type** → select **Web application**
4. **Name** → enter anything (e.g. "lynox")
5. **Authorized redirect URIs** → click **Add URI** → enter `https://<your-subdomain>.lynox.cloud/api/google/callback`
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

:::tip
The Web UI shows the exact redirect URI to copy — no need to type it manually.
:::

### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Wrong client type" | Wrong application type for your deployment | Self-hosted: **Desktop app** · Managed: **Web application** |
| "Invalid Client ID" | Client ID is wrong or has extra whitespace | Copy the Client ID again from Credentials page |
| Device flow not starting | APIs not enabled | Verify all 5 APIs are enabled (step 2) |
| "Access blocked" | Not added as test user | Add your email under OAuth consent screen → Test users |
| Callback returns 401 | Outdated lynox version | Update to the latest version |
| "redirect_uri_mismatch" | Redirect URI doesn't match | Verify the URI in Google Console matches exactly |

## Configure

**Via Web UI:** Settings → Integrations → Google Workspace. Enter Client ID and Secret, then authorize.

**Via environment variables:**

```bash
export GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=GOCSPX-...
```

## Authorization

lynox supports three OAuth flows:

| Flow | Best for | Client type | How it works |
|------|----------|-------------|-------------|
| **Redirect** | Managed hosting / web-hosted | Web application | Redirects to Google, sends you back after approval |
| **Device Flow** | Self-hosted Docker / headless | Desktop app | Shows a code to enter at google.com/device |
| **Service Account** | Server-to-server | — | Uses a key file, no user interaction |

The Web UI detects your deployment and uses the correct flow automatically.

## Access Level

The Web UI offers a toggle between two access levels:

| Level | What it includes |
|-------|-----------------|
| **Read only** (default) | Read Gmail, Sheets, Drive, Calendar, Docs |
| **Full access** | Everything above + send email, create events, edit sheets/docs, upload files |

You can switch the access level anytime in Settings → Integrations → Google Workspace. Changing the level requires re-authorization with Google (one click).

For advanced use, scopes can also be set via config:

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
