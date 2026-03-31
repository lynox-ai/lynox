---
title: "Docker Deployment"
description: "Container setup, production hardening, and volumes"
sidebar:
  order: 3
---

:::tip[Don't want to set up Docker manually?]
Use the **[deploy page](https://lynox.ai/deploy)** — enter your API key, choose "New cloud server" or "I already have a server", and get everything generated in your browser. The self-hosted path gives you a downloadable `.env` file, `docker run` command, and `docker-compose.yml`. Auto-updates included.
:::

## Quick Start

Get an API key at [console.anthropic.com](https://console.anthropic.com/), then:

### Docker Compose (recommended)

The repo includes a [`docker-compose.yml`](../docker-compose.yml) with production-ready defaults (read-only root, tmpfs, no-new-privileges):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

Enable features by uncommenting environment variables in `docker-compose.yml`. That's it.

### docker run

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

Type your task, press Enter.

### Shell alias (optional)

```bash
alias lynox='docker run -it --rm -e ANTHROPIC_API_KEY -v ~/.lynox:/home/lynox/.lynox ghcr.io/lynox-ai/lynox:latest'

lynox "What can you do?"
```

---

## Add Features

All features are enabled by adding environment variables. Add any of these `-e` flags to your `docker run` command.

### Telegram Bot

Use lynox from your phone. Create a bot via [@BotFather](https://t.me/BotFather) → `/newbot` → copy token.

```bash
docker run -d \
  -e ANTHROPIC_API_KEY \
  -e TELEGRAM_BOT_TOKEN=123456789:ABCdef... \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

Restrict to your chat (recommended): message your bot, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, find your `chat.id`:

```bash
-e TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

### Encryption

Encrypt secrets, run history, and OAuth tokens at rest:

```bash
-e LYNOX_VAULT_KEY=$(openssl rand -base64 48)
```

Save this key in a password manager. If lost, encrypted data becomes unrecoverable.

### Web Search

```bash
# Tavily (free: 1K/month) — https://tavily.com/
-e TAVILY_API_KEY=tvly-...

# OR Brave Search — https://brave.com/search/api/
-e BRAVE_API_KEY=BSA...
```

:::tip[Privacy]
For Tavily: disable "Allow use of query data" in your [Tavily dashboard](https://tavily.com) to prevent your searches from being used to improve their services.
:::

### Google Workspace

Gmail, Sheets, Drive, Calendar, Docs. Create OAuth credentials at [GCP Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → OAuth 2.0 Client ID (Desktop).

```bash
-e GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com \
-e GOOGLE_CLIENT_SECRET=GOCSPX-...
```

### Error Reporting (Sentry)

Opt-in crash and error reporting to a Sentry instance (EU region recommended):

```bash
-e LYNOX_SENTRY_DSN=https://...@....ingest.de.sentry.io/...
```

PII is scrubbed automatically. No DSN is hardcoded — if absent, Sentry is completely disabled.

### MCP Server

Expose lynox as a tool server for Claude Desktop, Cursor, or other MCP clients.

```bash
# stdio (for Claude Desktop, Cursor)
docker run -i --rm -e ANTHROPIC_API_KEY ghcr.io/lynox-ai/lynox:latest --mcp-server

# HTTP (for web apps, Slack)
docker run -d \
  -e ANTHROPIC_API_KEY \
  -e LYNOX_MCP_SECRET=$(openssl rand -hex 32) \
  -p 127.0.0.1:3042:3042 \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest --mcp-server --transport sse
```

---

## One Image, All Modes

The `ghcr.io/lynox-ai/lynox` image contains everything — CLI, Telegram bot, MCP server, voice transcription, embeddings. There are no separate images to choose from. The mode is determined by environment variables and flags:

| What you set | What runs |
|--------------|-----------|
| *(nothing)* | Engine HTTP API + opens Web UI |
| `--repl` | Interactive CLI REPL |
| `TELEGRAM_BOT_TOKEN` | Telegram bot (auto-starts alongside CLI) |
| `--mcp-server` | MCP server (stdio or HTTP) |
| All of the above | All modes run in the same container |

This keeps things simple: one image to pull, one image to update. The [docker-compose.yml](../docker-compose.yml) in the repo root is all you need — enable features by setting environment variables.

---

## Remote Access

When lynox runs on a server, there are several ways to interact with it:

| Channel | Best for | Setup |
|---------|----------|-------|
| **Web UI** | Primary interface for everyone | Use `Dockerfile.web-ui`, port 3000 |
| **Telegram** | Mobile / on-the-go tasks | Add bot token in Web UI → Settings → Integrations |
| **MCP HTTP** | External integrations (IDE) | Add `LYNOX_MCP_SECRET`, expose port 3042 |
| **SSH + CLI** | Admin/debugging | `docker exec -it lynox node /app/dist/index.js` |

**Web UI** is the primary interface — chat, settings, integrations, run history, knowledge browser. Use `Dockerfile.web-ui` for the combined Engine + Web UI image:

```bash
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/lynox-ai/lynox:webui
```

**Telegram** is a secondary channel for mobile use. Configure it in Web UI → Settings → Integrations.

---

## Production Deployment

For always-on deployments (server, VPS, homelab):

```bash
docker run -d \
  --name lynox \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=512M \
  --tmpfs /workspace:size=256M,uid=1001,gid=1001 \
  --security-opt no-new-privileges \
  --memory 2g \
  --cpus 2.0 \
  -e ANTHROPIC_API_KEY \
  -e LYNOX_VAULT_KEY \
  -e LYNOX_MCP_SECRET \
  -e TELEGRAM_BOT_TOKEN \
  -e TELEGRAM_ALLOWED_CHAT_IDS \
  -v ~/.lynox:/home/lynox/.lynox \
  ghcr.io/lynox-ai/lynox:latest
```

| Flag | Why |
|------|-----|
| `--read-only` | Container filesystem can't be modified |
| `--tmpfs /tmp:size=512M` | Temp files in memory only, capped |
| `--tmpfs /workspace:size=256M` | Agent workspace (read-only root needs tmpfs) |
| `--no-new-privileges` | Prevents privilege escalation |
| `--memory 2g` / `--cpus 2.0` | Resource limits |
| `--restart unless-stopped` | Auto-restart on crash |

### What each secret does

| Variable | Without it |
|----------|-----------|
| `ANTHROPIC_API_KEY` | lynox won't start |
| `LYNOX_VAULT_KEY` | Data stored in plaintext |
| `LYNOX_MCP_SECRET` | Anyone on the network can run agent tasks |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Anyone on Telegram can use your bot |

### One instance = one business

All users on the same instance **share the same knowledge, memory, and history**. This is by design — a team should share business context.

For **separate businesses**, deploy separate instances. Each gets its own Telegram bot, its own data volume, and its own knowledge — completely isolated.

### Docker Compose

For multi-service and multi-instance deployment, see `lynox-pro/packages/deploy/`.

See [Security — Production Deployment](/features/security/#production-deployment-security) for vault key rotation and full hardening details.

### Automatic Updates with Watchtower

To keep lynox updated automatically, run [Watchtower](https://containrrr.dev/watchtower/) alongside your container:

```bash
docker run -d \
  --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --cleanup --interval 86400 \
  lynox
```

This checks for new lynox images once per day (86400 seconds) and restarts the container automatically. Your data is on a volume, so updates are safe and seamless.

:::note
The [deploy page](https://lynox.ai/deploy) (both cloud and self-hosted paths), the [setup script](https://lynox.ai/setup-server.sh), and the generated `docker-compose.yml` all include Watchtower automatically.
:::

**Security considerations:**

- Watchtower requires Docker socket access (`/var/run/docker.sock`) to manage containers. This is standard for container management tools but grants full Docker API access.
- Updates are pulled from the official lynox image at `ghcr.io/lynox-ai/lynox`. If the image registry were compromised, a malicious image could be deployed automatically.
- For most users, automatic updates are **safer than never updating** — running outdated software with known vulnerabilities is a greater risk than the supply chain trust model.
- If you prefer manual control, omit Watchtower and update manually: `docker pull ghcr.io/lynox-ai/lynox:latest && docker restart lynox`.

---

## Reference

### Volumes

| Mount | Purpose |
|-------|---------|
| `~/.lynox` → `/home/lynox/.lynox` | Config, history, vault, memory, API profiles, backups, CRM |
| `/workspace` | Agent workspace sandbox |
| `~/.cache/huggingface` | Embedding model cache (~118MB, downloaded once) |

All persistent data lives inside `~/.lynox/`: backups (`backups/`), API profiles (`apis/`), CRM data (SQLite), and Knowledge Graph. A single volume mount covers everything.

### All Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint (proxies) |
| `LYNOX_VAULT_KEY` | Recommended | Encrypt data at rest |
| `LYNOX_MCP_SECRET` | Production | MCP HTTP bearer token |
| `LYNOX_MCP_PORT` | No | MCP port (default: 3042) |
| `LYNOX_HTTP_PORT` | No | Engine HTTP API port (default: 3100) |
| `LYNOX_WEBUI_URL` | No | Web UI URL for browser auto-open (default: http://localhost:5173) |
| `LYNOX_WORKSPACE` | No | Workspace root (default: /workspace) |
| `LYNOX_EMBEDDING_PROVIDER` | No | `onnx` / `voyage` / `local` |
| `TELEGRAM_BOT_TOKEN` | No | Enable Telegram bot |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Recommended | Restrict bot access |
| `GOOGLE_CLIENT_ID` | No | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | Google service account (headless) |
| `TAVILY_API_KEY` | No | Web search (Tavily) |
| `BRAVE_API_KEY` | No | Web search (Brave) |
| `LYNOX_SENTRY_DSN` | No | Error reporting (opt-in, EU region) |

### Version Pinning

Pin to a specific version instead of `latest` for reproducible deployments:

```bash
ghcr.io/lynox-ai/lynox:1.0.0    # semver — recommended for production
ghcr.io/lynox-ai/lynox:latest    # always the newest release
```

### Build from Source

```bash
git clone https://github.com/lynox-ai/lynox.git && cd lynox
docker build -t lynox .
docker run -it --rm -e ANTHROPIC_API_KEY lynox
```

### Security

The image is hardened for production by default:

- **Non-root** — runs as `lynox:1001`, not root
- **No package manager** — `npm`/`npx` removed from production image
- **Multi-stage build** — no source code, no build tools, production deps only
- **Pinned dependencies** — base image digest, whisper.cpp release tag, model checksum verified
- **Read-only root** — filesystem can't be modified (use `--read-only`)
- **SIGTERM handling** — graceful shutdown for agent runs and database writes
- **Trivy scanned** — CI blocks push on CRITICAL/HIGH vulnerabilities
- **OCI labels** — image metadata (version, source, license) for auditability
- **Minimal attack surface** — no bash, no perl, no SUID binaries, only `sh` (dash)
- **Network egress** — see below for required domains and firewall rules

See [Security](/features/security/) for the full model.

### Network Egress

lynox blocks private IP ranges and non-HTTP(S) protocols at the application level. For defense-in-depth, restrict outbound traffic at your firewall to only the domains lynox needs.

**Always required:**

| Domain | Port | Purpose |
|--------|------|---------|
| `api.anthropic.com` | 443 | Claude API (or custom `ANTHROPIC_BASE_URL`) |

**Per feature** (only needed if the feature is enabled):

| Domain | Port | Feature | Env var that enables it |
|--------|------|---------|------------------------|
| `api.telegram.org` | 443 | Telegram bot | `TELEGRAM_BOT_TOKEN` |
| `api.tavily.com` | 443 | Web search (Tavily) | `TAVILY_API_KEY` |
| `api.search.brave.com` | 443 | Web search (Brave) | `BRAVE_API_KEY` |
| `huggingface.co` | 443 | Embedding model download (first run, cached after) | always |
| `*.ingest.de.sentry.io` | 443 | Error reporting (EU region) | `LYNOX_SENTRY_DSN` |
| `accounts.google.com` | 443 | Google OAuth | `GOOGLE_CLIENT_ID` |
| `oauth2.googleapis.com` | 443 | Google token exchange | `GOOGLE_CLIENT_ID` |
| `*.googleapis.com` | 443 | Gmail, Sheets, Drive, Calendar, Docs | `GOOGLE_CLIENT_ID` |

**User-initiated:** The `web_research` and `http_request` tools can reach any public HTTPS URL. These are SSRF-protected (private IPs blocked, DNS validated, exfiltration detection). To restrict further, set `enforce_https: true` in config and use the built-in network policy (`deny-all` or `allow-list` mode).

**Always blocked (app-level):** `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, non-HTTP(S) protocols, redirects to private IPs.

#### Example: iptables egress rules

```bash
# Allow established connections + DNS
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT

# Allow required domains (resolve IPs first, or use ipset)
iptables -A OUTPUT -p tcp --dport 443 -d api.anthropic.com -j ACCEPT
iptables -A OUTPUT -p tcp --dport 443 -d api.telegram.org -j ACCEPT
# ... add per feature as needed

# Block everything else
iptables -A OUTPUT -j DROP
```

For Kubernetes, use a [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/) with egress rules matching the domains above.
