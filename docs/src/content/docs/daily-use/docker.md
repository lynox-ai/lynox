---
title: Docker Deployment
description: Run lynox with Docker for always-on operation.
sidebar:
  order: 3
---

Docker is the recommended way to run lynox in production. Two images are available:

| Image | Tag | Purpose |
|-------|-----|---------|
| Engine + Web UI | `ghcr.io/lynox-ai/lynox:webui` | Self-hosted with Web UI on port 3000 |
| Engine only | `ghcr.io/lynox-ai/lynox:latest` | Headless — for Telegram, MCP, or API-only use |

## Quick Start

```bash
docker run -d --name lynox -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:webui
```

Open [localhost:3000](http://localhost:3000). Find your access token with `docker logs lynox`.

## Docker Compose (recommended)

Create a `docker-compose.yml`:

```yaml
services:
  lynox:
    image: ghcr.io/lynox-ai/lynox:webui
    restart: unless-stopped
    read_only: true
    ports:
      - "3000:3000"
    tmpfs:
      - /tmp:size=512M
      - /workspace:size=256M,uid=1001,gid=1001
    security_opt:
      - no-new-privileges
    environment:
      - ANTHROPIC_API_KEY
      # Optional
      - LYNOX_HTTP_SECRET
      - LYNOX_VAULT_KEY
      - TELEGRAM_BOT_TOKEN
      - TELEGRAM_ALLOWED_CHAT_IDS
      - TAVILY_API_KEY
      - GOOGLE_CLIENT_ID
      - GOOGLE_CLIENT_SECRET
    volumes:
      - ${HOME}/.lynox:/home/lynox/.lynox
```

Then run:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d
```

## Environment Variables

`ANTHROPIC_API_KEY` is needed for AI responses. Without it, the container still starts in browse mode (you can view data but not chat). Everything else is optional:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Recommended | Anthropic API key (browse mode without it) |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint (for proxies) |
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
| `TAVILY_API_KEY` | No | Web search via Tavily |
| `BRAVE_API_KEY` | No | Web search via Brave |
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

Keep lynox updated with [Watchtower](https://containrrr.dev/watchtower/):

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
