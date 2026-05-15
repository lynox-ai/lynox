---
title: Getting Started
description: Install lynox and run your first session.
sidebar:
  order: 1
---

## Prerequisites

- **An LLM credential** for one of three providers:
  - [Claude (Anthropic)](https://console.anthropic.com/settings/keys) — recommended primary, direct API. Prompt caching makes cache-heavy workflows the cheapest option per token of real work.
  - [Mistral](https://console.mistral.ai/api-keys/) — France/EU, OpenAI-compatible adapter. Lower list prices than Claude; pick it for sovereignty or for uncached workloads where the lower per-token rate dominates.
  - **Custom (OpenAI-compatible)** — Ollama, LM Studio, OpenAI, Groq, vLLM, or any other OpenAI-compatible endpoint. Pick this for fully local inference. (LiteLLM as an Anthropic-compatible proxy is also supported via the separate `custom` provider — see [LLM Providers](/setup/llm-providers/).)

The installer walks you through provider selection and credential entry. Most users start with Anthropic — you can switch anytime in **Settings → Provider**. A typical business day on Claude costs **$1–5**; local-only setups cost nothing per call. See [LLM Providers](/setup/llm-providers/) for the per-provider matrix.

## Install

### npx installer (recommended)

```bash
npx @lynox-ai/core
```

The interactive installer checks prerequisites, asks for your AI provider and API key, generates `docker-compose.yml`, `.env`, and SearXNG config, then starts everything automatically. Your browser opens at [localhost:3000](http://localhost:3000) once the health check passes.

**Requires:** Node.js 22+, Docker + Docker Compose.

### Manual Docker Compose

If you prefer to set things up yourself:

```bash
# 1. Clone the repo (contains docker-compose.yml + SearXNG config)
git clone https://github.com/lynox-ai/lynox.git && cd lynox

# 2. Create .env with your API key
cp .env.example .env    # then edit .env and set ANTHROPIC_API_KEY

# 3. Start lynox + SearXNG (web search)
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and enter the access token from `docker logs lynox`.

:::tip[Access token]
If you omit `LYNOX_HTTP_SECRET` in your `.env`, one is auto-generated. On first start, find it with `docker logs lynox`. On subsequent starts, use `docker exec lynox cat /home/lynox/.lynox/.access-token`.
:::

## First Run

After setup, lynox opens at [localhost:3000](http://localhost:3000).

If you started without an API key (e.g. manual Docker Compose without `.env`), lynox starts in **browse mode** — you can explore the UI but not chat. A **setup banner** appears at the top with a provider-aware wizard (Anthropic / Mistral / Custom) where you enter your credentials. They're stored encrypted in the local vault.

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

**Wrong image** — Use `ghcr.io/lynox-ai/lynox:latest` — it includes both Engine and Web UI.

## Next Steps

- [Web UI Guide](/daily-use/web-ui/) — Learn the interface
- [Configuration](/daily-use/configuration/) — Model, cost limits, and more
- [Docker Deployment](/setup/docker/) — Production setup
- [LLM Providers](/setup/llm-providers/) — Anthropic, Mistral, OpenAI-compatible, or local models
- [Email (IMAP/SMTP)](/integrations/mail/) — Connect any email account for triage, search, and sending
- [Google Workspace](/integrations/google-workspace/) — Connect Gmail, Calendar, Drive
