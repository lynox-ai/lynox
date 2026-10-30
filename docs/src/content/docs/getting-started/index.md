---
title: Getting Started
description: Install lynox and run your first session.
sidebar:
  order: 1
---

## Prerequisites

- **An LLM credential** for one of the two natively-supported providers:
  - [Claude (Anthropic)](https://console.anthropic.com/settings/keys) — recommended primary, direct API. Prompt caching makes cache-heavy workflows the cheapest option per token of real work. Tested on every release.
  - [Mistral](https://console.mistral.ai/api-keys/) — France/EU, OpenAI-compatible adapter pinned to `api.mistral.ai`. Lower list prices than Claude; pick it for sovereignty or for uncached workloads where the lower per-token rate dominates. Tested on every release.

  Other endpoints — OpenAI itself, Ollama, LM Studio, Groq, vLLM, Gemini, the Anthropic-compatible "custom" proxy path (e.g. a LiteLLM proxy exposing the Anthropic Messages route), and Google Vertex AI (not usable in the Docker image) — are **wired but not regularly tested**. They work in principle and you can configure them via `~/.lynox/config.json` or environment variables, but expect rough edges around tool-calling reliability. See [LLM Providers](/setup/llm-providers/).

The installer walks you through provider selection and credential entry. Most users start with Anthropic — you can switch anytime in **Settings → Config**.

## Install

### npx installer (recommended)

```bash
npx @lynox-ai/core
```

The interactive installer checks prerequisites, asks for your AI provider and API key, generates `docker-compose.yml`, `.env`, and SearXNG config, then starts everything automatically. Your browser opens at [localhost:3000](http://localhost:3000) once the health check passes.

**Requires:** Node.js 22+, Docker + Docker Compose.

### Without a terminal (scripts, CI, coding assistants)

```bash
ANTHROPIC_API_KEY=... npx @lynox-ai/core --non-interactive --accept-terms --provider anthropic
```

`--non-interactive` asks nothing. Every answer comes from a flag or the environment:

- `--accept-terms` accepts the terms of service. Without it the run stops, even if the terms were accepted on this machine before.
- An argument the installer does not know stops the run, so a misspelt flag never turns into a default.
- `--provider anthropic|mistral|openai-compatible|none` picks the AI provider. The key comes from `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY` or `OPENAI_API_KEY`, never from a flag. `none` starts lynox without a key; add one later in the Web UI.
- `--model <id>` is for `mistral` and `openai-compatible`, `--base-url <url>` for `openai-compatible`. `--dir <path>` sets the install directory (default `./lynox`). An existing setup there stops the run unless you pass `--reconfigure`.
- `LYNOX_HTTP_SECRET` sets the access token; blank means one is generated. `PORT` sets the host port, 1–65535; anything else falls back to 3000. A port in use stops the run.

The run exits `0` only once `GET /api/health` answers. A health check that times out, or any refusal, exits `1`. A missing `--provider`, a flag without its value, or an installer flag used without `--non-interactive` exits `2` and prints the usage. The access token and vault key are not printed: they are `LYNOX_HTTP_SECRET` and `LYNOX_VAULT_KEY` in `<dir>/.env`. No browser opens.

### Manual Docker Compose

If you prefer to set things up yourself:

```bash
# 1. Clone the repo (contains docker-compose.yml + SearXNG config)
git clone https://github.com/lynox-ai/lynox.git && cd lynox

# 2. Copy .env.example and UNCOMMENT + set your AI provider key
#    (.env.example ships with ANTHROPIC_API_KEY commented out so the file
#    can stay in the repo; you must remove the leading `#` and paste the
#    key before starting the container).
cp .env.example .env
# then: edit .env, uncomment the `ANTHROPIC_API_KEY=` line, paste your key

# 3. Required before the first start: create the data folder, and let the
#    container write it (the second line does what your Docker mode needs;
#    never set LYNOX_UID to 0; Docker Desktop: keep the mkdir, skip the
#    second line)
mkdir -p ~/.lynox
if docker info -f '{{.SecurityOptions}}' | grep -q rootless; then docker run --rm --network none --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH -v ~/.lynox:/d alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc chown -R 1001:1001 /d; elif [ "$(id -u)" = 0 ]; then chown -R -P 1001:1001 ~/.lynox; else printf 'LYNOX_UID=%s\nLYNOX_GID=%s\n' "$(id -u)" "$(id -g)" >> .env; fi

# 4. Start lynox + SearXNG (web search)
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and enter the access token.

:::tip[Access token]
If you omit `LYNOX_HTTP_SECRET` in your `.env`, one is auto-generated on first start. The log shows only its first 8 characters (`docker compose logs lynox`), and later starts do not log it at all. To read the full token, run this in the directory with `docker-compose.yml`: `docker compose exec lynox cat /home/lynox/.lynox/.access-token`.
:::

## First Run

After setup, lynox opens at [localhost:3000](http://localhost:3000).

If you started without an API key (e.g. manual Docker Compose without `.env`), lynox starts in a limited state — the chat input is disabled until setup is complete. A **setup banner** appears at the top with a provider-aware wizard (Anthropic / Mistral / Custom) where you enter your credentials. They're stored encrypted in the local vault.

Try something:

- *"Summarize this PDF"* — drop a file into the chat
- *"Monitor example.com every day and alert me if something changes"*
- *"Create a weekly report template for my team"*

lynox remembers context across conversations. The more you use it, the more it learns about your business.

## Verify Your Setup

1. **Container running** — `docker ps` shows `lynox` with status `(healthy)`
2. **Web UI loads** — Open [localhost:3000](http://localhost:3000) and enter the token
3. **Status bar** — The bar at the bottom shows the active provider and API health (e.g. `Anthropic · API OK`), today's cost (e.g. `$0.04`), and today's run count. Click the cost pill to open the Activity Hub at `/app/activity`.
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
