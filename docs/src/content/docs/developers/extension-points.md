---
title: Extension Points
description: Extend lynox with custom tools, roles, and plugins.
sidebar:
  order: 3
---

lynox is designed to be extended without modifying core source code. There are several ways to add functionality.

## Custom MCP Servers

The simplest way to extend lynox is by connecting external MCP servers. These add new tools that lynox can use during conversations.

### Register via CLI

```bash
/mcp my-server https://my-mcp-server.example.com/sse
```

### Register via config

```json
{
  "mcp_servers": [
    { "name": "my-server", "url": "https://my-mcp-server.example.com/sse" }
  ]
}
```

Once registered, the tools from the MCP server are available in all sessions. lynox discovers capabilities automatically via the MCP protocol.

## Plugins

Plugins can extend lynox's functionality at a deeper level. Enable or disable them in your config:

```json
{
  "plugins": {
    "my-plugin": true
  }
}
```

Plugins are loaded at startup and can register additional tools, modify behavior, or add new capabilities.

## Custom Roles

Beyond the four built-in roles (Researcher, Creator, Operator, Collector), you can define custom roles that set specific model tiers, tool restrictions, and autonomy levels.

## Custom Agents

Place agent definitions in a directory and configure it:

```json
{
  "agents_dir": "./agents"
}
```

Agents are specialized configurations that combine a system prompt with tool access rules for specific use cases.

## Workflow Manifests

Define multi-step workflows as YAML or JSON manifests:

```json
{
  "manifests_dir": "./workflows"
}
```

Manifests describe step sequences, dependencies, and conditions. lynox executes them as pipelines with progress tracking.

## Programmatic API

If you're building on top of lynox as a library:

```typescript
import { Engine, Session, ToolRegistry } from '@lynox-ai/core';
import type { ToolDefinition } from '@lynox-ai/core/types';
```

The main exports include:

- **Engine** — Core singleton, manages sessions and background tasks
- **Session** — Per-conversation context with streaming
- **ToolRegistry** — Register and manage tools
- **WorkerLoop** — Schedule and run background tasks
- **Memory** — Access the memory system
- **TaskManager** — Manage tasks programmatically

### Registering a custom tool

```typescript
const registry = new ToolRegistry();

registry.register({
  name: 'my_tool',
  description: 'Does something useful',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The input query' }
    },
    required: ['query']
  },
  handler: async (input, context) => {
    // Your tool logic here
    return { result: `Processed: ${input.query}` };
  }
});
```

## License Note

lynox is licensed under the Elastic License 2.0 (ELv2). You can use, modify, and self-host it freely. The only restriction: you cannot offer lynox as a managed/hosted service to third parties.
