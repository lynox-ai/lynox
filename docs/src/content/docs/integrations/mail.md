---
title: Email (IMAP/SMTP)
description: Connect any email account via IMAP and SMTP — triage, search, read, send, and track follow-ups.
sidebar:
  order: 5
  badge:
    text: New
    variant: success
---

lynox connects to any email account that supports IMAP and SMTP. Add your Gmail, iCloud, Fastmail, Outlook, Yahoo, or any custom mail server — lynox handles triage, search, reading, sending, and follow-up tracking.

This is a standalone integration that works with any LLM provider. It's separate from the [Google Workspace](/integrations/google-workspace/) Gmail integration (which uses OAuth).

## Setup

### Via Web UI (recommended)

Go to **Settings → Integrations → Mail**. Click **Add Account** and:

1. Select your email provider (or "Custom" for any IMAP/SMTP server)
2. Enter your email address — lynox auto-discovers server settings for known providers
3. Generate an **app password** (required for Gmail, iCloud, Outlook, Yahoo — links provided in the UI)
4. Choose an account type (personal, business, support, etc.)
5. Test the connection

### Via environment variables

```bash
# Account credentials are stored in the vault.
# Use the Web UI for multi-account setup — env vars work for single-account bootstrapping.
export LYNOX_MAIL_ADDRESS=you@example.com
export LYNOX_MAIL_PASSWORD=your-app-password
export LYNOX_MAIL_PRESET=gmail    # gmail | icloud | fastmail | yahoo | outlook | custom
```

### App passwords

Most providers require an app-specific password instead of your regular login. This is a security feature — the app password grants only mail access, not full account access.

