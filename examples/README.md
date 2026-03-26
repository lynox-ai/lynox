# Examples

Runnable examples demonstrating the lynox SDK. Each file is self-contained.

## Prerequisites

- Node.js 22+
- `ANTHROPIC_API_KEY` environment variable set

## Examples

| File | Description |
|------|-------------|
| [`basic-run.ts`](basic-run.ts) | Minimal SDK usage — init, run a task, print result |
| [`custom-tool.ts`](custom-tool.ts) | Register a custom tool the agent can call |
| [`stream-events.ts`](stream-events.ts) | Real-time streaming of thinking, tool calls, and text |
| [`run-pipeline.ts`](run-pipeline.ts) | Run a multi-step workflow from a JSON manifest |
| [`pipeline.json`](pipeline.json) | Example workflow manifest (used by `run-pipeline.ts`) |

## Run

```bash
# From the repo root
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/basic-run.ts
```

Or install dependencies first:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/basic-run.ts
```
