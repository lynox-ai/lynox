---
title: HTTP API
description: REST + SSE API reference for building on lynox.
sidebar:
  order: 2
---

The Engine HTTP API powers the Web UI and can be used to build custom integrations. It's a REST API with Server-Sent Events (SSE) for streaming responses.

## Base URL

```
http://localhost:3000/api
```

When running the Web UI image, the API is proxied through SvelteKit. When running `--http-api` only, it defaults to port 3100.

## Authentication

In single-user mode (default), no authentication is required. The API is intended for local use only.

:::caution
Do not expose the API to the public internet without adding authentication. The lynox Pro cloud shell adds multi-user auth.
:::

## Endpoints

### Health

```
GET /health
GET /api/health
```

Returns `{"status":"ok"}`. No auth required, useful for Docker health checks.

### Sessions

```
POST   /api/sessions              # Create a new session
DELETE /api/sessions/:id          # Delete a session
POST   /api/sessions/:id/run     # Run a task (SSE streaming response)
POST   /api/sessions/:id/reply   # Reply to a pending prompt
POST   /api/sessions/:id/abort   # Abort a running task
POST   /api/sessions/:id/compact # Compact context window
```

#### Running a task (SSE)

```bash
curl -N -X POST http://localhost:3000/api/sessions/{id}/run \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the weather in Munich?"}'
```

The response is a Server-Sent Events stream with these event types:

| Event | Description |
|-------|-------------|
| `text` | Streamed response text chunk |
| `thinking` | Extended thinking summary |
| `tool_call` | Tool invocation (name, input) |
| `tool_result` | Tool result (output, success) |
| `turn_end` | Turn completed |
| `error` | Error occurred |

### Threads

```
GET    /api/threads               # List threads
GET    /api/threads/:id           # Get thread details
PATCH  /api/threads/:id           # Update (rename, archive)
DELETE /api/threads/:id           # Delete thread
GET    /api/threads/:id/messages  # Get messages (supports pagination)
```

### Memory

```
GET    /api/memory/:ns            # Read namespace (knowledge|methods|status|learnings)
PUT    /api/memory/:ns            # Replace namespace content
POST   /api/memory/:ns/append     # Append to namespace
PATCH  /api/memory/:ns            # Update (old/new text)
DELETE /api/memory/:ns            # Delete entries (pattern query param)
```

### Secrets

```
GET    /api/secrets               # List secret names
GET    /api/secrets/status        # Secret status overview
PUT    /api/secrets/:name         # Store a secret
DELETE /api/secrets/:name         # Delete a secret
```

### Secret Prompt (SSE)

During a run, the agent may request a secret via the `ask_secret` tool. This triggers a `secret_prompt` SSE event:

```
event: secret_prompt
data: {"name":"STRIPE_API_KEY","prompt":"Enter your Stripe API key","key_type":"stripe"}
```

The client stores the secret directly via `PUT /api/secrets/:name` (the value never enters the SSE stream), then confirms:

```
POST /api/sessions/:id/secret-saved
Body: {"saved": true}   # or false if canceled
```

### Config

```
GET /api/config                   # Get config (secrets redacted)
PUT /api/config                   # Update config
```

### History & Analytics

```
GET /api/history/runs             # List runs (filterable)
GET /api/history/runs/:id         # Run details
GET /api/history/runs/:id/tool-calls  # Tool calls for a run
GET /api/history/stats            # Aggregated statistics
GET /api/history/cost/daily       # Daily cost breakdown
```

### Knowledge Graph

```
GET /api/kg/stats                 # Graph statistics
GET /api/kg/entities              # List/search entities
GET /api/kg/entities/:id          # Entity details + relations
```

### Tasks

```
GET    /api/tasks                 # List tasks
POST   /api/tasks                 # Create task
PATCH  /api/tasks/:id             # Update task
DELETE /api/tasks/:id             # Delete task
POST   /api/tasks/:id/complete    # Mark complete
```

### Artifacts

```
GET    /api/artifacts             # List artifacts
POST   /api/artifacts             # Save artifact
GET    /api/artifacts/:id         # Get artifact
DELETE /api/artifacts/:id         # Delete artifact
```

### CRM

```
GET /api/crm/contacts             # List contacts
GET /api/crm/deals                # List deals
GET /api/crm/stats                # CRM statistics
GET /api/crm/contacts/:name/interactions  # Contact history
```

### Integrations

```
POST   /api/telegram/setup        # Start Telegram setup
GET    /api/telegram/setup        # Poll setup status
DELETE /api/telegram/setup        # Cancel setup

GET    /api/google/status         # Google auth status
POST   /api/google/auth           # Start device flow
POST   /api/google/revoke         # Revoke auth
```

### Backups

```
GET  /api/backups                 # List backups
POST /api/backups                 # Create backup
POST /api/backups/:id/restore     # Restore backup
```

### Files

```
GET    /api/files                 # List directory
GET    /api/files/download        # Download file
GET    /api/files/read            # Read file preview (max 1 MB)
DELETE /api/files                 # Delete file
```

### Other

```
POST /api/transcribe              # Transcribe audio (base64)
GET  /api/pipelines               # List pipeline runs
GET  /api/pipelines/:id           # Pipeline details
GET  /api/thread-insights         # Thread analytics
GET  /api/patterns                # Detected patterns
GET  /api/metrics                 # Metrics data
GET  /api/api-profiles            # API Store profiles
GET  /api/datastore/collections   # DataStore collections
POST /api/vault/rotate            # Rotate vault key
```
