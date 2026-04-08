---
title: MCP
description: Connect lynox to Claude Desktop, Cursor, and other MCP clients.
sidebar:
  order: 3
---

lynox implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — an open standard for connecting AI tools. Supports stdio and Streamable HTTP transports. This lets you use lynox's memory, knowledge, and capabilities directly from your IDE or AI assistant.

## What This Enables

- Run lynox tasks from Claude Desktop or Cursor without switching windows
- Access lynox's persistent memory from any MCP-compatible client
- Use lynox as a backend for autonomous task execution

## Available Tools

When connected as an MCP server, lynox exposes these tools:

| Tool | Description |
|------|-------------|
| `lynox_run` | Run a task and wait for the result |
| `lynox_run_start` | Start a task asynchronously (non-blocking) |
| `lynox_poll` | Poll for results from an async task |
| `lynox_reply` | Answer a question from a running task |
| `lynox_abort` | Stop a running task |
| `lynox_memory` | Read agent memory by namespace |
| `lynox_reset` | Clear a session |
| `lynox_batch` | Submit batch tasks for reduced-cost processing |
| `lynox_status` | Check batch processing status |
| `lynox_read_file` | Read a file from the workspace |

## Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on Mac):

**Local install:**

```json
{
  "mcpServers": {
    "lynox": {
      "command": "npx",
      "args": ["@lynox-ai/core", "--mcp-server"]
    }
  }
}
```

**Docker:**

```json
{
  "mcpServers": {
    "lynox": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "ANTHROPIC_API_KEY=sk-ant-...",
        "-v", "~/.lynox:/home/lynox/.lynox",
        "ghcr.io/lynox-ai/lynox:latest", "--mcp-server"
      ]
    }
  }
}
```

## Setup with Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "lynox": {
      "command": "npx",
      "args": ["@lynox-ai/core", "--mcp-server"]
    }
  }
}
```

## Tool Whitelist

By default, all tools are exposed. To restrict which tools are available:

```json
{
  "mcp_exposed_tools": ["lynox_run", "lynox_memory"]
}
```

Only listed tools will be registered with the MCP client.

## Async Tasks

For long-running tasks, use the async flow:

1. **`lynox_run_start`** — Starts the task, returns a `run_id` immediately
2. **`lynox_poll`** — Check for accumulated results (text chunks, tool calls, events)
3. **`lynox_reply`** — If the task asks a question, send the answer

This prevents timeouts for tasks that take more than a few seconds.

## Tips

- lynox runs tasks with the same capabilities as the Web UI — memory, tools, integrations
- Each MCP session gets its own isolated context
- Use `lynox_memory` to give your IDE access to business knowledge that lynox has accumulated
