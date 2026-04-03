---
title: Getting Started
description: Install lynox and run your first session.
sidebar:
  order: 1
---

## Prerequisites

- **An Anthropic API Key** — [console.anthropic.com](https://console.anthropic.com/settings/keys)

Anthropic charges per usage — a typical business day costs **$1–5**. You can set spending limits in their console and in lynox.

:::tip[Other LLM providers]
lynox also supports **AWS Bedrock**, **Google Vertex AI**, and **Custom proxies** (e.g. LiteLLM). See [LLM Providers](/daily-use/llm-providers/) for details. Most users start with Anthropic — you can switch anytime.
:::

## Install

### Docker Compose (recommended)

```bash
# 1. Create project directory
mkdir lynox && cd lynox

# 2. Create .env with your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Start lynox + SearXNG (web search)
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and enter the access token from `docker logs lynox`.

This starts everything: Web UI, AI engine, and SearXNG for free unlimited web search.

:::tip[Access token]
If you omit `LYNOX_HTTP_SECRET` in your `.env`, one is auto-generated. Find it with `docker logs lynox`.
:::

### npx (quick try)

```bash
npx @lynox-ai/core
```

Starts the setup wizard on first run, then opens the Web UI.

## First Run

After setup, lynox opens at [localhost:3000](http://localhost:3000).

Try something:

- *"Summarize this PDF"* — drop a file into the chat
- *"Monitor example.com every day and alert me if something changes"*
- *"Create a weekly report template for my team"*

lynox remembers context across conversations. The more you use it, the more it learns about your business.

## Verify Your Setup

1. **Container running** — `docker ps` shows `lynox` with status `(healthy)`
2. **Web UI loads** — Open [localhost:3000](http://localhost:3000) and enter the token
3. **Status bar** — Bottom of the page shows green dots for "Engine" and "API"
4. **Send a message** — Type "Hello" and get an AI response

## Common Issues

:::danger[Missing volume mount]
Without `-v ~/.lynox:/home/lynox/.lynox`, your vault key and all data are lost on restart. The entrypoint warns if this is missing.
:::

**"API Key Invalid"** — Check your `ANTHROPIC_API_KEY` starts with `sk-ant-` and is active in [console.anthropic.com](https://console.anthropic.com/).

**Port 3000 in use** — Map to a different port: `docker run -p 8080:3000 ...`

**Wrong image** — Use `:webui` for the Web UI. `:latest` is engine-only (Telegram/MCP).

## Next Steps

- [Web UI Guide](/daily-use/web-ui/) — Learn the interface
- [Configuration](/daily-use/configuration/) — Model, cost limits, and more
- [Docker Deployment](/daily-use/docker/) — Production setup
- [LLM Providers](/daily-use/llm-providers/) — Bedrock, Vertex AI, or local models
- [Google Workspace](/integrations/google-workspace/) — Connect Gmail, Calendar, Drive
- [Telegram](/integrations/telegram/) — Mobile access via Telegram bot
