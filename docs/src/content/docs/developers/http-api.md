---
title: "HTTP API"
description: "REST + SSE API powering the Web UI and programmatic access"
sidebar:
  order: 8
---

The Engine HTTP API exposes lynox as a REST + SSE server. It powers the [Web UI](/daily-use/web-ui/) (`packages/web-ui/`) and is available for programmatic access. Unlike the [MCP server](/developers/mcp-server/), which is designed for agent-to-agent tool use, the HTTP API provides full CRUD access to all Engine subsystems.

## Starting

```bash
# Start HTTP API (default port 3100)
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

## Endpoints

### Health

```
GET /health
```

Unauthenticated. Returns `{"status":"ok"}`. Use for Docker healthchecks and load balancer probes.

### Sessions

Sessions hold conversation state across multiple runs.

```
POST /api/sessions
Body: { "model"?: "opus"|"sonnet"|"haiku", "effort"?: "low"|"medium"|"high" }
Response: { "sessionId": "uuid" }
```

```
DELETE /api/sessions/:id
Response: { "ok": true }
```

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

### Memory

```
GET    /api/memory/:namespace          → { content: string | null }
PUT    /api/memory/:namespace          → { ok: true }           Body: { content }
POST   /api/memory/:namespace/append   → { ok: true }           Body: { text }
PATCH  /api/memory/:namespace          → { updated: boolean }   Body: { old, new }
DELETE /api/memory/:namespace?pattern=  → { deleted: number }
```

Namespaces: `knowledge`, `methods`, `project-state`, `learnings`.

### Secrets

Secrets are encrypted at rest with AES-256-GCM via the SecretVault. Values are never returned in responses.

```
GET    /api/secrets              → { names: string[] }
PUT    /api/secrets/:name        → { ok: true }           Body: { value }
DELETE /api/secrets/:name        → { deleted: boolean }
```

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
| **Data access** | Full CRUD (memory, secrets, config, history, tasks) | Read-only memory, task execution only |
| **Streaming** | Real SSE (push) | Polling (1s interval) |
| **Auth** | Bearer token | Bearer token |
| **Port** | 3100 (default) | 3042 (default) |
| **Flag** | `--http-api` | `--mcp-server` |

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
