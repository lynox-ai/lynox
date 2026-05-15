---
title: Docker Deployment
description: Run lynox with Docker for always-on operation.
sidebar:
  order: 2
---

Docker is the recommended way to run lynox in production.

| Image | Purpose |
|-------|---------|
| `ghcr.io/lynox-ai/lynox:latest` | Engine + Web UI on port 3000 (also tagged with version, e.g. `:1.4.1`) |

## Quick Start

```bash
cp .env.example .env       # add your API key
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and log in with the access token shown in `docker logs lynox`. Sessions last 30 days. Includes SearXNG for free web search out of the box.

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
  ghcr.io/lynox-ai/lynox:latest
```

:::note
Without docker-compose, SearXNG is not included. Add `SEARXNG_URL` pointing to your own SearXNG instance for web search.
:::

## Environment Variables

`ANTHROPIC_API_KEY` is needed for the default Anthropic provider. For Mistral or a **Custom (OpenAI-compatible)** endpoint (Ollama, LM Studio, OpenAI, Groq, vLLM, …), see [LLM Providers](/setup/llm-providers/). Without any LLM configuration, the container starts in browse mode (you can view data but not chat).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Recommended | Anthropic API key. Also reused as the generic bearer for `provider: openai` (Mistral / custom endpoint) — name kept generic. |
| `ANTHROPIC_BASE_URL` | No | Endpoint for `provider: openai` or `custom` (e.g. `https://api.mistral.ai/v1`) |
| `LYNOX_LLM_PROVIDER` | No | `anthropic` (default), `openai`, `custom` (Anthropic-compat proxy), `vertex` (legacy, see below) |
| `OPENAI_MODEL_ID` | OpenAI only | Model ID (e.g. `mistral-large-latest`, `llama3.2`, `gpt-4o`) |
| `LYNOX_VAULT_KEY` | Recommended | Encryption key for secrets at rest |
| `LYNOX_HTTP_SECRET` | Auto-generated | Web UI access token (login password) |
| `LYNOX_MCP_SECRET` | Production | MCP HTTP bearer token |
| `LYNOX_MCP_PORT` | No | MCP port (default: 3042) |
| `LYNOX_HTTP_PORT` | No | Engine HTTP API port (default: 3000 in Docker, 3100 locally) |
| `LYNOX_WORKSPACE` | No | Workspace root (default: /workspace) |
| `LYNOX_EMBEDDING_PROVIDER` | No | `onnx` (default) |
| `GOOGLE_CLIENT_ID` | No | Google Workspace OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google Workspace OAuth |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | Google service account (headless) |
| `SEARXNG_URL` | No | Web search via SearXNG (included in docker-compose) |
| `LYNOX_BUGSINK_DSN` | No | Error reporting (opt-in) |
| `LYNOX_LANGUAGE` | No | Force response language (e.g. `de`, `en`) |
| `LYNOX_TRUST_PROXY` | No | Trust X-Forwarded-For headers (set behind reverse proxy) |
| `LYNOX_ALLOWED_ORIGINS` | No | CORS allowed origins (comma-separated) |
| `LYNOX_ALLOWED_IPS` | No | Restrict access to specific IPs (comma-separated) |
| `LYNOX_TLS_CERT` | No | Path to TLS certificate (enables HTTPS) |
| `LYNOX_TLS_KEY` | No | Path to TLS private key |

### Legacy: Vertex AI

`provider: vertex` is no longer offered by the installer or in-product wizard but stays wired in the engine for existing self-hosters whose `config.json` still points at Vertex. New installs should use Anthropic direct or `provider: openai` instead.

| Variable | Required | Purpose |
|----------|----------|---------|
| `GCP_PROJECT_ID` | Vertex only | GCP project ID |
| `CLOUD_ML_REGION` | Vertex only | Vertex region, e.g. `europe-west4`, `us-east5` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex only | Path to GCP service-account JSON |

## Persistent Data

Mount `~/.lynox` to keep your data across container restarts:

```bash
-v ~/.lynox:/home/lynox/.lynox
```

This directory contains:
- `config.json` — Your configuration
- `.env` — Vault encryption key (`LYNOX_VAULT_KEY`) — keep safe!
- `.access-token` — Auto-generated Web UI login token
- `vault.db` — Encrypted secrets
- `history.db` — Threads, runs, and conversation history
- `agent-memory.db` — Knowledge graph and embeddings
- `datastore.db` — CRM contacts, deals, and DataStore collections
- `memory/` — Flat-file memory
- `sessions/` — Active session state
- `backups/` — Automatic backups

## Security Hardening

The Docker Compose file includes production-ready hardening:

- **`read_only: true`** — Read-only root filesystem
- **`cap_drop: ALL`** — All Linux capabilities dropped
- **`no-new-privileges`** — Prevents privilege escalation
- **`pids_limit: 512`** — Prevents fork bombs
- **`tmpfs`** — Temporary storage in memory, not on disk
- **Non-root user** — Runs as `lynox` (UID 1001), not root
- **Log rotation** — `max-size: 20m` prevents disk filling
- **Network isolation** — Internal Docker network between services

The Docker image goes further: no shell (`bash` removed), no package manager (`apt` removed), no SUID binaries. See [Security](/features/security/) for what you need to handle yourself (TLS, firewall, backups).

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
curl http://localhost:3000/api/health
# {"status":"ok","version":"1.4.1","uptime_s":...}
```

Both `/health` and `/api/health` work — `/health` is a thin alias for proxies that only allow root-level health checks.

## Engine-Only Mode

For headless setups (MCP server, or API-only):

```bash
docker run -d --name lynox \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

## MCP Server Mode

To use lynox as an MCP server (for Claude Desktop, Cursor, etc.):

```bash
docker run -i --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest --mcp-server
```

See [MCP Integration](/integrations/mcp/) for IDE setup.

## Migrating from Local to Docker

If you've been running lynox locally (via `npx` or `pnpm`), you can move to Docker without losing any data. Everything lives in `~/.lynox/` — just mount it:

```bash
# Your local data is already in ~/.lynox/
# Docker Compose mounts it automatically (see docker-compose.yml)
docker compose up -d
```

All your threads, memory, knowledge graph, config, and vault secrets carry over. The only difference: Docker Compose adds SearXNG for web search (locally, Anthropic's native `web_search` was used instead).

:::tip
Your vault key (stored as `LYNOX_VAULT_KEY` in `~/.lynox/.env`) must be present on the Docker host. Without it, encrypted secrets can't be decrypted — but you can re-enter them via the Web UI.
:::

## Data & Portability

Everything lives in **one folder**: `~/.lynox/`. Copy it to a new server, and lynox picks up where it left off — knowledge, config, history, everything.
