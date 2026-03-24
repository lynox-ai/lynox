# Batch Processing

## Overview

NODYN supports the Anthropic Message Batches API for async processing at reduced cost. Batch requests are processed server-side and results are retrieved when ready.

## API Methods

### `batch(requests)`

Submit a batch of tasks. Returns the batch ID.

```typescript
const batchId = await nodyn.batch([
  { id: 'task-1', task: 'Summarize article A' },
  { id: 'task-2', task: 'Summarize article B' },
  { id: 'task-3', task: 'Summarize article C', system: 'Be concise.' },
]);
// Returns: "batch_abc123..."
```

### `awaitBatch(batchId)`

Poll for batch completion and return results.

```typescript
const results = await nodyn.awaitBatch(batchId);
// Returns: BatchResult[]
```

Polling starts at 30s intervals, doubling up to 5 minutes max.

### `batchAndAwait(requests)`

Convenience method: submit + wait in one call.

```typescript
const results = await nodyn.batchAndAwait([
  { id: 'q1', task: 'What is 2+2?' },
  { id: 'q2', task: 'What is 3+3?' },
]);
```

## Types

### BatchRequest

```typescript
interface BatchRequest {
  id:      string;             // Unique request ID
  task:    string;             // The task/question
  system?: string;             // Optional system prompt override
  label?:  string;             // Optional label for tracking
}
```

### BatchResult

```typescript
interface BatchResult {
  id:      string;
  status:  'succeeded' | 'errored' | 'expired' | 'canceled';
  result?: string;             // Text response (on success)
  error?:  string;             // Error message (on error)
}
```

## Batch Index

NODYN persists batch metadata locally in `~/.nodyn/batch-index.json`:

```json
{
  "batch_abc123": {
    "submitted_at": "2025-01-15T10:30:00.000Z",
    "request_count": 3,
    "label": "summarize-articles"
  }
}
```

Access the index programmatically:

```typescript
const index = nodyn.getBatchIndex();
const entry = await index.get('batch_abc123');
```

## CLI Commands

### `/batch <file>`

Submit a batch from a JSON file:

```bash
# batch.json
[
  { "id": "t1", "task": "Explain quantum computing" },
  { "id": "t2", "task": "Explain machine learning" }
]
```

```
/batch batch.json
# Output: Batch submitted: batch_abc123...
```

### `/batch-status <id>`

Check batch status from the local index:

```
/batch-status batch_abc123
# Output:
# Batch: batch_abc123
# Submitted: 2025-01-15T10:30:00.000Z
# Requests: 3
# Label: summarize-articles
```

## MCP Server Tools

When running as an MCP server, batch operations are exposed as:

- **`nodyn_batch`**: Submit a batch (input: `requests` array)
- **`nodyn_status`**: Check batch status (input: `batch_id`)

The `nodyn_status` tool queries the Anthropic API directly and returns processing counts (processing, succeeded, errored, canceled, expired).

## Configuration

Batch requests use the current model and max tokens from `NodynConfig`. The system prompt defaults to NODYN's built-in prompt unless overridden per request.
