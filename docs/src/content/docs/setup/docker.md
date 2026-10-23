---
title: Docker Deployment
description: Run lynox with Docker for always-on operation.
sidebar:
  order: 2
---

Docker is the recommended way to run lynox in production.

| Image | Purpose |
|-------|---------|
| `ghcr.io/lynox-ai/lynox:latest` | Engine + Web UI on port 3000 (also tagged with the release version, e.g. `:2.9.1` — no `v` prefix) |

The image is published as a multi-arch manifest (`linux/amd64` + `linux/arm64`), so Apple Silicon and ARM servers can pull natively. The bundled `docker-compose.yml` pins `platform: linux/amd64` as a conservative default — remove that line in the compose service if you want native arm64 on Apple Silicon.

## Quick Start

```bash
cp .env.example .env       # add your API key
mkdir -p ~/.lynox          # required before the first start
if docker info -f '{{.SecurityOptions}}' | grep -q rootless; then printf 'LYNOX_UID=0\nLYNOX_GID=0\n' >> .env; else printf 'LYNOX_UID=%s\nLYNOX_GID=%s\n' "$(id -u)" "$(id -g)" >> .env; fi
docker compose up -d
```

Open [localhost:3000](http://localhost:3000) and log in with the access token. On the first start the log shows its first 8 characters (`docker compose logs lynox`); the full token is `docker compose exec lynox cat /home/lynox/.lynox/.access-token`. With a single container, use `docker exec <name>` instead. Sessions last 30 days. Includes SearXNG for free web search out of the box.

The repo includes a `docker-compose.yml` with lynox + SearXNG pre-configured. Edit `.env` to set your API key and optional features (Mail, Google Workspace, etc.).

**The `mkdir` and `LYNOX_UID` lines are required steps, not tips.** lynox keeps its data in `~/.lynox` on the host and has to run as the owner of that folder:

- The `mkdir` comes first. Without the folder, `docker compose up` stops with "bind source path does not exist", rather than letting Docker create the folder owned by root.
- The `LYNOX_UID` line picks the value for your Docker mode. On rootless Docker that is `0`: root inside a rootless container is your own user. On rootful Docker it is your own uid. **Never set `0` on rootful Docker.** If `id -u` prints `0` there, leave both values out and run `chown 1001:1001 ~/.lynox`.
- Nothing on this path checks these values; only the `npx @lynox-ai/core` installer does.
- On rootful Docker the container runs as your user. A process that broke out of it could reach whatever your user can reach, so rootless Docker is the narrower choice.
- On Docker Desktop (macOS, Windows), keep the `mkdir` and skip the `LYNOX_UID` line.

## Single Container (advanced)

:::caution
The single-container mode does not include SearXNG web search. Use `docker compose` for the full setup.
:::

If you don't need docker-compose (e.g. orchestrated via Kubernetes or Coolify), you can run lynox standalone:

```bash
mkdir -p ~/.lynox
if docker info -f '{{.SecurityOptions}}' | grep -q rootless; then LYNOX_UID=0 LYNOX_GID=0; else LYNOX_UID=$(id -u) LYNOX_GID=$(id -g); fi
docker run -d --name lynox -p 3000:3000 \
  --user "$LYNOX_UID:$LYNOX_GID" -e HOME=/home/lynox \
  --tmpfs "/home/lynox/.cache:uid=$LYNOX_UID,gid=$LYNOX_GID" \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LYNOX_HTTP_SECRET=your-access-token \
  -v ~/.lynox:/home/lynox/.lynox \
  --restart unless-stopped \
  ghcr.io/lynox-ai/lynox:latest
```

The first two lines are the same steps as in the Quick Start: the container has to run as the owner of `~/.lynox`. The same rule applies: never `0` on rootful Docker. On Docker Desktop, drop `--user`, `-e HOME` and `--tmpfs`.

:::note
Without docker-compose, SearXNG is not included. Add `SEARXNG_URL` pointing to your own SearXNG instance for web search.
:::

## Environment Variables

`ANTHROPIC_API_KEY` is needed for the default Anthropic provider. For Mistral (the other natively-supported path), see [LLM Providers](/setup/llm-providers/). Other OpenAI-compatible endpoints (Ollama, LM Studio, OpenAI itself, Groq, vLLM, …) are wired but **not regularly tested**. Without any LLM configuration, the container starts in a limited state — the chat input is disabled until you complete setup via the in-product wizard.

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Recommended | Anthropic API key. Anthropic-only — does NOT serve `provider: openai`. |
| `MISTRAL_API_KEY` | Mistral only | Mistral API key (canonical primary slot for `provider: openai` with Mistral endpoint). |
| `OPENAI_API_KEY` | Other openai-compat only | Bearer for generic OpenAI-compatible endpoints (experimental). Secondary slot — `MISTRAL_API_KEY` is also accepted. |
| `ANTHROPIC_BASE_URL` | No | Base URL for `provider: openai` or `custom` (e.g. `https://api.mistral.ai/v1`) |
| `LYNOX_LLM_PROVIDER` | No | `anthropic` (default), `openai`, `custom` (Anthropic-compat proxy — experimental), `vertex` (legacy, see below — experimental) |
| `OPENAI_MODEL_ID` | OpenAI only | Model ID (e.g. `mistral-medium-2604`, `llama3.2`, `gpt-4o`) — prefer pinned over `-latest` to avoid silent snapshot rolls |
| `LYNOX_VAULT_KEY` | Recommended | Encryption key for secrets at rest |
| `LYNOX_HTTP_SECRET` | Auto-generated | Web UI access token (login password) |
| `LYNOX_HTTP_PORT` | No | Engine HTTP API port (default: 3000 in Docker, 3100 locally) |
| `LYNOX_WORKSPACE` | No | CLI only: an existing directory that bash starts in and that the file tools are limited to (besides `/tmp` and the artifacts directory; reads also from `/app`). A path that does not exist is ignored. Unset, the CLI's file writes go to the workspace root. The server ignores it and uses `<workspace root>/http-api`. |
| `LYNOX_WORKSPACE_ROOT` | No | Directory that holds the workspaces (default: `<data dir>/workspace`, i.e. `/home/lynox/.lynox/workspace` in the image). Another directory must be one of its own: the engine refuses a root whose path is the data directory, contains it, or lies inside it. If bind mounts make the two overlap anyway, the data erasure refuses either way, and backup and export refuse when the data directory ends up inside the root. Backup, export and the data erasure reach the workspaces there. |
| `LYNOX_EMBEDDING_PROVIDER` | No | `onnx` (default) |
| `GOOGLE_CLIENT_ID` | No | Google Workspace OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google Workspace OAuth |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | Google service account (headless) |
| `SEARXNG_URL` | No | Web search via SearXNG (included in docker-compose) |
| `LYNOX_BUGSINK_DSN` | No | Error reporting (opt-in) |
| `LYNOX_LANGUAGE` | No | Force response language (e.g. `de`, `en`) |
| `LYNOX_TRUST_PROXY` | No | Trust X-Forwarded-For headers (set behind reverse proxy) |
| `LYNOX_TRUSTED_PROXY_HOPS` | No | Trailing X-Forwarded-For hops appended by trusted proxies (default `1`) |
| `LYNOX_ALLOWED_ORIGINS` | No | CORS allowed origins (comma-separated) |
| `LYNOX_ALLOWED_IPS` | No | Restrict access to specific IPs (comma-separated) |
| `LYNOX_TLS_CERT` | No | Path to TLS certificate (enables HTTPS) |
| `LYNOX_TLS_KEY` | No | Path to TLS private key |

### Legacy: Vertex AI

`provider: vertex` is no longer offered by the installer or in-product wizard, and **it does not work in the Docker image**: Vertex needs the optional package `@anthropic-ai/vertex-sdk`, which the image does not include, so a `config.json` that still points at Vertex fails when the engine starts. Use Anthropic direct or `provider: openai` (Mistral) instead.

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

The container has to run as the folder's owner (see the Quick Start). If it restarts in a loop and the log says `/home/lynox/.lynox is not writable`, it is running as someone else. Stop it and do one of the following:

- Set `LYNOX_UID`/`LYNOX_GID` (or `--user`) as shown above.
- For data that an older setup wrote as uid 1001, leave them unset and keep running as 1001.

This directory contains:
- `config.json` — Your configuration
- `.env` — Vault encryption key (`LYNOX_VAULT_KEY`) — keep safe!
- `.access-token` — Auto-generated Web UI login token
- `vault.db` — Encrypted secrets
- `history.db` — Threads, runs, and conversation history
- `agent-memory.db` — Knowledge graph and embeddings
- `datastore.db` — CRM contacts, deals, and DataStore collections
- `engine.db` — Subject-graph store (flag-gated, off by default)
- `mail-state.db` — Inbox and mail state
- `push-subscriptions.db` — Web-push subscriptions
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
- **Not root on the host** — on rootful Docker the container runs as your own user (`LYNOX_UID`), or as the image's user `lynox` (UID 1001) when that is unset, and never as root. On rootless Docker it runs as root inside the container, which is your own user on the host.
- **Log rotation** — `max-size: 20m` prevents disk filling
- **No published side services** — SearXNG publishes no host port, so nothing off the machine can reach it. On a Linux host, processes on the host itself and containers you attach to the same Compose network still can. This is not an egress boundary: outbound traffic from the containers is unrestricted at the network layer.

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
# {"status":"ok","version":"…","uptime_s":…}
```

Both `/health` and `/api/health` work — `/health` is a thin alias for proxies that only allow root-level health checks.

`status` reads `"degraded"` (HTTP stays 200) when the engine started without `engine.db` or `history.db`; no other database is part of this check. The container log says which one and why, in a line starting with `[lynox] EngineDb init failed` or `[lynox] RunHistory init failed`.

## Engine-Only Mode

For headless / API-only setups:

```bash
mkdir -p ~/.lynox
if docker info -f '{{.SecurityOptions}}' | grep -q rootless; then LYNOX_UID=0 LYNOX_GID=0; else LYNOX_UID=$(id -u) LYNOX_GID=$(id -g); fi
docker run -d --name lynox \
  --user "$LYNOX_UID:$LYNOX_GID" -e HOME=/home/lynox \
  --tmpfs "/home/lynox/.cache:uid=$LYNOX_UID,gid=$LYNOX_GID" \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

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
