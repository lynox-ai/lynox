# MCP Server

NODYN can be exposed as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server so other MCP-compatible clients can use NODYN as a tool provider and async agent runtime.

## Transports

### stdio

```bash
node dist/index.js --mcp-server
```

Standard MCP stdio transport. Input/output on stdin/stdout, logs on stderr.

### HTTP

```bash
node dist/index.js --mcp-server --transport sse
```

Starts the HTTP transport on port `3042` by default (configurable via `NODYN_MCP_PORT`).

## Exposed Tools

### Core execution

| Tool | Description |
|------|-------------|
| `nodyn_run` | Run a task synchronously and return the final text |
| `nodyn_run_start` | Start an async run and return `run_id` immediately |
| `nodyn_poll` | Poll accumulated output, status, errors, `waiting_for_input`, and `output_files` |
| `nodyn_reply` | Resume a paused async run waiting for user input |
| `nodyn_abort` | Abort in-flight work by `session_id` |
| `nodyn_reset` | Reset a session and abort any active run in it |

### Data access

| Tool | Description |
|------|-------------|
| `nodyn_memory` | Read `facts`, `skills`, `context`, or `errors` memory |
| `nodyn_read_file` | Read a produced file as base64 from the working dir or `/tmp/nodyn-files` |

### Batch

| Tool | Description |
|------|-------------|
| `nodyn_batch` | Submit a reduced-cost async batch |
| `nodyn_status` | Inspect a batch by `batch_id` |

## Async Run Lifecycle

1. Call `nodyn_run_start` with `task` and optional `session_id`, `user_context`, and `files`.
2. Poll with `nodyn_poll`. Pass `cursor` for incremental event streaming.
3. If `waiting_for_input` is returned, answer with `nodyn_reply`.
4. When `done: true`, read `text`, `statusHistory`, `error`, and optional `output_files`.
5. If files were produced, fetch them with `nodyn_read_file`.

Example `nodyn_run_start` response:

```json
{ "run_id": "6af0d8d2-..." }
```

Example `nodyn_poll` response while waiting on user input:

```json
{
  "done": false,
  "text": "Working on it...",
  "status": "⚡ write_file",
  "waiting_for_input": {
    "question": "Allow running: rm -rf ./dist?",
    "options": ["Allow", "Deny"]
  }
}
```

Example terminal `nodyn_poll` response:

```json
{
  "done": true,
  "text": "Finished.",
  "statusHistory": ["read_file", "write_file"],
  "output_files": [
    { "name": "report.md", "path": "/tmp/nodyn-files/...", "type": "file" }
  ]
}
```

## Event Log (Cursor-Based Polling)

The MCP server maintains an append-only event log per async run. Clients can poll with a `cursor` parameter to receive only new events since the last poll:

```json
// Request: nodyn_poll({ run_id: "...", cursor: 5 })
// Response:
{
  "done": false,
  "text": "...",
  "events": [
    { "id": 6, "type": "tool_call", "timestamp": 1710345678901, "data": { "name": "bash", "input": { "command": "git status" } } },
    { "id": 7, "type": "tool_result", "timestamp": 1710345679123, "data": { "name": "bash", "success": true, "preview": "On branch main..." } }
  ],
  "nextCursor": 7
}
```

### Event types

| Type | Data fields | Description |
|------|------------|-------------|
| `thinking` | `summary` (first 200 chars) | Thinking step (max 1 per API turn) |
| `tool_call` | `name`, `input` | Tool invocation |
| `tool_result` | `name`, `success`, `preview` (first 300 chars) | Tool completion |
| `text_chunk` | `text` | Accumulated text (flushed on tool_call, turn_end, or >2000 chars) |
| `turn_end` | `stop_reason` | API turn completed |
| `error` | `message` | Error during run |
| `continuation` | `iteration`, `max` | Auto-continuation |

### Backward compatibility

When `cursor` is omitted, the poll response is identical to the pre-event-log format. Existing clients (without cursor support) are unaffected.

### Limits

- Max 500 events per run (oldest evicted when exceeded)
- Text buffer flushed as `text_chunk` events at 2000 character intervals

## Attachments

`nodyn_run_start` accepts optional `files` entries with:

```json
{
  "name": "notes.txt",
  "mimetype": "text/plain",
  "data": "<base64>",
  "size": 1234
}
```

Behavior:

- small text attachments can be safely inlined into the prompt
- larger or binary attachments are written to `/tmp/nodyn-files/<run_id>/...`
- attachment wrappers are XML-escaped before prompt injection
- duplicate names are sanitized and de-conflicted

## Limits and Persistence

Current MCP safety limits:

- max `12` active sessions with running async work
- max `64` tracked async runs
- max `2MB` buffered text per run
- max `8MB` buffered text across all tracked runs
- max `10MB` per attachment, `25MB` total attachment payload per run
- max `200KB` inline text attachment budget per run

Async run metadata is persisted to:

- `$NODYN_MCP_STATE_DIR/mcp-runs.json`, or
- `.nodyn/mcp-runs.json` under the current working directory

Restart behavior:

- completed runs remain pollable after restart
- runs that were still active at shutdown are restored as completed with error text `Server restarted before run completed`

## Health Check

```
GET /health
```

Always returns:

```json
{ "status": "ok" }
```

This endpoint is intentionally unauthenticated for health checks.

## Authentication

Set `NODYN_MCP_SECRET` to enable bearer auth on the HTTP transport:

```bash
export NODYN_MCP_SECRET="your-secret-token"
node dist/index.js --mcp-server --transport sse
```

Or store it in the encrypted vault (loaded automatically when env var is not set):

```bash
nodyn vault set NODYN_MCP_SECRET "your-secret-token"
```

Clients must send:

```
Authorization: Bearer your-secret-token
```

Without `NODYN_MCP_SECRET`, the HTTP transport is open and binds to `127.0.0.1` only. Token comparison uses `crypto.timingSafeEqual`.

**Network exposure**: When auth is enabled, the server binds to `0.0.0.0`. A startup warning recommends TLS termination via reverse proxy since the Bearer token travels in cleartext over plain HTTP.

**Secret rotation**: Vault-stored secrets older than 90 days trigger a startup warning. Rotate with `nodyn vault set NODYN_MCP_SECRET <new-token>`. Generate a strong token: `openssl rand -hex 32`.

## Session Management

The MCP server uses `Engine` (not `Nodyn` directly) internally. `SessionStore` (`src/core/session-store.ts`) holds per-session `Session` instances (created via `engine.createSession()`), each with its own conversation history, mode, and active run state.

Only one active async run is allowed per session at a time. Starting another one returns an error with the existing `run_id` when available.

## Usage Examples

### stdio (Docker)

```bash
docker run -i --rm -e ANTHROPIC_API_KEY=sk-ant-... nodyn --mcp-server
```

### HTTP (Docker)

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -p 3042:3042 \
  nodyn --mcp-server --transport sse
```

### Programmatic

```typescript
import { NodynMCPServer } from '@nodyn-ai/core';

const server = new NodynMCPServer({
  model: 'sonnet',
  effort: 'high',
});
await server.init();

await server.startHTTP(3042);
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODYN_MCP_PORT` | `3042` | HTTP server port |
| `NODYN_MCP_SECRET` | *(none)* | Bearer token for HTTP auth. Can also be stored in vault |
| `NODYN_MCP_STATE_DIR` | `.nodyn/` under cwd | Directory for persisted async run state |
| `ANTHROPIC_API_KEY` | -- | API key |
| `ANTHROPIC_BASE_URL` | -- | Custom API endpoint |
