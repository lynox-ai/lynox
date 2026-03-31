---
title: "Getting Started"
description: "One command. One API key. Open your browser."
sidebar:
  order: 1
---

## 1. Get an API Key

lynox needs an Anthropic API key to connect to the AI.

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account
2. Click **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-`)

Anthropic charges per usage — a typical business day costs **$1–5**. You can set a spending limit in their console.

---

## 2. Start lynox

### Self-hosted (recommended)

Run this on your server or local machine — Docker is all you need:

```bash
docker run -d --name lynox \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  --restart unless-stopped \
  ghcr.io/lynox-ai/lynox:webui
```

This starts the engine and Web UI in a single container. Your data is stored in `~/.lynox/` and persists across restarts and updates.

:::tip[Need a server?]
Any VPS with Docker works. [Hetzner](https://console.hetzner.cloud) (€3.79/mo), [DigitalOcean](https://m.do.co/c/29187cab6dc1) ($6/mo), or [Vultr](https://www.vultr.com/?ref=9887227-9J) ($5/mo) are good options. lynox needs ~300 MB RAM — the smallest plan is enough.
:::

### Alternative: npm (for developers)

If you prefer running without Docker:

```bash
npx @lynox-ai/core --init
```

This starts a setup wizard that configures your API key and encryption. After setup, `npx @lynox-ai/core` starts the Engine and opens the Web UI in your browser. Requires Node.js 22+.

---

## 3. Open Your Browser

Go to **http://localhost:3000** (or your server IP). The Web UI is ready.

Talk to lynox like you would to a colleague:

- *"Check my emails and tell me what's important"*
- *"Research [topic] and give me the key points"*
- *"What meetings do I have this week?"*
- *"Summarize this document"* (drag and drop a file)

:::note[Don't worry about automation yet]
Just use lynox for everyday tasks. After you've done something a few times, lynox will suggest turning it into an automated workflow.
:::

---

## Add Integrations

All optional. Add them whenever you're ready — via **Web UI → Settings → Integrations** or by passing environment variables to Docker.

| Integration | What it does | Docker env var |
|-------------|-------------|----------------|
| **Google Workspace** | Gmail, Sheets, Drive, Calendar, Docs | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Telegram** | Use lynox from your phone — voice, text, photos | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` |
| **Web Search** | Live web research ([Tavily](https://tavily.com), free: 1K/month) | `TAVILY_API_KEY` |
| **Any REST API** | Connect any service via the [API Store](/features/api-store/) | — (configured in Web UI) |

### Docker with integrations

```bash
docker run -d --name lynox \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e TELEGRAM_BOT_TOKEN=your-bot-token \
  -e TAVILY_API_KEY=tvly-... \
  -v ~/.lynox:/home/lynox/.lynox \
  --restart unless-stopped \
  ghcr.io/lynox-ai/lynox:webui
```

---

## What Happens Automatically

After setup, lynox takes care of itself:

| What | How |
|------|-----|
| **Updates** | Pull a new image anytime, or use [Watchtower](https://containrrr.dev/watchtower/) for daily auto-updates |
| **Encryption** | AES-256-GCM, key generated on first start |
| **Restarts** | `--restart unless-stopped` handles crashes and reboots |
| **Knowledge** | Grows with every conversation — fully automatic |
| **Backups** | Configurable in Web UI → Settings → Backups (Google Drive) |

---

## HTTPS & Remote Access

If you're running on a remote server, add HTTPS with one of these:

**Caddy** (automatic HTTPS):
```bash
# Install Caddy, then:
caddy reverse-proxy --from yourdomain.com --to localhost:3000
```

**Cloudflare Tunnel** (no open ports needed):
```bash
cloudflared tunnel --url http://localhost:3000
```

---

## Data & Portability

Everything lives in **one folder**: `~/.lynox/`. Move it to a new server, and lynox picks up where it left off — knowledge, config, history, everything.

---

## Troubleshooting

**Container won't start** — Check `docker logs lynox`. Most common: missing or invalid API key.

**"API key rejected"** — Must start with `sk-ant-`, be active in [console.anthropic.com](https://console.anthropic.com/).

**Can't access Web UI** — Check that port 3000 is open. On a VPS, you may need to allow it in your firewall.

**Telegram bot not responding** — Check that no other instance uses the same bot token.
