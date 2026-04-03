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
| `provider` | `anthropic`, `bedrock`, `vertex`, `custom` | `anthropic` |
| `aws_region` | Any AWS region (e.g. `eu-central-1`) | — |
| `bedrock_eu_only` | `true`, `false` | `false` |
| `gcp_region` | GCP region (e.g. `europe-west1`) | — |
| `gcp_project_id` | GCP project ID | — |
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

```json
{
  "search_provider": "tavily",
  "search_api_key": "tvly-..."
}
```

Supported providers: `searxng` (self-hosted, free, unlimited — included in docker-compose) or `tavily` (API key, 1,000 free/month). See [SearXNG setup](/integrations/searxng/) or get a Tavily key from [tavily.com](https://tavily.com).

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

Environment variables take precedence over config files. Alternatively, credentials can be stored interactively via lynox's secure `ask_secret` dialog — the agent will prompt you when it needs a key, and the value goes directly to the encrypted vault without ever entering the chat. See [Security](/features/security/#secure-secret-collection) for details.

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key (Anthropic provider) |
| `ANTHROPIC_BASE_URL` | Custom API base URL (for LiteLLM/proxy) |
| `LYNOX_LLM_PROVIDER` | LLM provider: `anthropic`, `bedrock`, `vertex`, `custom` |
| `AWS_REGION` | AWS region for Bedrock provider |
| `GCP_REGION` | GCP region for Vertex provider |
| `GCP_PROJECT_ID` | GCP project ID for Vertex provider |
| `LYNOX_VAULT_KEY` | Encryption key for the secret vault |
| `LYNOX_DATA_DIR` | Override data directory (default: `~/.lynox`) |
| `LYNOX_WORKSPACE` | Working directory for file operations |
| `SEARXNG_URL` | SearXNG instance URL (e.g. `http://localhost:8888`) |
| `TAVILY_API_KEY` | Tavily web search key (alternative to SearXNG) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON (headless/Docker) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated allowed Telegram chat IDs |

## Editing Config

You can edit config in three ways:

1. **Web UI** — Settings → Config
2. **Direct** — Edit `~/.lynox/config.json` manually (restart required)