| Provider | 2FA required | Where to generate |
|----------|-------------|-------------------|
| **Gmail** | Yes | [Google Account → App Passwords](https://myaccount.google.com/apppasswords) |
| **iCloud** | Yes | [Apple ID → App-Specific Passwords](https://appleid.apple.com/) |
| **Fastmail** | Recommended | [Settings → Security → App Passwords](https://www.fastmail.com/settings/security/devicekeys) |
| **Yahoo** | Yes | [Account Security → App Passwords](https://login.yahoo.com/myaccount/security/app-passwords) |
| **Outlook** | Yes | [Microsoft Account → App Passwords](https://account.live.com/proofs/AppPassword) |
| **Custom** | Varies | Check your provider's documentation |

## Supported Providers

| Provider | IMAP | SMTP | Auto-configured |
|----------|------|------|----------------|
| Gmail | imap.gmail.com:993 | smtp.gmail.com:587 | Yes |
| iCloud | imap.mail.me.com:993 | smtp.mail.me.com:587 | Yes |
| Fastmail | imap.fastmail.com:993 | smtp.fastmail.com:587 | Yes |
| Yahoo | imap.mail.yahoo.com:993 | smtp.mail.yahoo.com:587 | Yes |
| Outlook | outlook.office365.com:993 | smtp-mail.outlook.com:587 | Yes |
| Custom | Your server | Your server | Autodiscover via Thunderbird ISPDB |

For custom servers, lynox tries autodiscovery first (using Mozilla's ISPDB). If that fails, enter host, port, and TLS settings manually.

## Account Types

Each account has a **type** that controls how lynox interacts with it — tone, send permissions, and auto-reply behavior.

### Send-capable types

| Type | Tone | Behavior |
|------|------|----------|
| `personal` | Casual, warm, first-person | Full agent capability |
| `business` | Professional, direct | Draft-first (never auto-send) |
| `support` | Short, polite, action-oriented | Acknowledge issue + state next steps |
| `sales` | Warm professional, benefit-led | References CRM touchpoints |
| `hello` | Friendly, brief | First contact with prospects |

### Receive-only types

These types **cannot send** — lynox only reads and triages incoming mail.

| Type | Purpose |
|------|---------|
| `info` | General information inbox |
| `newsletter` | Subscriptions and digests |
| `notifications` | Automated system alerts |
| `abuse` | Abuse reports (compliance) |
| `privacy` | Privacy requests (compliance) |
| `security` | Security reports (compliance) |
| `legal` | Legal notices (compliance) |

Compliance types (abuse, privacy, security, legal) always escalate to you — lynox never auto-responds to these.

## What You Can Do

### Triage

- *"What's new in my inbox?"*
- *"Triage my unread emails"*
- *"Show me anything important from today"*

lynox filters noise automatically (newsletters, no-reply senders, List-Unsubscribe headers) and groups messages by thread.

### Search

- *"Find emails from Sarah about the Q1 report"*
- *"Show me flagged emails from last week"*
- *"Search for invoices with attachments"*

Searches across all configured accounts by default, or specify one: *"Search my support inbox for refund requests"*.

### Read

- *"Read the latest email from [name]"*
- *"Show me the full thread about [topic]"*

### Send & Reply

- *"Draft a reply to the contract email"*
- *"Send a follow-up to Sarah about the proposal"*
- *"Reply all to the team update"*

:::caution[Send confirmation]
Sending and replying always require your explicit confirmation. lynox shows you the full message before sending — nothing goes out without your approval.
:::

### Follow-Up Tracking

- *"Track this — I'm expecting a reply by Friday"*
- *"Remind me if Sarah doesn't respond within 3 days"*

lynox tracks follow-ups and reminds you when expected replies don't arrive. Follow-ups can be created automatically when sending, or manually for any message.

## Multi-Account

lynox supports multiple email accounts simultaneously. Each account has its own type, persona, and credentials.

- **Triage and search** fan out across all accounts when no specific account is named
- **Smart reply-from** — when replying, lynox automatically selects the sending account if one of the original recipients matches a registered account
- **Default account** — the first account added becomes the default for sending

## Security

### Credentials

- App passwords stored AES-256-GCM encrypted in the lynox vault
- Credentials are never cached in memory — re-read from vault on every connection
- Env vars override vault (same priority as all other secrets)

### Transport

- Implicit TLS enforced (IMAPS :993, SMTPS :465) — preferred over STARTTLS
- Minimum TLS 1.2, strict certificate validation
- Connection timeouts: 10s connect, 60s idle with exponential backoff

### Content safety

- All email bodies are wrapped in `<untrusted_data>` tags before the LLM sees them — defense against prompt injection via email content
- Hidden HTML elements (display:none, font-size:0) are detected and stripped
- Scripts, styles, and HTML comments removed before text extraction

### Send protection

- Interactive confirmation required for every send
- Mass-send guard: >5 recipients forces explicit confirmation with full recipient list
- Receive-only account types hard-blocked from sending (non-overrideable)
- Auto-reply loop protection (RFC 3834) — prevents responding to autoresponders

## Token Efficiency

lynox is designed to minimize LLM cost for email operations:

- **Triage prefilter** — deterministic noise filter skips ~60% of mail with zero LLM tokens (newsletters, no-reply, List-Unsubscribe)
- **Envelope-only search** — ~100 tokens per message (subject, from, date, 500-char snippet)
- **Thread grouping** — related messages shown as a single thread, not individual items
- **Body cleaning** — quoted history and signatures stripped, reducing token count by 30–70%

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Authentication failed" | Wrong password or 2FA not set up | Generate a new app password (see table above) |
| "TLS handshake failed" | Server doesn't support TLS 1.2+ | Check your mail server's TLS configuration |
| "Connection timed out" | Firewall or wrong server address | Verify host/port, check if IMAP is enabled in your provider settings |
| "Connection refused" | Wrong port or server down | Common: Gmail needs IMAP enabled in Gmail Settings → Forwarding and POP/IMAP |
| "Rate limited" | Too many connection attempts | Wait a few minutes, then retry |

## Gmail vs. Google Workspace

lynox has two ways to access Gmail:

| | Email (IMAP/SMTP) | Google Workspace |
|---|---|---|
| Auth | App password | OAuth 2.0 |
| Setup time | 2 minutes | 5 minutes |
| Gmail access | Read + send | Read + send |
| Calendar, Drive, Sheets, Docs | No | Yes |
| Works with non-Gmail | Yes | No |
| Best for | Gmail-only users, multi-provider setups | Full Google Workspace users |

You can use both — they don't conflict. The IMAP integration is simpler if you only need email.
