---
title: "HTTP API"
description: "REST + SSE API powering the Web UI and programmatic access"
sidebar:
  order: 8
---

The Engine HTTP API exposes lynox as a REST + SSE server. It powers the [Web UI](/daily-use/web-ui/) (`packages/web-ui/`) and is available for programmatic access. Unlike the [MCP server](/developers/mcp-server/), which is designed for agent-to-agent tool use, the HTTP API provides full CRUD access to all Engine subsystems.

## Starting

The Engine HTTP API starts automatically when you run `lynox` (default mode). For headless/server use:

```bash
# Default: starts Engine + opens browser
lynox

# Headless (no browser, for servers/Docker)
lynox --http-api

# With custom data directory (for multi-user / PWA)
lynox --http-api --data-dir /data/user-123

# With authentication
LYNOX_HTTP_SECRET=your-token lynox --http-api
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LYNOX_HTTP_PORT` | `3100` | Server port |
| `LYNOX_HTTP_SECRET` | — | Bearer token for auth. Without it, binds to localhost only |
| `LYNOX_DATA_DIR` | `~/.lynox` | Data directory (same as `--data-dir`) |

## Authentication

When `LYNOX_HTTP_SECRET` is set:
- Server binds to `0.0.0.0` (network-accessible)
- All requests (except `/health`) require `Authorization: Bearer <token>`
- Token comparison uses `crypto.timingSafeEqual` (timing-safe)

When not set:
- Server binds to `127.0.0.1` (localhost only)
- No authentication required

## API Versioning

All endpoints accept both `/api/...` and `/api/v1/...` prefixes. The `v1` prefix is recommended for new integrations:

```
GET /api/v1/sessions      # recommended
GET /api/sessions          # also works (alias)
```

## Endpoints

### Health

```
GET /health
```

Unauthenticated. Returns `{"status":"ok"}`. Use for Docker healthchecks and load balancer probes.

### Sessions & Threads

Sessions hold conversation state across multiple runs. Every session is backed by a **persistent thread** stored in SQLite — conversations survive process restarts and can be resumed from the Web UI.

```
POST /api/sessions
Body: {
  "model"?: "opus"|"sonnet"|"haiku",
  "effort"?: "low"|"medium"|"high",
  "threadId"?: "uuid"   // Resume an existing thread
}
Response: {
  "sessionId": "uuid",
  "model": "sonnet",
  "contextWindow": 200000,
  "threadId": "uuid",
  "resumed": false
}
```

When `threadId` is provided, the backend loads the persisted conversation from the thread's message history. Short threads (<80 messages) are loaded verbatim; longer threads use a summary + the most recent 40 messages.

```
DELETE /api/sessions/:id
Response: { "ok": true }
```

### Threads

Threads are the persistent storage for conversations. Each session automatically creates a thread on first use.

```
GET    /api/threads                  → { threads: ThreadRecord[] }   Query: ?limit=50&includeArchived=false
GET    /api/threads/:id              → { thread: ThreadRecord }
PATCH  /api/threads/:id              → { ok: true }                  Body: { title?, is_archived? }
DELETE /api/threads/:id              → { ok: true }                  (deletes thread + all messages)
GET    /api/threads/:id/messages     → { messages: [...] }           Query: ?fromSeq=0&limit=10000
```

**ThreadRecord fields:** `id`, `title`, `model_tier`, `context_id`, `message_count`, `total_tokens`, `total_cost_usd`, `summary`, `is_archived`, `created_at`, `updated_at`.

### Runs (SSE Streaming)

Start a run and receive real-time events via Server-Sent Events:

```
POST /api/sessions/:id/run
Body: { "task": "your task here" }
Response: SSE stream (Content-Type: text/event-stream)
```

**SSE event types:**

| Event | Data | Description |
|-------|------|-------------|
| `text` | `{ text, agent }` | Agent text output |
| `thinking` | `{ thinking, agent }` | Thinking content |
| `thinking_done` | `{ agent }` | Thinking complete |
| `tool_call` | `{ name, input, agent }` | Tool invocation started |
| `tool_result` | `{ name, result, agent }` | Tool result |
| `prompt` | `{ question, options? }` | Permission/input prompt (reply via `/reply`) |
| `turn_end` | `{ stop_reason, usage }` | Turn complete with token usage |
| `error` | `{ error }` | Error during run |
| `context_pressure` | `{ droppedMessages, usagePercent, agent }` | Messages dropped due to context overflow |
| `context_budget` | `{ systemTokens, toolTokens, messageTokens, totalTokens, maxTokens, usagePercent, agent }` | Context usage breakdown (emitted when >70%) |
| `context_compacted` | `{ summary, previousUsagePercent, agent }` | Auto-compaction occurred (context was >75% full) |
| `changeset_ready` | `{ fileCount, agent }` | File changes ready for review |
| `done` | `{ result }` | Run complete, stream ends |

