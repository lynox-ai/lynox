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
This setup is for **your own Google Cloud project** — self-hosted, Docker, or managed hosting where you
prefer to bring your own OAuth client. Each project is separate, so no Google security audit of lynox is
involved.
:::

:::tip[On lynox.cloud you can skip all of it]
Managed instances can connect through lynox's own Google client: one button on the Google card, no Cloud
project, no client ID. The consent then asks for a deliberately narrow set — calendar events, free/busy,
and the Drive files lynox itself creates. If you need more than that (reading Gmail, editing existing
spreadsheets, full Drive), bring your own client with the setup below; the card offers it under
*Advanced*.
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
| **External** | You use a **personal `@gmail.com`** account, or want non-Workspace users to connect | App starts in "Testing" mode: max 100 test users, and **refresh tokens expire after 7 days**. That expiry is tied to the *publishing status*, not to verification — see the note below |

"Internal" only appears if your account belongs to a Workspace organization. If you don't see it, pick "External".

:::caution
**The 7-day refresh-token expiry is tied to the publishing status, not to verification.** Google's wording:
a project *"configured for an external user type and a publishing status of `Testing` is issued a refresh
token expiring in 7 days"* (OAuth 2.0 guide, read 2026-08-27). Switching the publishing status from
**Testing** to **In production** therefore ends the 7-day expiry on its own — you do **not** have to
complete verification first. The trade-off is that an app requesting sensitive or restricted scopes shows
an unverified-app warning screen until verification is granted, and Google's OAuth quota table caps such an
app at *"100 new users in total, after the app presents the unverified app screen"*.

**Verification and CASA are two different bars.** Verification is free — Google says sensitive-scope
verification *"typically takes 3-5 business days"* (read 2026-08-27) — and applies to *sensitive* scopes. The annual CASA security assessment applies only to *restricted*
scopes — for Google Workspace that means full-mailbox and full-Drive access such as `gmail.readonly`,
`gmail.modify`, `drive` and `drive.readonly`. Narrower scopes often cost less — `calendar.events` and
`documents.readonly` are sensitive (verification, no CASA), and `drive.file` — files the app creates or the
user explicitly picks — is not even sensitive.

**But "narrower" does not help for Gmail, and that is the case most people look up.** Every OAuth path to
mailbox content is restricted, including the narrow-looking ones: `gmail.readonly`, `gmail.modify`,
`gmail.compose`, `gmail.metadata` (headers only) and the IMAP scope `https://mail.google.com/` are all on
Google's restricted list. The axis is *how much data the scope exposes*, not read-versus-write — which is
why full calendar access including deletion is only sensitive, while a metadata-only mailbox scope is not.
If you want mailbox access without a CASA assessment, an OAuth scope is not the route; lynox also supports
plain IMAP/SMTP with an app password. Google publishes no per-scope list; the authoritative
classification is shown in the Cloud Console under **Google Auth Platform → Data access**.
:::

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

The card offers two named levels. They are **not** "read" and "write" — Google's own axis is how much
data a scope exposes, which is why full calendar access including deletion is only *sensitive* while a
headers-only mailbox scope is *restricted*.

| Level | What it asks Google for | What that costs |
|-------|-------------------------|-----------------|
| **Standard** (default) | Your identity and email address, calendar events, free/busy, and the Drive files lynox creates (`drive.file`) | App verification. **No CASA assessment** — nothing in this set is restricted. |
| **Full** | Standard, plus Sheets, Docs, Calendar and Gmail-send, plus Gmail reading and full Drive | Verification **and** an annual CASA security assessment, because it includes restricted scopes. |

**What Standard does not include, so nothing here is a surprise later:** no Gmail access of any kind, no
access to spreadsheets or documents you did not create through lynox, and no access to Drive files lynox
did not create. Asking lynox to read an existing spreadsheet on a Standard connection is refused with the
scope it would need, not attempted and failed.

**Choosing Full changes where your mail comes from.** Full includes a Gmail read scope, and lynox then
reads that mailbox over the Google connection instead of over IMAP. If you have the mailbox connected as
IMAP as well, that is the switch to be aware of.

Switching levels requires re-authorising with Google. A connection made before these two levels existed
keeps working and shows as *legacy* — nothing changes until you pick a level.

For advanced use, scopes can be set directly. The **accepted** list is wider than the two levels above,
for two different reasons — and only the first is about you:

- **Scopes lynox used to request.** A connection made before the levels existed keeps working; nothing
  it was granted is rejected now.
- **Scopes lynox has never requested but Google classifies**, such as `gmail.metadata` or the blanket
  `calendar`. They are accepted if your grant already carries them; lynox will not ask for them.

Anything outside that list is rejected:

```json
{
  "google_oauth_scopes": [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/drive.file"
  ]
}
```

## What You Can Do

### Gmail — only on a **Full** connection

Gmail is **not** part of the Standard set. On a Full connection your Gmail mailbox appears in
**Settings → Integrations → Mail** alongside any IMAP/SMTP accounts, and the same mail tools
(`mail_triage`, `mail_search`, `mail_read`, `mail_send`, `mail_reply`) work across all of them — there is
no separate Gmail tool. On a Standard connection the mailbox is not registered at all and the card says
so; connect it over IMAP with an app password instead.

- *"What's in my inbox today?"* (spans Gmail + IMAP if you have both)
- *"Find emails from [contact] about [topic]"*
- *"Draft a reply to the last email from [name]"*
- *"Send a follow-up to [contact]"*

### Google Sheets — only on a **Full** connection

Standard grants no Sheets access. A read on a Standard connection is refused naming the scope it needs.

- *"Summarize the Q1 revenue sheet"*
- *"Add a row to my expenses tracker"*
- *"Compare last month's numbers with this month"*

### Google Drive — files lynox created, unless you go Full

Standard grants `drive.file`, which reaches only what lynox itself created or you explicitly picked.
Searches say so in their result rather than reporting an empty Drive.

- *"Find the proposal document from last week"* (only if lynox created it)
- *"Summarize the PDF in my Drive called [name]"* (same)

### Google Calendar — in the Standard set

Creating, moving and deleting events needs **no** upgrade: `calendar.events` is part of Standard. Each
change is confirmed before it happens.

- *"What meetings do I have tomorrow?"*
- *"Schedule a call with [name] next Tuesday at 10am"*
- *"Block 2 hours for deep work this afternoon"*

### Google Docs — only on a **Full** connection

Standard grants no Docs access at all, reading included.

- *"Summarize the meeting notes in [document]"*
- *"Update the project status section"*

## Token Storage

OAuth tokens are stored encrypted in the lynox vault (requires `LYNOX_VAULT_KEY`). Tokens refresh automatically — you only need to authorize once.

You can revoke access anytime via the Web UI (Settings → Integrations → Google → Revoke).
