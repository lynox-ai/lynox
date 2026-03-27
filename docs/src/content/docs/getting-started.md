---
title: "Getting Started"
description: "Get your AI agent running in 5 minutes — no technical skills needed"
---

## Before You Start

You need one thing: an **Anthropic API key**. This is how lynox connects to Claude (the AI).

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account
2. Click **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-`)

Anthropic charges per usage — a typical business day costs $1–5. You can set a spending limit in their console.

---

## Deploy lynox

### The easy way — no technical skills needed

Use the **[deploy page on lynox.ai/deploy](https://lynox.ai/deploy)**. It walks you through everything in your browser — choose the path that fits you:

**New cloud server** — don't have a server yet? Pick Hetzner (€3.79/mo), DigitalOcean ($6/mo), or Vultr ($5/mo). The page generates a setup script you paste into your provider's console. Your server is ready in 2–3 minutes.

**Existing server** — already have a VPS or homelab? The page generates a `.env` file, `docker run` command, and `docker-compose.yml` ready for download and copy-paste. No cloud-init needed.

Both paths walk you through:

1. **Enter your API key** — paste the key you just created
2. **Set up Telegram** (optional) — create a bot in 2 minutes, the page detects your chat ID automatically
3. **Download or copy** the generated config

Your credentials never leave your browser — everything is generated client-side. Each step has a "What is this?" hint for non-technical users.

:::tip[Just want to try it first?]
Run lynox on your own computer to explore what it can do:
```bash
curl -fsSL https://lynox.ai/install.sh | sh
```
A setup wizard walks you through the rest. When you're ready for 24/7, use the [deploy page](https://lynox.ai/deploy) to move to a server. All your knowledge carries over.
:::

---

## Your First Conversation

Once lynox is running, talk to it like you would to a colleague — via Telegram or the terminal.

**Simple things to start with:**

- *"Check my emails and tell me what's important"*
- *"Summarize this document"* (attach a file in Telegram)
- *"Research [topic] and give me the key points"*
- *"What meetings do I have this week?"* (after connecting Google)

lynox remembers everything in the [knowledge graph](/memory/) automatically. The more you use it, the more it knows about your business.

:::note[Don't worry about automation yet]
You don't need to plan workflows or set up automation right away. Just use lynox for everyday tasks. After you've done something a few times, lynox will suggest turning it into an automated workflow.
:::

---

## What Happens Automatically

After setup, you don't need to manage anything. lynox takes care of itself:

| What | How | You need to do |
|------|-----|---------------|
| **Updates** | Checked daily, applied automatically via [Watchtower](https://containrrr.dev/watchtower/) | Nothing |
| **Encryption** | AES-256-GCM, key generated during setup | Nothing |
| **Restarts** | Auto-restart on crash or server reboot | Nothing |
| **Knowledge** | Grows with every conversation | Just keep talking to lynox |
| **Backups** | To Google Drive via `/backup` command | Set up once in Telegram |
| **Bug reports** | Anonymized error reports to help improve lynox | Opt-in after first task (one tap) |

Your server runs 24/7 with zero maintenance.

---

## What 24/7 Unlocks

Once lynox runs on a server, it works in the background — even when you're not talking to it:

- *"Every Monday at 9am, summarize my emails from last week"* — runs automatically, delivered to Telegram
- *"Monitor competitor.com for pricing changes"* — checks in the background, alerts you when something changes
- *"Pull KPIs from the tracking sheet every Friday"* — scheduled, hands-free
- Every conversation builds the knowledge graph — lynox gets smarter over time

---

## Connect Your Tools

All integrations are optional. Add them whenever you're ready:

| Integration | What it does | How to set up |
|-------------|-------------|---------------|
| **Telegram** | Use lynox from your phone — voice, text, photos, documents | Set up during deploy, or see [Telegram Guide](/telegram/) |
| **Google Workspace** | Gmail, Sheets, Drive, Calendar, Docs | Send `/google` in Telegram — authorize in your browser, done |
| **Web Research** | Live web search for current information | Add [Tavily](https://tavily.com) API key during deploy (free: 1K searches/month). For privacy, disable "Allow use of query data" in Tavily settings. |
| **Any REST API** | Connect lynox to any service you use | [API Store](/api-store/) — describe the API, lynox learns it |

### Connecting Google Workspace

Send `/google` to your bot in Telegram. lynox will send you a link and a code:

1. Open the link on your phone or computer
2. Sign in with your Google account and enter the code
3. Authorize access — lynox confirms in Telegram when it's done

That's it — Gmail, Sheets, Drive, Calendar, and Docs are ready. No terminal needed.

---

## Moving from Local to Server

Already tried lynox locally? Everything you've built — knowledge, config, conversation history — lives in one folder. To move it to your server:

1. Use your provider's web console (browser-based terminal) to access your server
2. Upload the `~/.lynox/` folder from your computer
3. Restart lynox: the knowledge, config, and history are picked up automatically

See [Docker Deployment](/docker/) for details.

---

## What's Next

After setup, explore these features via Telegram — just ask lynox or use the commands:

| Feature | How to start | What it does |
|---------|-------------|--------------|
| **[Gmail & Calendar](/google-workspace/)** | Send `/google` in Telegram | Read emails, draft replies, check meetings |
| **[Contacts & CRM](/crm/)** | Just mention people and deals | lynox tracks clients, deals, and follow-ups automatically |
| **[Web Research](/tools/)** | "Research [topic]" | Live web search, structured summaries |
| **[Backups](/backup/)** | "Set up a backup" or `/backup` | Encrypted backups to Google Drive |
| **[Scheduled Tasks](/tools/)** | "Do this every Monday at 9am" | Runs in the background, sends results to Telegram |
| **[Connect any Service](/api-store/)** | "I use [service], here's the API docs" | lynox learns any API from a description |
| **[Cost Limits](/configuration/)** | Send `/cost` in Telegram | See your spending, set daily limits |

Everything builds on the knowledge graph — the more you use lynox, the better it understands your business. Facts, relationships, preferences, and decisions are remembered automatically across every conversation.

---

## Technical Reference

:::note
Everything below is optional reading for users who want to understand what happens under the hood.
:::

### Setup Wizard (local install)

The wizard runs automatically when no API key is found. Re-run anytime with `npx @lynox-ai/core --init`.

**Step 1 — Prerequisites**: Checks Node.js version, `~/.lynox` directory, and network. If something fails, you get a concrete fix command and can retry (up to 3 times) without restarting the wizard.

**Step 2 — API Key**: Paste your Anthropic key. Verified live against the API (rate limits and server errors are distinguished from invalid keys). Up to 5 attempts with increasingly specific hints. Encryption is enabled automatically (AES-256-GCM).

**Step 3 — Integrations** (all optional): A checklist where you pick what to connect. Arrow keys to move, Space to toggle, Enter to confirm.

| Integration | What it does |
|-------------|-------------|
| Google Workspace | Gmail, Sheets, Drive, Calendar, Docs via OAuth |
| Telegram | Mobile access — use lynox from your phone |
| Web Research | Live web research via [Tavily](https://tavily.com) (free: 1K/month) |

For Telegram, the wizard auto-detects your chat ID (with a progress hint after 30s and manual instructions on timeout). Skip all integrations with Enter or Esc — add anytime later via `/google`, `/telegram`, or `/config`.

### SSH Setup Script

For users who already have a server and prefer the command line:

```bash
curl -fsSL https://lynox.ai/setup-server.sh | sh
```

The script installs Docker, collects your API key and Telegram token interactively, generates an encryption key, and starts lynox in a hardened container. See [Docker Deployment](/docker/) for manual setup options.

### Deploy Page (browser-based)

For users who prefer a visual setup without touching the terminal, the **[deploy page](https://lynox.ai/deploy)** generates everything in the browser:

- **New cloud server**: Cloud-init script for Hetzner, DigitalOcean, or Vultr
- **Existing server**: Downloadable `.env` file + `docker run` / `docker-compose.yml`

All credentials stay client-side. See [Deploy lynox](#deploy-lynox) above.

### Persistence

| What | Where | Survives restart? |
|------|-------|-------------------|
| API key + config | `~/.lynox/config.json` | Yes |
| Vault key | `~/.lynox/.env` | Yes (auto-loaded) |
| Run history | `~/.lynox/history.db` | Yes (encrypted) |
| Knowledge | `~/.lynox/memory/` | Yes |

### CLI Quick Reference

```bash
# Interactive REPL
npx @lynox-ai/core

# One-shot task
npx @lynox-ai/core "Summarize the last 5 commits"

# Piped input
cat report.csv | npx @lynox-ai/core "Find anomalies"

# Re-run setup
npx @lynox-ai/core --init
```

See [CLI Reference](/cli/) for all commands and flags.

### Troubleshooting

**"Node.js 22+ required"** — Install via [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm). Docker users don't need Node.js locally.

**"Cannot reach api.anthropic.com"** — Warning only. The key is validated on first actual use. Check network/proxy settings.

**API key rejected** — Must start with `sk-ant-`, be at least 20 characters, and be active in [console.anthropic.com](https://console.anthropic.com/). The wizard distinguishes between invalid keys, rate limits, and server errors — check the specific message.

**"Rate limited"** — Wait a moment and try again. This means the Anthropic API is temporarily throttling requests, not that your key is wrong.

**Telegram bot not responding** — Check that no other instance uses the same bot token. Use your provider's web console to check logs if needed.

**Telegram chat ID timeout** — If auto-detection times out, the wizard shows how to find your chat ID manually via the Telegram `getUpdates` API.
