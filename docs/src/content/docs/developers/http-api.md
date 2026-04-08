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
GET    /api/sessions/:id/pending-prompt  # Check for a resumable prompt
POST   /api/sessions/:id/reply   # Reply to a pending prompt
POST   /api/sessions/:id/abort   # Abort a running task
POST   /api/sessions/:id/compact # Compact context window
```

#### Running a task (SSE)

```bash
curl -N -X POST http://localhost:3000/api/sessions/{id}/run \
  -H "Content-Type: application/json" \
  -d '{"task": "What is the weather in Munich?"}'
```

The response is a Server-Sent Events stream with these event types:

| Event | Description |
|-------|-------------|
| `text` | Streamed response text chunk |
| `thinking` | Extended thinking summary |
| `tool_call` | Tool invocation (name, input) |
| `tool_result` | Tool result (output, success) |
| `prompt` | Agent requests user input (`ask_user`). Includes `promptId` for resumable prompts |
| `secret_prompt` | Agent requests a secret (`ask_secret`). Includes `promptId` |
| `turn_end` | Turn completed |
| `changeset_ready` | File changes pending review (accept/rollback) |
| `done` | Run completed |
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

### Resumable Prompts

Prompts (`ask_user` and `ask_secret`) are persisted in SQLite and survive SSE disconnects, page refreshes, and thread switches. The agent polls the database for answers instead of holding an in-memory callback.

#### Flow

1. Agent calls `ask_user` or `ask_secret` → prompt written to SQLite with a `promptId`
2. SSE event sent to client (best-effort — client may not be connected)
3. Agent polls SQLite every 2s for an answer
4. If client disconnects, the agent loop stays alive (polling is near-zero CPU)
5. Client reconnects → `GET /api/sessions/:id/pending-prompt` → sees the prompt
6. Client replies → `POST /api/sessions/:id/reply` with `promptId` → answer written to SQLite
7. Agent picks up answer on next poll → resumes execution

Prompts expire after 24 hours. On engine restart, all pending prompts are expired.

#### Checking for pending prompts

```bash
GET /api/sessions/:id/pending-prompt
```

Returns `{"pending": false}` or the full prompt data:

```json
{
  "pending": true,
  "promptId": "uuid",
  "promptType": "ask_user",
  "question": "Shall I create the task?",
  "options": ["Yes", "No"],
  "timeoutMs": 86400000,
  "createdAt": "2026-04-03T23:30:00Z"
}
```

#### Replying to prompts

Include `promptId` for idempotent replies (prevents double-answer race conditions):

```bash
POST /api/sessions/:id/reply
Body: {"answer": "Yes", "promptId": "uuid"}
```

### Secret Prompt (SSE)

During a run, the agent may request a secret via the `ask_secret` tool. This triggers a `secret_prompt` SSE event:

```
event: secret_prompt
data: {"promptId":"uuid","name":"STRIPE_API_KEY","prompt":"Enter your Stripe API key","key_type":"stripe"}
```

The client stores the secret directly via `PUT /api/secrets/:name` (the value never enters the SSE stream), then confirms:

```
POST /api/sessions/:id/secret-saved
Body: {"saved": true, "promptId": "uuid"}
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
GET /api/crm/contacts/:name/interactions  # Contact history
GET /api/crm/contacts/:name/deals # Contact deals
GET /api/crm/deals                # List deals
GET /api/crm/stats                # CRM statistics
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

### Pipelines

```
GET  /api/pipelines               # List pipeline runs
GET  /api/pipelines/:id           # Pipeline details
GET  /api/pipelines/:id/steps     # Pipeline step results
GET  /api/pipelines/stats/steps   # Step statistics
GET  /api/pipelines/stats/cost    # Pipeline cost stats
```

### DataStore

```
GET  /api/datastore/collections   # DataStore collections
GET  /api/datastore/:collection   # Collection records
```

### Vault

```
GET  /api/vault/key               # Retrieve vault key
POST /api/vault/rotate            # Rotate vault key
```

### Other

```
POST /api/transcribe              # Transcribe audio (base64)
GET  /api/thread-insights         # Thread analytics
GET  /api/patterns                # Detected patterns
GET  /api/metrics                 # Metrics data
GET  /api/api-profiles            # API Store profiles
GET  /api/api-profiles/:id        # Individual API profile
GET  /api/export                  # GDPR data export (Art. 15 + Art. 20)
GET  /api/auth/token              # Generate auth token
POST /api/google/reload           # Reload Google integration
POST /api/searxng/check           # SearXNG health validation
POST /api/sessions/:id/changeset/review  # Accept/rollback file changes
GET  /api/sessions/:id/changeset  # Pending file changes
```
