---
title: "Getting Started"
description: "Install nodyn and run your first session"
---

## Before You Start

You need one thing: an **Anthropic API key**. This is how nodyn connects to Claude (the AI).

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account
2. Click **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-`)

Anthropic charges per usage — a typical business day costs $1–5. You can set a spending limit in their console.

## Choose Your Setup

| If you... | Do this | Time |
|-----------|---------|------|
| Want the fastest start | [One-line install](#one-line-install) | 2 min |
| Already have Node.js | [npx](#npx) | 1 min |
| Prefer containers | [Docker](#docker) | 3 min |
| Want always-on (server) | [Docker](/docker/) | 5 min |

### One-line install

Open **Terminal** (Mac: Spotlight → "Terminal", Linux: Ctrl+Alt+T) and paste:

```bash
curl -fsSL https://nodyn.dev/install.sh | sh
```

This installs Node.js if needed and sets up nodyn. A setup wizard walks you through the rest.

### npx

If you already have [Node.js 22+](https://nodejs.org):

```bash
npx @nodyn-ai/core
```

### Docker

If you have [Docker](https://docker.com/get-started/):

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.nodyn:/home/nodyn/.nodyn \
  ghcr.io/nodyn-ai/nodyn:latest
```

See [Docker Deployment](/docker/) for Telegram, encryption, and production setup.

---

All three paths lead to the same **setup wizard** — it configures everything interactively. No manual config files needed.

## Setup Wizard

The wizard runs automatically when no API key is found. Re-run anytime with `npx @nodyn-ai/core --init`.

**Step 1 — API Key**: Paste your Anthropic key. Verified live against the API. Encryption is enabled automatically (AES-256-GCM).

**Step 2 — Integrations** (all optional): A checklist where you pick what to connect. Arrow keys to move, Space to toggle, Enter to confirm.

