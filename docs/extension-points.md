# NODYN Extension Points

Extension points allow `nodyn-pro` (or custom plugins) to hook into core functionality without modifying core source code. All extension points are additive — core works standalone without any extensions registered.

## 1. Orchestrator Hooks

Lifecycle hooks for extending the Engine's init, agent creation, run, and shutdown phases.

```typescript
import type { NodynHooks, RunContext } from 'nodyn';

const hooks: NodynHooks = {
  async onInit(engine) {
    // Called after core init (Engine created, memory loaded, WorkerLoop started)
    // Receives Engine (not Nodyn/Session). Use for tenant setup, license validation, etc.
  },

  onBeforeCreateAgent(tools) {
    // Filter or add tools before agent creation
    return tools.filter(t => t.definition.name !== 'restricted_tool');
  },

  onAfterRun(runId, costUsd, context: RunContext) {
    // Called after each run completes
    // context: { runId, contextId, modelTier, durationMs, source }
    // Use for tenant billing, analytics, etc.
  },

  async onShutdown() {
    // Called during shutdown, before DB/vault close
  },
};

engine.registerHooks(hooks);
```

All hook methods are optional. Hook errors are logged to the `costWarning` debug channel instead of silently swallowed.

## 2. CLI Command Registry

Register custom slash commands without modifying the core REPL.

```typescript
import { registerCommand } from 'nodyn';
import type { SlashCommandHandler } from 'nodyn';

const tenantCommand: SlashCommandHandler = async (parts, session, ctx) => {
  const sub = parts[1];
  if (sub === 'list') {
    ctx.stdout.write('Listing tenants...\n');
  }
  return true; // command handled
};

registerCommand('/tenant', tenantCommand);
```

Registered commands are checked before aliases in the REPL dispatch.

## 3. Feature Flags

Register dynamic feature flags for Pro features.

```typescript
import { registerFeature, isFeatureEnabled } from 'nodyn';

registerFeature('advanced-analytics', 'NODYN_FEATURE_ANALYTICS', false);

if (isFeatureEnabled('advanced-analytics')) {
  // Load analytics module
}
```

Core flags (`tenants`, `triggers`, `plugins`, `worker-pool`) are immutable. Dynamic flags are registered at runtime and checked the same way.

## 4. Notification Router

Register custom notification channels for background task results and inquiries.

```typescript
import type { NotificationChannel, NotificationMessage } from 'nodyn';

class SlackNotificationChannel implements NotificationChannel {
  readonly id = 'slack';

  async send(message: NotificationMessage): Promise<void> {
    // Send to Slack via webhook, Socket Mode, etc.
  }

  async handleFollowUp(action: string, taskId: string): Promise<void> {
    // Handle follow-up button clicks (Details, Retry, Explain)
  }
}

engine.notificationRouter.register(new SlackNotificationChannel());
```

The `NotificationRouter` is available on the `Engine` instance after `init()`. Core ships with `TelegramNotificationChannel` (registered automatically when Telegram is configured). Pro can register additional channels (e.g., Slack, email, webhooks).

## Pro Code (Extracted)

Pro code lives in the separate `nodyn-pro` repository. Pro registers externally via the extension points listed above:

- **Tenant CLI** (`/tenant`): Registered via `registerCommand()`.
- **Tenant cost tracking**: Registered as an `onAfterRun` hook via `engine.registerHooks()`.
- **Worker pool lifecycle**: Registered as `onInit`/`onShutdown` hooks via `engine.registerHooks()`.
- **Slack integration**: Lives in `nodyn-pro` as a separate service.

## Registration Pattern

Pro extensions (or custom plugins) register at import time:

```typescript
// nodyn-pro/src/index.ts
import { registerCommand, registerFeature, Engine } from 'nodyn';
import { createTenantHook, createWorkerPoolHook } from 'nodyn';

// Register Pro commands
registerCommand('/tenant', tenantCommand);

// Register Pro feature flags
registerFeature('advanced-analytics', 'NODYN_FEATURE_ANALYTICS', false);
```

Then in the entry point:
```typescript
import 'nodyn-pro'; // side-effect: registers commands, feature flags
import { Engine } from 'nodyn';

const engine = new Engine({});
engine.registerHooks(createTenantHook()); // Reads RunContext.tenantId
engine.registerHooks(createWorkerPoolHook(4));
await engine.init(); // Starts WorkerLoop, NotificationRouter, etc.

const session = engine.createSession({ model: 'sonnet' });
session.tenantId = 'my-tenant'; // Set active tenant for billing
const result = await session.run('Your task here');
```
