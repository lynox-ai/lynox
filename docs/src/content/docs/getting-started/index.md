---
title: Getting Started
description: Install lynox and run your first session.
sidebar:
  order: 1
---

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Anthropic API Key** — [console.anthropic.com](https://console.anthropic.com/settings/keys)

Anthropic charges per usage — a typical business day costs **$1–5**. You can set spending limits in their console and in lynox.

## Install

### Option 1: npx (quickest)

```bash
npx @lynox-ai/core
```

Starts the setup wizard on first run, then opens the Web UI.

### Option 2: Docker (recommended for always-on)

```bash
docker run -d --name lynox -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:webui
```

Open [localhost:3000](http://localhost:3000). An **access token** is generated on first start — find it with `docker logs lynox`. You'll need it to log in.

:::tip[Custom access token]
Set your own token with `-e LYNOX_HTTP_SECRET=your-token` instead of using the auto-generated one.
:::

### Option 3: Install script

```bash
curl -fsSL https://lynox.ai/install.sh | sh
```

### Option 4: Clone & run

```bash
git clone https://github.com/lynox-ai/lynox.git
cd lynox
npm install
npm run dev
```

## Setup Wizard

On first run, the wizard guides you through:

1. **Prerequisites check** — Node.js version, directory permissions, network connectivity
2. **API Key** — Paste your Anthropic API key (starts with `sk-`). It's verified immediately.
3. **Encryption** — A vault key is generated automatically. The wizard offers to add it to your shell profile so it loads on every session.

Everything is saved to `~/.lynox/config.json`. The vault key goes into `~/.lynox/.env`.

## First Run

After setup, lynox opens the Web UI at [localhost:3000](http://localhost:3000). Try something:

- *"Summarize this PDF"* — drop a file into the chat
- *"What happened in my Gmail today?"* — after connecting Google Workspace
- *"Monitor example.com every day and alert me if something changes"*
- *"Create a weekly report template for my team"*

lynox remembers context across conversations. The more you use it, the more it learns about your business.

## Entry Modes

| Mode | Command | Use case |
|------|---------|----------|
| **Web UI** | `npx @lynox-ai/core` | Primary interface — chat, settings, integrations |
| **One-shot** | `npx @lynox-ai/core "your task"` | Run a single task from the terminal |
| **REPL** | `npx @lynox-ai/core --repl` | Interactive terminal session |
| **Docker** | `docker run ... ghcr.io/lynox-ai/lynox:webui` | Always-on with Web UI |

## HTTPS & Remote Access

When running lynox on a server, add HTTPS so the access token isn't transmitted in plaintext:

**Caddy** (automatic HTTPS):
```bash
caddy reverse-proxy --from yourdomain.com --to localhost:3000
```

**Cloudflare Tunnel** (no open ports needed):
```bash
cloudflared tunnel --url http://localhost:3000
```

## Troubleshooting

**Container won't start** — Check `docker logs lynox`. Most common cause: missing or invalid API key.

**"API key rejected"** — Must start with `sk-ant-` and be active in [console.anthropic.com](https://console.anthropic.com/).

**Can't access Web UI** — Check that port 3000 is open. On a VPS, you may need to allow it in your firewall.

**Lost access token** — Restart the container without `LYNOX_HTTP_SECRET` to generate a new one: `docker restart lynox && docker logs lynox`.

**Telegram bot not responding** — Check that no other instance uses the same bot token.

## Next Steps

- [Web UI Guide](/daily-use/web-ui/) — Learn the interface
- [Configuration](/daily-use/configuration/) — Customize model, cost limits, and more
- [Telegram](/integrations/telegram/) — Mobile access via Telegram bot
- [Google Workspace](/integrations/google-workspace/) — Connect Gmail, Calendar, Drive
- [Docker Deployment](/daily-use/docker/) — Production setup with Docker Compose
