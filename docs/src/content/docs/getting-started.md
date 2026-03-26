---
title: "Getting Started"
description: "Get your AI agent running in 5 minutes — no technical skills needed"
---

## Before You Start

You need one thing: an **Anthropic API key**. This is how nodyn connects to Claude (the AI).

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account
2. Click **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-`)

Anthropic charges per usage — a typical business day costs $1–5. You can set a spending limit in their console.

---

## Deploy nodyn

### The easy way — no technical skills needed

Use the **[deploy page on nodyn.dev/deploy](https://nodyn.dev/deploy)**. It walks you through everything in your browser:

1. **Enter your API key** — paste the key you just created
2. **Set up Telegram** (optional) — create a bot in 2 minutes, the page detects your chat ID automatically
3. **Pick a provider** — Hetzner (€3.79/mo), DigitalOcean ($6/mo), or Vultr ($5/mo)
4. **Copy the generated script** and paste it into your provider's setup page

Your credentials never leave your browser — everything is generated client-side.

After 2–3 minutes, your server is ready. Open Telegram, message your bot, done.

:::tip[Just want to try it first?]
Run nodyn on your own computer to explore what it can do:
```bash
curl -fsSL https://nodyn.dev/install.sh | sh
```
A setup wizard walks you through the rest. When you're ready for 24/7, use the [deploy page](https://nodyn.dev/deploy) to move to a server. All your knowledge carries over.
:::

---

## Your First Conversation

Once nodyn is running, talk to it like you would to a colleague — via Telegram or the terminal.

**Simple things to start with:**

- *"Check my emails and tell me what's important"*
- *"Summarize this document"* (attach a file in Telegram)
- *"Research [topic] and give me the key points"*
- *"What meetings do I have this week?"* (after connecting Google)

nodyn remembers everything in the [knowledge graph](/memory/) automatically. The more you use it, the more it knows about your business.

:::note[Don't worry about automation yet]
You don't need to plan workflows or set up automation right away. Just use nodyn for everyday tasks. After you've done something a few times, nodyn will suggest turning it into an automated workflow.
:::

---

## What Happens Automatically

After setup, you don't need to manage anything. nodyn takes care of itself:

| What | How | You need to do |
|------|-----|---------------|
| **Updates** | Checked daily, applied automatically via [Watchtower](https://containrrr.dev/watchtower/) | Nothing |
| **Encryption** | AES-256-GCM, key generated during setup | Nothing |
| **Restarts** | Auto-restart on crash or server reboot | Nothing |
| **Knowledge** | Grows with every conversation | Just keep talking to nodyn |
| **Backups** | To Google Drive via `/backup` command | Set up once in Telegram |

Your server runs 24/7 with zero maintenance.

---

## What 24/7 Unlocks

Once nodyn runs on a server, it works in the background — even when you're not talking to it:

- *"Every Monday at 9am, summarize my emails from last week"* — runs automatically, delivered to Telegram
- *"Monitor competitor.com for pricing changes"* — checks in the background, alerts you when something changes
- *"Pull KPIs from the tracking sheet every Friday"* — scheduled, hands-free
- Every conversation builds the knowledge graph — nodyn gets smarter over time

---

## Connect Your Tools

All integrations are optional. Add them whenever you're ready:

| Integration | What it does | How to set up |
|-------------|-------------|---------------|
| **Telegram** | Use nodyn from your phone — voice, text, photos, documents | Set up during deploy, or see [Telegram Guide](/telegram/) |
| **Google Workspace** | Gmail, Sheets, Drive, Calendar, Docs | [Google Workspace Guide](/google-workspace/) |
| **Web Research** | Live web search for current information | Add a [Tavily](https://tavily.com) API key (free: 1K searches/month). For privacy, disable "Allow use of query data" in Tavily settings. |
| **Any REST API** | Connect nodyn to any service you use | [API Store](/api-store/) — describe the API, nodyn learns it |

---

## Moving from Local to Server

Already tried nodyn locally? Everything you've built — knowledge, config, conversation history — lives in one folder. To move it to your server:

1. Use your provider's web console (browser-based terminal) to access your server
2. Upload the `~/.nodyn/` folder from your computer
3. Restart nodyn: the knowledge, config, and history are picked up automatically

See [Docker Deployment](/docker/) for details.

---

## What's Next

- **[Telegram Bot](/telegram/)** — voice messages, file sharing, follow-up suggestions
- **[Google Workspace](/google-workspace/)** — connect Gmail, Sheets, Calendar
- **[Knowledge](/memory/)** — how nodyn remembers your business
- **[Backup](/backup/)** — automatic backups to Google Drive
- **[Configuration](/configuration/)** — cost limits, accuracy, model settings

---

## Technical Reference

:::note
Everything below is optional reading for users who want to understand what happens under the hood.
:::

### Setup Wizard (local install)

The wizard runs automatically when no API key is found. Re-run anytime with `npx @nodyn-ai/core --init`.

**Step 1 — API Key**: Paste your Anthropic key. Verified live against the API. Encryption is enabled automatically (AES-256-GCM).

**Step 2 — Integrations** (all optional): A checklist where you pick what to connect. Arrow keys to move, Space to toggle, Enter to confirm.

| Integration | What it does |
|-------------|-------------|
| Google Workspace | Gmail, Sheets, Drive, Calendar, Docs via OAuth |
| Telegram | Mobile access — use nodyn from your phone |
| Web Research | Live web research via [Tavily](https://tavily.com) (free: 1K/month) |

Skip all with Enter or Esc — add anytime later via `/google`, `/telegram`, or `/config`.

### SSH Setup Script

For users who already have a server and prefer the command line:

```bash
curl -fsSL https://nodyn.dev/setup-server.sh | sh
```

The script installs Docker, collects your API key and Telegram token interactively, generates an encryption key, and starts nodyn in a hardened container. See [Docker Deployment](/docker/) for manual setup options.

### Persistence

| What | Where | Survives restart? |
|------|-------|-------------------|
| API key + config | `~/.nodyn/config.json` | Yes |
| Vault key | `~/.nodyn/.env` | Yes (auto-loaded) |
| Run history | `~/.nodyn/history.db` | Yes (encrypted) |
| Knowledge | `~/.nodyn/memory/` | Yes |

### CLI Quick Reference

```bash
# Interactive REPL
npx @nodyn-ai/core

# One-shot task
npx @nodyn-ai/core "Summarize the last 5 commits"

# Piped input
cat report.csv | npx @nodyn-ai/core "Find anomalies"

# Re-run setup
npx @nodyn-ai/core --init
```

See [CLI Reference](/cli/) for all commands and flags.

### Troubleshooting

**"Node.js 22+ required"** — Install via [nodejs.org](https://nodejs.org) or [nvm](https://github.com/nvm-sh/nvm). Docker users don't need Node.js locally.

**"Cannot reach api.anthropic.com"** — Warning only. The key is validated on first actual use. Check network/proxy settings.

**API key rejected** — Must start with `sk-ant-`, be at least 20 characters, and be active in [console.anthropic.com](https://console.anthropic.com/).

**Telegram bot not responding** — Check that no other instance uses the same bot token. Use your provider's web console to check logs if needed.
