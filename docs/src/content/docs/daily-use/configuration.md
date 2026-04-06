---
title: Configuration
description: Customize lynox to fit your workflow.
sidebar:
  order: 2
---

## Config Files

lynox uses two config files, merged at startup:

| File | Scope | Purpose |
|------|-------|---------|
| `~/.lynox/config.json` | User | API key, model, personal preferences |
| `.lynox/config.json` | Project | Project-specific overrides (safe subset only) |

Project configs cannot override security-sensitive fields like API keys or vault settings.

## Key Settings

### LLM Provider

```json
{
  "provider": "anthropic",
  "aws_region": "eu-central-1",
  "bedrock_eu_only": true,
  "gcp_region": "europe-west1",
  "gcp_project_id": "my-project",
  "api_base_url": "http://localhost:4000"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `provider` | `anthropic`, `bedrock`, `custom` | `anthropic` |
| `aws_region` | Any AWS region (e.g. `eu-central-1`) | — |
| `bedrock_eu_only` | `true`, `false` | `false` |
| `api_base_url` | Custom proxy URL | — |

Only configure the fields relevant to your provider. See [LLM Providers](/daily-use/llm-providers/) for full setup guides.

### Model & Intelligence

```json
{
  "default_tier": "sonnet",
  "thinking_mode": "adaptive",
  "effort_level": "high"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `default_tier` | `opus`, `sonnet`, `haiku` | `sonnet` |
| `thinking_mode` | `adaptive`, `disabled` | `adaptive` |
| `effort_level` | `low`, `medium`, `high`, `max` | `high` |

- **opus** — Most capable, higher cost
- **sonnet** — Balanced (recommended)
- **haiku** — Fastest, lowest cost

### Cost Limits

```json
{
  "max_session_cost_usd": 5.00,
  "max_daily_cost_usd": 20.00,
  "max_monthly_cost_usd": 200.00
}
```

lynox tracks token usage per session, day, and month. When a limit is reached, it pauses and asks before continuing.

### Web Search

Web search is included out of the box via **SearXNG** (bundled in docker-compose). No configuration needed — it works automatically.

See [SearXNG setup](/integrations/searxng/) for details.

### Memory

```json
{
  "memory_extraction": true,
  "memory_half_life_days": 90
}
```

- `memory_extraction` — Automatically extract and store insights from conversations
- `memory_half_life_days` — How quickly memories fade (higher = longer retention)

### Backups

```json
{
  "backup_schedule": "0 3 * * *",
  "backup_retention_days": 30,
  "backup_encrypt": true,
  "backup_gdrive": false
}
```

See [Backups](/features/backup/) for details.

### Experience Mode

```json
{
  "experience": "business"
}
```

- `business` — Optimized for business users (default)
- `developer` — Shows more technical details and options (experimental)

## Environment Variables

Environment variables always take the highest precedence. The full priority chain for secrets is:

1. **Environment variable** (e.g. `ANTHROPIC_API_KEY`) — always wins, useful for overriding stale vault entries
2. **Encrypted vault** (`~/.lynox/vault.db`) — persisted via Web UI or `ask_secret`
3. **Config file** (`~/.lynox/config.json`) — lowest priority

When an env var overrides a vault value, a log message is printed: `[lynox] ANTHROPIC_API_KEY env var overrides vault value`.

Credentials can also be stored interactively via lynox's secure `ask_secret` dialog — the agent will prompt you when it needs a key, and the value goes directly to the encrypted vault without ever entering the chat. See [Security](/features/security/#secure-secret-collection) for details.

### LLM Provider

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key (Anthropic provider) |
| `ANTHROPIC_BASE_URL` | Custom API base URL (for LiteLLM/proxy) |
| `LYNOX_LLM_PROVIDER` | LLM provider: `anthropic`, `bedrock`, `custom` |

### AWS Bedrock

| Variable | Purpose |
|----------|---------|
| `AWS_REGION` | AWS region (e.g. `us-east-1`, `eu-west-1`) |
| `AWS_ACCESS_KEY_ID` | IAM access key (or use IAM role on EC2/ECS) |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `AWS_SESSION_TOKEN` | Temporary session token (for assumed roles / SSO) |

### Web Search

| Variable | Purpose |
|----------|---------|
| `SEARXNG_URL` | SearXNG instance URL (included in docker-compose, recommended) |
| `TAVILY_API_KEY` | Tavily API key (fallback when SearXNG unavailable, 1K free/month) |

### Security & Storage

| Variable | Purpose |
|----------|---------|
| `LYNOX_VAULT_KEY` | Encryption key for the secret vault |
| `LYNOX_DATA_DIR` | Override data directory (default: `~/.lynox`) |
| `LYNOX_WORKSPACE` | Working directory for file operations |

### Google Workspace

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON key (headless/Docker) |

### Telegram

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated allowed Telegram chat IDs |

## Editing Config

You can edit config in three ways:

1. **Web UI** — Settings → Config
2. **Direct** — Edit `~/.lynox/config.json` manually (restart required)
