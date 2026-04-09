---
title: CLI Reference
description: Terminal interface and command reference.
sidebar:
  order: 1
---

The CLI is lynox's automation-oriented interface. All interactive features are in the Web UI.

## Entry Modes

### Docker Installer (default)

```bash
npx @lynox-ai/core
```

Interactive Docker setup — creates docker-compose.yml, .env, SearXNG config, starts containers, and opens the browser.

### One-Shot

```bash
npx @lynox-ai/core "Summarize the last 5 commits"
```

Runs a single task, streams the response to stdout, and exits. Great for scripting and CI.

### Piped Input

```bash
cat report.csv | npx @lynox-ai/core "Analyze this data"
```

Combines piped input with a task prompt.

## Flags

| Flag | Description |
|------|-------------|
| `--http-api` | Start Engine HTTP API only (no Web UI) |
| `--mcp-server` | Start as MCP server (stdio) |
| `--mcp-server --transport sse` | Start as MCP server (HTTP/SSE) |
| `--telegram` | Start Telegram bot mode |
| `--manifest <file>` | Run a workflow manifest |
| `--watch <glob> --on-change "<task>"` | Watch files and run task on change |
| `--task "<title>"` | Create a background task and exit |
| `--output <file>` | Save output to file |
| `--project <dir>` | Set project directory |
| `--data-dir <dir>` | Override data directory (default: `~/.lynox`) |
| `--init` | Re-run the Docker installer |
| `--version` | Show version (no API key required) |
| `--help` | Show help (no API key required) |

## Model Names

| Name | Model |
|------|-------|
| `opus` | Claude Opus (most capable) |
| `sonnet` | Claude Sonnet (balanced) |
| `haiku` | Claude Haiku (fastest) |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (API failure, invalid config, etc.) |
