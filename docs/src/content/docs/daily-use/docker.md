---
title: Docker Deployment
description: Run lynox with Docker for always-on operation.
sidebar:
  order: 4
---

Docker is the recommended way to run lynox in production. Two images are available:

| Image | Tag | Purpose |
|-------|-----|---------|
| Engine + Web UI | `ghcr.io/lynox-ai/lynox:webui` | Self-hosted with Web UI on port 3000 |
| Engine only | `ghcr.io/lynox-ai/lynox:latest` | Headless — for Telegram, MCP, or API-only use |

## Quick Start

```bash
cp .env.example .env       # add your API key
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and enter the access token from `docker logs lynox`. Includes SearXNG for free web search out of the box.

The repo includes a `docker-compose.yml` with lynox + SearXNG pre-configured. Edit `.env` to set your API key and optional features (Telegram, Google Workspace, etc.).

## Single Container (advanced)

:::caution
The single-container mode does not include SearXNG web search. Use `docker compose` for the full setup.
:::

If you don't need docker-compose (e.g. orchestrated via Kubernetes or Coolify), you can run lynox standalone:

```bash
docker run -d --name lynox -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LYNOX_HTTP_SECRET=your-access-token \
  -v ~/.lynox:/home/lynox/.lynox \
  --restart unless-stopped \
  ghcr.io/lynox-ai/lynox:webui
```

:::note
Without docker-compose, SearXNG is not included. Add `SEARXNG_URL` pointing to your own instance, or use a `TAVILY_API_KEY` for web search.
:::

## Environment Variables

`ANTHROPIC_API_KEY` is needed for the default Anthropic provider. For alternative providers (Bedrock, Vertex, Custom), see [LLM Providers](/daily-use/llm-providers/). Without any LLM configuration, the container starts in browse mode (you can view data but not chat).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Recommended | Anthropic API key (browse mode without it) |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint (for LiteLLM/proxies) |
| `LYNOX_LLM_PROVIDER` | No | `anthropic` (default), `bedrock`, `vertex`, `custom` |
| `AWS_REGION` | Bedrock only | AWS region (e.g. `eu-central-1`) |
| `AWS_ACCESS_KEY_ID` | Bedrock only | AWS IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Bedrock only | AWS IAM secret key |
| `GCP_REGION` | Vertex only | GCP region (e.g. `europe-west1`) |
| `GCP_PROJECT_ID` | Vertex only | GCP project ID |
| `LYNOX_VAULT_KEY` | Recommended | Encryption key for secrets at rest |
| `LYNOX_HTTP_SECRET` | Auto-generated | Web UI access token (login password) |
| `LYNOX_MCP_SECRET` | Production | MCP HTTP bearer token |
| `LYNOX_MCP_PORT` | No | MCP port (default: 3042) |
| `LYNOX_HTTP_PORT` | No | Engine HTTP API port (default: 3100) |
| `LYNOX_WORKSPACE` | No | Workspace root (default: /workspace) |
| `LYNOX_EMBEDDING_PROVIDER` | No | `onnx` / `voyage` / `local` |
| `TELEGRAM_BOT_TOKEN` | No | Enable Telegram bot |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Recommended | Restrict bot access to specific chats |
| `GOOGLE_CLIENT_ID` | No | Google Workspace OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google Workspace OAuth |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | Google service account (headless) |
| `SEARXNG_URL` | No | Web search via SearXNG (self-hosted, included in docker-compose) |
| `TAVILY_API_KEY` | No | Web search via Tavily (alternative) |
| `LYNOX_SENTRY_DSN` | No | Error reporting (opt-in) |

## Persistent Data

Mount `~/.lynox` to keep your data across container restarts:

```bash
-v ~/.lynox:/home/lynox/.lynox
```

This directory contains:
- `config.json` — Your configuration
- `agent-memory.db` — Memory and knowledge graph
- `threads/` — Conversation history
- `vault.db` — Encrypted secrets
- `backups/` — Automatic backups

## Security Hardening

The Docker Compose example above includes production-ready hardening:

- **`read_only: true`** — Read-only root filesystem
- **`no-new-privileges`** — Prevents privilege escalation
- **`tmpfs`** — Temporary storage in memory, not on disk
- **Non-root user** — Runs as `lynox` (UID 1001), not root

## Automatic Updates

Keep lynox updated with [Watchtower](https://containrrr.dev/watchtower/). Add it to your `docker-compose.yml`:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --cleanup --interval 86400 lynox searxng
```

Or run it standalone:

```bash
docker run -d \
  --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --cleanup --interval 86400 \
  lynox
```

Checks for new images once per day. Your data is on a volume, so updates are safe and seamless.

## Health Check

The container exposes a health endpoint:

```bash
curl http://localhost:3000/api/engine/health
# {"status":"ok"}
```

## Engine-Only Mode

For headless setups (Telegram bot, MCP server, or API-only):

```bash
docker run -d --name lynox \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e TELEGRAM_BOT_TOKEN=123:ABC... \
  -e TELEGRAM_ALLOWED_CHAT_IDS=12345678 \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

No port mapping needed — Telegram connects outbound.

## MCP Server Mode

To use lynox as an MCP server (for Claude Desktop, Cursor, etc.):

```bash
docker run -i --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest --mcp
```

See [MCP Integration](/integrations/mcp/) for IDE setup.

## Data & Portability

Everything lives in **one folder**: `~/.lynox/`. Copy it to a new server, and lynox picks up where it left off — knowledge, config, history, everything.
