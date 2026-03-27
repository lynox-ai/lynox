---
title: "Error Reporting"
description: "Opt-in Sentry integration with PII protection"
sidebar:
  order: 12
---

lynox includes opt-in error reporting to help improve the product. When enabled, crashes and errors are captured automatically — without sending your messages, files, knowledge, or personal data.

## How to Enable

**The easy way:** After your first successful task via Telegram, lynox asks if you'd like to help improve the product. Tap "Yes" — done.

**Manual setup:** Add to your server's `~/.lynox/.env`:

```bash
LYNOX_SENTRY_DSN=https://key@org.ingest.de.sentry.io/id
```

Without a DSN, error reporting is completely inactive — zero overhead, no code loaded.

### What is sent

- Error type and stack trace
- lynox version and Node.js version
- Which tool was running when the error occurred

### What is never sent

- Your messages, prompts, or AI responses
- Files, documents, or images
- Knowledge graph content
- API keys, tokens, or credentials
- Any personal or business data

All data is processed in the EU (Frankfurt) for GDPR compliance.

### How to disable

Remove `LYNOX_SENTRY_DSN` from your `~/.lynox/.env` file and restart lynox.

---

## Self-Hosted Sentry (Advanced)

If you want error reports sent to your own Sentry instance instead:

### 3. Docker

```bash
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LYNOX_SENTRY_DSN=https://key@org.ingest.de.sentry.io/id \
  -v ~/.lynox:/home/lynox/.lynox \
  lynox
```

## What Gets Captured

### Automatic (no user action needed)

| Data | Details |
|------|---------|
| **Crashes** | `uncaughtException`, `unhandledRejection` — full stack trace |
| **LynoxError hierarchy** | Error code, type, safe context keys (tool name, run ID, session ID) |
| **Tool breadcrumbs** | Tool name, success/failure, duration — NO input data |
| **LLM breadcrumbs** | Model name, input/output token counts — NO prompt content |
| **WorkerLoop failures** | Background task ID, type, error message |
| **Release tracking** | `lynox@1.0.0` — see which version caused which errors |

### User-initiated (via /bug command)

Telegram users can report issues with `/bug Something went wrong`:

```
/bug The summary was completely wrong
/bug Tool keeps timing out on large files
```

The report is sent to Sentry as user feedback, linked to the latest error event.

## What Is NOT Captured (PII Protection)

| Data | Protection |
|------|------------|
| User prompts | Never sent — stripped by `beforeBreadcrumb` and `beforeSend` |
| AI responses | Never sent |
| File contents | Never sent |
| API keys / secrets | Never sent |
| HTTP request bodies | Stripped by `beforeSend` |
| LynoxError context | Allowlisted keys only (`toolName`, `runId`, `sessionId`, etc.) |
| Performance traces | Disabled (`tracesSampleRate: 0`) |

The `beforeBreadcrumb` hook strips `prompt`, `response`, `content`, and `message` fields from all breadcrumbs. The `beforeSend` hook strips `request.data` from all events.

## Architecture

```
Engine.init()
    │
    ├─ initSentry(dsn)          // Dynamic import, cached module ref
    ├─ installGlobalHandlers()  // uncaughtException, unhandledRejection
    └─ subscribe(toolEnd)       // Automatic tool breadcrumbs via diagnostics_channel
        │
Session.run()
    ├─ streamHandler            // LLM breadcrumbs (model + tokens)
    └─ catch                    // captureLynoxError() or captureError()
        │
WorkerLoop.executeTask()
    └─ catch                    // captureError() with task tags
        │
Engine.shutdown()
    └─ shutdownSentry()         // flush(5s) + close()
```

All Sentry calls are fire-and-forget — errors in Sentry itself never affect lynox operation.

## Alerts

Sentry has built-in alerting. Configure in your Sentry project under **Alerts**:

- **Email** (default) — immediate notifications for new issues
- **Slack/Teams** — via Sentry integrations
- **Weekly digest** — summary of error trends

No custom Telegram or webhook integration is needed — Sentry handles notification routing.

## SDK Usage

When using lynox as a library, you can initialize Sentry yourself or let the Engine handle it:

```typescript
import { Engine } from '@lynox-ai/core';

// Option 1: Via config (Engine handles init)
const engine = new Engine({ });
// Set LYNOX_SENTRY_DSN env var or sentry_dsn in config
await engine.init();

// Option 2: Direct API
import { initSentry, captureError, addToolBreadcrumb } from '@lynox-ai/core';

await initSentry('https://key@org.ingest.de.sentry.io/id');
// Now all errors in Session.run() are automatically captured

// Manual breadcrumbs (optional)
addToolBreadcrumb('my-tool', true, 250);
```

## Self-Hosted Sentry

lynox works with self-hosted Sentry instances. Point the DSN to your server:

```bash
LYNOX_SENTRY_DSN=https://key@sentry.yourcompany.com/id
```

No code changes needed — the DSN determines the destination.

## Dependency

`@sentry/node` is a regular dependency (BSD-3-Clause, compatible with ELv2). It is only imported when a DSN is configured — no overhead for users who don't enable Sentry.
