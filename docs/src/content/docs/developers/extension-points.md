---
title: Extension Points
description: Extend lynox with custom tools, roles, agents, and workflow manifests.
sidebar:
  order: 3
---

lynox is designed to be extended without modifying core source code. There are several ways to add functionality.

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
import type { ToolEntry } from '@lynox-ai/core/types';
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
  definition: {
    name: 'my_tool',
    description: 'Does something useful',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The input query' }
      },
      required: ['query']
    }
  },
  handler: async (input, context) => {
    // Your tool logic here
    return { result: `Processed: ${input.query}` };
  }
});
```

## License Note

lynox is licensed under the Elastic License 2.0 (ELv2). You can use, modify, and self-host it freely. The only restriction: you cannot offer lynox as a managed/hosted service to third parties.