**Replying to prompts:**

```
POST /api/sessions/:id/reply
Body: { "answer": "y" }
Response: { "ok": true }
```

Prompts auto-deny after 2 minutes if no reply is received.

**Aborting a run:**

```
POST /api/sessions/:id/abort
Response: { "ok": true }
```

The run also aborts automatically if the client disconnects (SSE connection closes).

### Context Compaction

Manually compact the conversation history into a summary. Auto-compaction also runs after each run when context exceeds 75%.

```
POST /api/sessions/:id/compact
Body: { "focus"?: "specific topic to focus on" }
Response: { "ok": true, "summary": "bullet point summary..." }
```

Returns 409 if a run is currently in progress.

### Changeset Review

When `changeset_review` is enabled and the workspace is active, file writes are backed up. After a run, if files were modified, the `changeset_ready` SSE event fires.

```
GET /api/sessions/:id/changeset
Response: { "hasChanges": true, "files": [{ "file", "status", "diff", "added", "removed" }] }
```

```
POST /api/sessions/:id/changeset/review
Body: { "action": "accept"|"rollback"|"partial", "rolledBackFiles"?: ["path"] }
Response: { "ok": true, "accepted": 3, "rolledBack": 1 }
```

### Memory

```
GET    /api/memory/:namespace          → { content: string | null }
PUT    /api/memory/:namespace          → { ok: true }           Body: { content }
POST   /api/memory/:namespace/append   → { ok: true }           Body: { text }
PATCH  /api/memory/:namespace          → { updated: boolean }   Body: { old, new }
DELETE /api/memory/:namespace?pattern=  → { deleted: number }
```

Namespaces: `knowledge`, `methods`, `status`, `learnings`.

### Secrets

Secrets are encrypted at rest with AES-256-GCM via the SecretVault. Values are never returned in responses.

```
GET    /api/secrets              → { names: string[] }
PUT    /api/secrets/:name        → { ok: true }           Body: { value }
DELETE /api/secrets/:name        → { deleted: boolean }
```

### Vault

Rotate the vault master key (re-encrypts all secrets with a new key):

```
POST /api/vault/rotate
Body: { "newKey": "new-master-key-min-16-chars" }
Response: { "rotated": 5, "message": "Update LYNOX_VAULT_KEY and restart" }
```

Requires `LYNOX_VAULT_KEY` to be set. After rotation, update the environment variable and restart the Engine.

### Config

```
GET /api/config       → LynoxUserConfig object
PUT /api/config       → { ok: true }       Body: config fields to update
```

### Run History

```
GET /api/history/runs                     → { runs: RunRecord[] }   Query: ?limit=20&q=search
GET /api/history/runs/:id                 → RunRecord
GET /api/history/runs/:id/tool-calls      → { toolCalls: ToolCallRecord[] }
GET /api/history/stats                    → RunStats
GET /api/history/cost/daily               → CostByDay[]            Query: ?days=30
```

### Tasks

```
GET    /api/tasks                → { tasks: TaskRecord[] }   Query: ?status=open
POST   /api/tasks                → TaskRecord               Body: { title, description?, scheduleCron? }
PATCH  /api/tasks/:id            → TaskRecord               Body: update fields
POST   /api/tasks/:id/complete   → TaskRecord
```

## Rate Limiting

120 requests per minute per IP. Returns `429 Too Many Requests` with `Retry-After` header when exceeded.

## Architecture: HTTP API vs MCP

| | HTTP API | MCP Server |
|---|---|---|
| **Purpose** | PWA backend, programmatic access | External tool integration |
| **Consumers** | PWA Gateway, scripts | Claude Desktop, IDE plugins |
| **Protocol** | REST + SSE | MCP (stdio / HTTP) |
| **Data access** | Full CRUD (memory, secrets, config, history, tasks, threads) | Read-only memory, task execution only |
| **Streaming** | Real SSE (push) | Polling (1s interval) |
| **Auth** | Bearer token | Bearer token |
| **Port** | 3100 (default) | 3042 (default) |
| **Flag** | Default (or `--http-api` for headless) | `--mcp-server` |

Both can run simultaneously on different ports if needed.

## Process-per-User Model

In the PWA deployment, each user gets their own Engine process:

```
PWA Gateway (SvelteKit)
  ├─ User A → Engine :3101 → /data/user-a/
  ├─ User B → Engine :3102 → /data/user-b/
  └─ User C → (idle, not started)
```

The `--data-dir` flag isolates all data (memory, vault, history, KG) per user. The PWA Gateway's ProcessManager handles spawning, health checks, and idle cleanup (15-minute timeout).