| Integration | What it does |
|-------------|-------------|
| Google Workspace | Gmail, Sheets, Drive, Calendar, Docs via OAuth |
| Telegram | Mobile access — use nodyn from your phone |
| Web Research | Live web research via [Tavily](https://tavily.com) (free: 1K/month) |

Skip all with Enter or Esc — add anytime later via `/google`, `/telegram`, or `/config`.

After setup, nodyn optionally asks about your business (4 quick questions) to give more relevant suggestions from the start. All skippable. Update later with `/profile update`.

## Your First Session

After setup you're in the interactive REPL. Try `/quickstart` for a guided tour:

```
/quickstart

  Quick Start
  Try these to see what nodyn can do:

  1. Explore this project
     nodyn reads your files and explains the project

  2. Summarize recent git activity
     nodyn uses tools (git, file reading) autonomously

  3. Ask a business question
     type any question about your work — nodyn remembers the answer

  Pick a number (1-3):
```

Or just start typing:

```
❯ Summarize my git log from this week
❯ What files are in this project?
❯ /help
❯ /status
```

### One-shot mode

Run a single task without entering the REPL:

```bash
npx @nodyn-ai/core "Summarize the last 5 commits in this repo"
```

### Piped input

```bash
cat report.csv | npx @nodyn-ai/core "Find anomalies in this data"
```

### Next step: Connect Telegram

The terminal is great for setup and development — but for daily use, Telegram is where nodyn shines. Rich status updates, follow-up suggestions, voice messages, file uploads — all from your phone.

If you skipped Telegram during the setup wizard, add it now:

```bash
npx @nodyn-ai/core --init
```

Or set the environment variable directly:

```bash
TELEGRAM_BOT_TOKEN=123:ABC... npx @nodyn-ai/core
```

Create a bot via [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. See [Telegram Bot](/telegram/) for the full feature set.

## Docker

Use `docker compose` for the simplest setup (see [`docker-compose.yml`](../docker-compose.yml) in the repo root):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

Or use `docker run` directly:

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.nodyn:/home/nodyn/.nodyn \
  ghcr.io/nodyn-ai/nodyn:latest
```

> **Important:** Always mount `~/.nodyn` — without it, all config, knowledge, and history are lost when the container exits.

See [Docker](/docker/) for Telegram, encryption, production deployment, and all environment variables.

---

## Setup Reference

Detailed walkthrough of each wizard step. The summary table above covers the essentials — this section is for users who want to understand what happens under the hood.

### Prerequisites

Before asking any questions, the wizard checks automatically:
- **Node.js 22+** — exits with a clear message if your version is too old
- **~/.nodyn directory** — verifiable and writable
- **Network** — warns if api.anthropic.com is unreachable (API key verification may fail)

### API Key

```
  API Key
  console.anthropic.com → API Keys → Create Key
  Key: sk-ant-...
  ✓ Verified.
  ✓ Encryption enabled.
```

Paste your Anthropic API key. nodyn validates the format (`sk-` prefix, 20+ characters) and makes a live API call to verify it works. Invalid keys are rejected with a retry prompt.

**Encryption** is enabled automatically — a random vault key is generated and saved to `~/.nodyn/.env` (file permissions `0o600`). Your run history, secrets, and OAuth tokens are encrypted with AES-256-GCM at rest. The wizard offers to add a `source` line to your shell profile so future sessions load the key automatically.

### Integrations

```
  Connect integrations
  ↑↓ move · Space toggle · Enter continue

  [ ] Google Workspace    Gmail, Sheets, Calendar
  [ ] Telegram            use nodyn from your phone
  [ ] Web Research        live research via Tavily
```

Use arrow keys to move, Space to toggle, Enter to confirm. All optional — skip with Enter or Esc. Credentials are collected only for selected integrations:

**Google Workspace** — needs OAuth 2.0 credentials from the [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Create an OAuth 2.0 Client ID (Desktop app type), paste Client ID + Secret. Run `/google auth` in the REPL to complete the OAuth flow. Default permissions are read-only.

**Telegram** — create a bot via [@BotFather](https://t.me/BotFather) → `/newbot` → paste the token. nodyn auto-detects your chat ID when you send a message to the bot. Add Telegram later via `TELEGRAM_BOT_TOKEN` env var.

**Web Research** — [Tavily](https://tavily.com) offers 1,000 free searches per month. Paste your API key to enable.

### Summary

```
  ✓ Setup complete

  API Key        ✓
  Encryption     ✓
  Google         ✓ /google auth
  Telegram       ✓
```

Only selected integrations are shown. If none were selected: `Add integrations anytime: /google, /telegram, /config`.

The wizard continues directly into the REPL — no need to restart or source any files. Encryption is active immediately.

### Business Profile (optional)

Right after setup, nodyn asks a few questions about your business:

```
── Business Profile ──────────────────────────────────────

NODYN works better when it knows your business.
Answer a few quick questions — or press Enter to skip any.

What does your business do?
  e.g., Digital marketing agency, 8 clients, Google Ads + SEO
  ›

What tools do you use daily?
  e.g., Google Ads, Sheets, Slack, Shopify
  ›

How do you typically report to clients?
  e.g., weekly PDF, monthly Google Doc
  ›

What's your biggest recurring time sink?
  e.g., Monday morning data pull, manual invoice generation
  ›
```

These answers are stored locally and help nodyn give more relevant suggestions from the start. All questions are optional — press Enter to skip any. Update later with `/profile update`.

## Persistence

After the setup wizard, everything persists automatically:

| What | Where | Survives restart? |
|------|-------|-------------------|
| API key + config | `~/.nodyn/config.json` | Yes (read on startup) |
| Vault key | `~/.nodyn/.env` | Yes (auto-loaded by CLI + Docker) |
| Run history | `~/.nodyn/history.db` | Yes (encrypted if vault key set) |
| Knowledge | `~/.nodyn/memory/` | Yes |
| Business profile | `~/.nodyn/memory/_global/facts.txt` | Yes |

**How the vault key survives restarts:**
1. **Same terminal session**: Set in `process.env` immediately by the wizard
2. **New terminal (local)**: The CLI auto-loads `~/.nodyn/.env` on startup — no manual `source` needed
3. **Shell profile**: If you accepted the shell profile injection, the key is also sourced by your shell on login
4. **Docker**: The entrypoint auto-loads `~/.nodyn/.env` before starting Node

If the vault key is missing but encrypted data exists, nodyn warns:
```
⚠ Encrypted vault found but NODYN_VAULT_KEY is not set. Run: nodyn init
```

## Configuration

nodyn works out of the box after the setup wizard. Customize further in `~/.nodyn/config.json`:

```json
{
  "enforce_https": true,
  "max_daily_cost_usd": 50
}
```

Or use `/config` in the REPL for an interactive settings pane. See [Configuration](/configuration/) for all options.

## Changeset Review

nodyn backs up files before modifying them. After each run with file changes:

```
Changeset Review (2 files modified, 1 file added)

  mod src/config.ts (+3 -1)
  mod src/index.ts (+12 -4)
  new src/utils.ts (+25 -0)

  [A]ccept all  [R]ollback all  [P]artial review
```

## Troubleshooting

### "Node.js 22+ required"

The prerequisites check catches this automatically. Install or update via [nodejs.org](https://nodejs.org), [nvm](https://github.com/nvm-sh/nvm), or your package manager. Docker users don't need Node.js locally.

### "Cannot reach api.anthropic.com"

This is a warning, not a blocker. The wizard accepts your API key but can't verify it live. Check your network/proxy settings. The key is validated on first actual use.

### API key rejected

- Key must start with `sk-ant-` and be at least 20 characters
- Make sure you copied the full key (no trailing spaces)
- Check that the key is active in [console.anthropic.com](https://console.anthropic.com/)

### Encryption in new shell sessions

The wizard offers to add `source ~/.nodyn/.env` to your shell profile. If you declined, add manually:

```bash
# ~/.zshrc or ~/.bashrc
[ -f "$HOME/.nodyn/.env" ] && . "$HOME/.nodyn/.env"
```

The current session always works — the wizard sets the vault key in the running process immediately.

### Docker: vault key persistence

The wizard saves the vault key to `~/.nodyn/.env` inside the container. If you mount `~/.nodyn/` as a volume (`-v ~/.nodyn:/home/nodyn/.nodyn`), it persists across container restarts. The entrypoint auto-loads `~/.nodyn/.env` on startup.

### Re-run the setup wizard

```bash
# Local
npx @nodyn-ai/core --init

# Docker
docker run -it --rm -v ~/.nodyn:/home/nodyn/.nodyn ghcr.io/nodyn-ai/nodyn:latest --init
```

This walks through all steps again. Existing config is overwritten.

### Telegram bot not responding

- Verify the token with `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Make sure `TELEGRAM_ALLOWED_CHAT_IDS` includes your chat ID
- Check that no other instance is running with the same token

## What's Next

- [CLI Reference](/cli/) — all slash commands and flags
- [Tools](/tools/) — available builtin tools
- [Configuration](/configuration/) — accuracy, thinking, cost settings
- [Knowledge](/memory/) — how nodyn remembers your business
- [Docker](/docker/) — container deployment and credentials guide
- [Telegram Bot](/telegram/) — hands-free mobile operation
- [MCP Server](/mcp-server/) — expose nodyn as a tool server
- [SDK](/sdk/) — use nodyn as a TypeScript library
- [Architecture](/architecture/) — understand the module structure
