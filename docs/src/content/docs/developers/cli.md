---
title: CLI Reference
description: Installer, HTTP API server, and recovery flags.
sidebar:
  order: 1
---

The `lynox` CLI is the **installer + server entrypoint**. All interactive features
live in the Web UI. All scripted/agent workflows go through the HTTP API
(`lynox --http-api`).

Pre-HN-launch we trimmed the power-user CLI modes (single-task invocation,
file-watch, manifest runner, background-task creator, output redirect). They
were undocumented in the user-facing surface, had no external callers, and were
not exercised by CI. We will revisit them once OSS-launch traffic shape tells
us which (if any) are missed.

## Entry Modes

### Docker Installer (default)

```bash
npx @lynox-ai/core
```

Interactive Docker setup — creates `docker-compose.yml`, `.env`, SearXNG config,
starts the containers, and opens the browser. Re-run anytime via `lynox init`
or `lynox --init`.

### HTTP API Server

```bash
lynox --http-api
```

Starts the Engine HTTP API on `LYNOX_HTTP_PORT` (default `3100`). This is the
production entrypoint used by the bundled Docker image (`entrypoint-webui.sh`
exec's `node dist/index.js --http-api`). Drive lynox programmatically via the
REST/SSE endpoints exposed by this server.

## Flags

| Flag | Description |
|------|-------------|
| `--http-api` | Start Engine HTTP API server (Docker entrypoint) |
| `--init` / `init` | Re-run the Docker installer |
| `--project <dir>` | Set project directory (loads `.lynox/config.json` if present) |
| `--data-dir <dir>` | Override data directory (default: `~/.lynox`) |
| `--version` / `-v` | Show version (no API key required) |
| `--help` / `-h` | Show help (no API key required) |

## Environment

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for the anthropic provider) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint (for proxies) |
| `MISTRAL_API_KEY` | Mistral API key (used with `provider: openai` pinned to the Mistral endpoint — EU data residency) |
| `LYNOX_LLM_PROVIDER` | LLM provider: `anthropic` \| `custom` \| `openai` \| `vertex` (legacy — wired for existing config.json setups, no longer offered by the installer/wizard) |
| `LYNOX_VAULT_KEY` | AES-256 key for the secrets vault (critical — cannot be recovered if lost) |
| `LYNOX_DATA_DIR` | Override data directory (same as `--data-dir`) |
| `LYNOX_HTTP_PORT` | HTTP API port (default: `3100`) |
| `LYNOX_HTTP_SECRET` | HTTP API Bearer token (enables network binding) |
| `LYNOX_WEBUI_URL` | Web UI URL to open (default: `http://localhost:5173`) |
| `GCP_PROJECT_ID` | Google Cloud project (for legacy `provider: vertex`) |
| `CLOUD_ML_REGION` | Vertex AI region (e.g. `europe-west4`, `us-east5`) — legacy `provider: vertex` only |
| `SEARXNG_URL` | SearXNG instance for web search (Docker: `http://searxng:8080`). Without it, `web_research` falls back to a best-effort DuckDuckGo HTML scrape. |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (API failure, invalid config, etc.) |
