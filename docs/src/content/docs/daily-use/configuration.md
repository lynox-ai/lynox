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
  "api_base_url": "https://api.mistral.ai/v1",
  "openai_model_id": "mistral-large-2512"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `provider` | `anthropic` (tested), `openai` (Mistral tested; Ollama / LM Studio / OpenAI / Groq / vLLM / Gemini experimental), `custom` (Anthropic-compat proxy — experimental), `vertex` (legacy — experimental) | `anthropic` |
| `api_base_url` | Endpoint for `provider: openai` or `custom` | — |
| `openai_model_id` | Model ID for `provider: openai` (e.g. `mistral-large-2512`, `llama3.2`) | — |

Only **anthropic** and **openai with the Mistral endpoint** are exercised on every release. The other paths work in principle but are not regularly tested — see [LLM Providers](/setup/llm-providers/) for full details.

> Prefer pinned model IDs (`mistral-large-2512`) over floating tags like `mistral-large-latest` — pins keep behavior reproducible across silent provider snapshot rolls. See [LLM Providers — Mistral](/setup/llm-providers/#mistral-france-eu) for the rationale.

### Model & Intelligence

```json
{
  "default_tier": "balanced",
  "thinking_mode": "adaptive",
  "effort_level": "high"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `default_tier` | `fast`, `balanced`, `deep` | `balanced` |
| `thinking_mode` | `adaptive`, `disabled` | `adaptive` |
| `effort_level` | `low`, `medium`, `high`, `max` | `high` |

The tiers are provider-agnostic capability bands (`fast` = cheapest/quickest, `balanced` = default workhorse, `deep` = reasoning-heavy); each resolves to a concrete model for your active provider. The legacy Anthropic-brand names (`haiku`/`sonnet`/`opus`) are still accepted and normalized automatically, so existing configs keep working.

- **deep** — Most capable, reasoning-heavy, higher cost
- **balanced** — Default workhorse (recommended)
- **fast** — Quickest, lowest cost

### Cost Limits

```json
{
  "max_session_cost_usd": 50.00,
  "max_daily_cost_usd": 100.00,
  "max_monthly_cost_usd": 500.00
}
```

lynox tracks token usage per session, day, and month. Defaults shown above are the engine's built-in ceilings; lower them in `config.json` if you want a tighter budget. When a limit is reached, it pauses and asks before continuing.

### Web Search

Web search is included out of the box via **SearXNG** (bundled in docker-compose). No configuration needed — it works automatically.

```json
{
  "search_provider": "searxng",
  "searxng_url": "http://searxng:8080"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `searxng_url` | SearXNG instance URL — leave unset to fall back to DuckDuckGo HTML scrape (best-effort) | — |

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

### Knowledge Graph

```json
{
  "knowledge_graph_enabled": true,
  "embedding_provider": "onnx",
  "embedding_model": "all-minilm-l6-v2"
}
```

| Setting | Values | Default |
|---------|--------|---------|
| `knowledge_graph_enabled` | `true`, `false` | `true` |
| `embedding_provider` | `onnx`, `local` | `onnx` |
| `embedding_model` | `all-minilm-l6-v2`, `multilingual-e5-small`, `bge-m3` | `all-minilm-l6-v2` |

Use `multilingual-e5-small` or `bge-m3` if you primarily work in non-English languages.

### Changeset Review

```json
{
  "changeset_review": true
}
```

When enabled, file writes are staged and shown as a diff for review before being applied. Useful for high-autonomy setups where you still want a final check.

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

### Security

```json
{
  "enforce_https": false
}
```

When `enforce_https` is `true`, all outbound HTTP requests from tools are blocked — only HTTPS is allowed.

### Extensions

```json
{
  "agents_dir": "./agents",
  "manifests_dir": "./workflows"
}
```

See [Extension Points](/developers/extension-points/) for details.

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
| `ANTHROPIC_API_KEY` | Claude API key (Anthropic provider). Anthropic-only — does NOT serve `provider: openai`. |
| `ANTHROPIC_BASE_URL` | Base URL for `provider: openai` or `custom` (e.g. `https://api.mistral.ai/v1`) |
| `LYNOX_LLM_PROVIDER` | LLM provider: `anthropic` (default), `openai`, `custom` (Anthropic-compat proxy — experimental), `vertex` (legacy — experimental) |

### OpenAI-Compatible

| Variable | Purpose |
|----------|---------|
| `MISTRAL_API_KEY` | Mistral API key — primary slot for `provider: openai` with the Mistral endpoint (natively supported). |
| `OPENAI_API_KEY` | Bearer for generic OpenAI-compatible endpoints (experimental). Secondary slot — `MISTRAL_API_KEY` is also accepted. Leave blank for local Ollama / LM Studio without auth. |
| `OPENAI_MODEL_ID` | Model ID, e.g. `mistral-large-2512` (prefer pinned over `-latest`), `llama3.2`, `gpt-4o`, `llama-3.3-70b-versatile` |
| `ANTHROPIC_BASE_URL` | Provider base URL — see [LLM Providers](/setup/llm-providers/) for the value per backend |

### Legacy: Google Vertex AI (experimental)

`provider: vertex` is no longer offered by the installer; the env vars below remain wired for existing `config.json` setups that still point at Vertex but are not regularly tested. New installs should use Anthropic direct or Mistral.

| Variable | Purpose |
|----------|---------|
| `GCP_PROJECT_ID` | GCP project ID |
| `CLOUD_ML_REGION` | Vertex region, e.g. `europe-west4`, `us-east5` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service-account JSON |

### Web Search

| Variable | Purpose |
|----------|---------|
| `SEARXNG_URL` | SearXNG instance URL (included in docker-compose, recommended). Without it, `web_research` falls back to a best-effort DuckDuckGo HTML scrape. |

### Network & Server

| Variable | Purpose |
|----------|---------|
| `LYNOX_HTTP_PORT` | HTTP API port (default: `3000` in Docker, `3100` locally) |
| `LYNOX_HTTP_SECRET` | Bearer token for HTTP API authentication |
| `LYNOX_WEBUI_URL` | Web UI URL (default: `http://localhost:5173`) |

### Security & Storage

| Variable | Purpose |
|----------|---------|
| `LYNOX_VAULT_KEY` | Encryption key for the secret vault |
| `LYNOX_DATA_DIR` | Override data directory (default: `~/.lynox`) |
| `LYNOX_WORKSPACE` | Working directory for file operations |
| `LYNOX_BUGSINK_DSN` | Error reporting DSN (self-hosted, opt-in) |

### Google Workspace

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Path to Google service account JSON key file (headless/Docker) |

## Editing Config

You can edit config in two ways:

1. **Web UI** — Settings → Config
2. **Direct** — Edit `~/.lynox/config.json` manually (restart required)
