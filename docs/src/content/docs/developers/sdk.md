---
title: "SDK Usage"
description: "Use lynox as a TypeScript library"
sidebar:
  order: 10
---

Use lynox as a library in your own TypeScript projects.

## Minimal example

```typescript
import { Engine } from '@lynox-ai/core';

// Create the shared Engine singleton
const engine = new Engine({ model: 'sonnet' });
await engine.init();

// Create a session for this conversation
const session = engine.createSession({ model: 'sonnet' });
const result = await session.run('List all TODO comments in this codebase');
console.log(result);

await engine.shutdown();
```

> **Note:** Use `Engine` + `Session` directly. The old `Lynox` class no longer exists.

## Error handling

```typescript
import { Engine, ValidationError, ExecutionError } from '@lynox-ai/core';

const engine = new Engine({ model: 'sonnet' });
await engine.init();

const session = engine.createSession();

try {
  const result = await session.run('Analyze the quarterly report');
  console.log(result);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error('Invalid input:', err.message, err.context);
  } else if (err instanceof ExecutionError) {
    console.error('Execution failed:', err.message, err.cause);
  } else {
    throw err;
  }
} finally {
  await engine.shutdown();
}
```

## Register a custom tool

```typescript
engine.addTool({
  definition: {
    type: 'custom',
    name: 'lookup_price',
    description: 'Look up the current price of a product by SKU.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Product SKU' },
      },
      required: ['sku'],
    },
  },
  handler: async (input) => {
    const { sku } = input as { sku: string };
    // Your logic here — call a database, API, etc.
    return JSON.stringify({ sku, price: 29.99, currency: 'USD' });
  },
});
```

## Stream events

```typescript
const session = engine.createSession();

session.onStream = (event) => {
  if (event.type === 'text') process.stdout.write(event.text);
  if (event.type === 'tool_call') console.log(`\n🔧 ${event.name}`);
};

await session.run('Write a summary of this project');
```

## Run a workflow

```typescript
import { loadManifestFile, runManifest, loadConfig } from '@lynox-ai/core';

const manifest = loadManifestFile(new URL('./workflow.json', import.meta.url).pathname);
const state = await runManifest(manifest, loadConfig(), {
  hooks: {
    onStepStart: (stepId) => console.log(`▶ Starting: ${stepId}`),
    onStepComplete: (output) => console.log(`✅ Done: ${output.stepId} (${output.durationMs}ms)`),
  },
});

for (const [stepId, output] of state.outputs) {
  console.log(`[${stepId}] ${output.result}`);
}
```

Workflow manifest (`workflow.json`):

```json
{
  "manifest_version": "1.1",
  "name": "research-and-summarize",
  "triggered_by": "manual",
  "context": {},
  "agents": [
    { "id": "research", "agent": "researcher", "runtime": "agent", "task": "Research the topic", "model": "sonnet" },
    { "id": "summarize", "agent": "creator", "runtime": "agent", "task": "Summarize findings", "model": "haiku", "input_from": ["research"] }
  ]
}
```

## Batch processing

```typescript
const results = await session.batchAndAwait([
  { id: 'a', task: 'Summarize Q1 report' },
  { id: 'b', task: 'Summarize Q2 report' },
  { id: 'c', task: 'Summarize Q3 report' },
]);

for (const r of results) {
  console.log(`${r.id}: ${r.status === 'succeeded' ? r.result : r.error}`);
}
```

See [`examples/`](../examples/) for complete runnable scripts.
