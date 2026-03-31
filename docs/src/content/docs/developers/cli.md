---
title: CLI Reference
description: Terminal interface and command reference.
sidebar:
  order: 1
---

The CLI is lynox's developer-oriented interface. It supports three modes of operation.

## Entry Modes

### Interactive (default)

```bash
npx @lynox-ai/core
```

Starts the Engine HTTP API and opens the Web UI. This is what most users should use.

### One-Shot

```bash
npx @lynox-ai/core "Summarize the last 5 commits"
```

Runs a single task, streams the response to stdout, and exits. Great for scripting and CI.

### REPL

```bash
npx @lynox-ai/core --repl
```

Interactive terminal session with slash commands, streaming output, and markdown rendering.

## Flags

| Flag | Description |
|------|-------------|
| `--repl` | Start in REPL mode (terminal interface) |
| `--mcp` | Start as MCP server (stdio) |
| `--http-api` | Start Engine HTTP API only (no Web UI) |
| `--init` | Re-run the setup wizard |
| `--version` | Show version (no API key required) |
| `--help` | Show help (no API key required) |

## Slash Commands

Available in REPL mode:

### Session

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation (memory preserved) |
| `/compact [focus]` | Summarize conversation to free context window |
| `/save` | Save current session to disk |
| `/load [name]` | Restore a saved session |
| `/export [file]` | Export last response to a file |
| `/history [search]` | Browse command history |

### Model

| Command | Description |
|---------|-------------|
| `/model [name]` | Switch model — `opus`, `sonnet`, `haiku` |
| `/accuracy [level]` | Set thinking depth |
| `/cost` | Show token usage and cost for current session |
| `/context` | Show context window usage |

### Project

| Command | Description |
|---------|-------------|
| `/git [cmd]` | Git operations — `status`, `diff`, `log`, `branch` |
| `/pr` | Generate a PR description from current changes |
| `/diff` | Show current diff |
| `/config` | Open settings |
| `/status` | Show version, model, mode, and active tools |

### Tools & Roles

| Command | Description |
|---------|-------------|
| `/tools` | List all available tools |
| `/mcp <name> <url>` | Register an MCP server |
| `/mode` | Show current session status |
| `/roles` | Show available roles |

### System

| Command | Description |
|---------|-------------|
| `/help` | Show basic help |
| `/help all` | Show all commands |
| `/exit` | Exit lynox |

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
