# NODYN Extension Points

Extension points allow `nodyn-pro` (or custom plugins) to hook into core functionality without modifying core source code. All extension points are additive — core works standalone without any extensions registered.

## 1. Mode Registry

Register custom operational modes that the ModeController dispatches to.

```typescript
import { ModeController } from 'nodyn/core/mode-controller';
import type { ModeHandler, ModeControllerContext, ModeOrchestrator } from 'nodyn';

const myMode: ModeHandler = {
  async apply(ctx: ModeControllerContext, orchestrator: ModeOrchestrator) {
    // Access mode config
    const { modeConfig } = ctx;

    // Use controller capabilities
    ctx.wrapStreamHandler(orchestrator);
    ctx.setCostGuard(new CostGuard(modeConfig.budget ?? 1.0));

    // Configure agent
    const model = ctx.resolveModel(orchestrator);
    // ...
  },

  async teardown(ctx: ModeControllerContext) {
    // Clean up resources
    ctx.setHeartbeatTimer(null);
    ctx.setShutdownHandler(null);
  },
};

ModeController.registerMode('my-custom-mode', myMode);
```

**ModeControllerContext** exposes:
- `modeConfig` — the active `ModeConfig`
- `wrapStreamHandler(orchestrator)` — attach stream event processing
- `startTriggers(orchestrator, configs)` — start trigger listeners
- `buildPreApproval(orchestrator)` — generate pre-approval patterns
- `resolveModel(orchestrator)` — resolve the model string
- `goalSystemPromptSuffix(goal)` — get goal-aware system prompt suffix
- `setCostGuard/setGoalTracker/setJournal/setHeartbeatTimer/setShutdownHandler` — state setters
- `getShutdownHandler()` — read the current shutdown handler (for chaining)
- `isQuietHours()` — check if quiet hours are active (for daemon heartbeat suppression)
- `registerGoalTools(orchestrator)` — register GoalTracker + goal_update tool in one call
- `appendJournal(entry)` — append a typed entry to the daemon journal (no-op if no journal)
- `requestTeardown()` — trigger async teardown (for graceful shutdown handlers)

## 2. Orchestrator Hooks

Lifecycle hooks for extending Nodyn's init, agent creation, run, and shutdown phases.

```typescript
import type { NodynHooks, RunContext } from 'nodyn';

const hooks: NodynHooks = {
  async onInit(nodyn) {
    // Called after core init (agent created, memory loaded)
    // Use for tenant setup, license validation, etc.
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

nodyn.registerHooks(hooks);
```

All hook methods are optional. Hook errors are logged to the `costWarning` debug channel instead of silently swallowed.

## 3. CLI Command Registry

Register custom slash commands without modifying the core REPL.

```typescript
import { registerCommand } from 'nodyn';
import type { SlashCommandHandler } from 'nodyn';

const tenantCommand: SlashCommandHandler = async (parts, nodyn, ctx) => {
  const sub = parts[1];
  if (sub === 'list') {
    ctx.stdout.write('Listing tenants...\n');
  }
  return true; // command handled
};

registerCommand('/tenant', tenantCommand);
```

Registered commands are checked before aliases in the REPL dispatch.

## 4. Mode Validation

Register additional valid mode names for `--mode` CLI flag and `/mode` command.

```typescript
import { registerValidMode } from 'nodyn';

registerValidMode('my-custom-mode');
// Now `nodyn --mode my-custom-mode` is accepted
```

## 5. Feature Flags

Register dynamic feature flags for Pro features.

```typescript
import { registerFeature, isFeatureEnabled } from 'nodyn';

registerFeature('advanced-analytics', 'NODYN_FEATURE_ANALYTICS', false);

if (isFeatureEnabled('advanced-analytics')) {
  // Load analytics module
}
```

Core flags (`tenants`, `triggers`, `plugins`, `worker-pool`) are immutable. Dynamic flags are registered at runtime and checked the same way.

## Pro Code (Phase 3 — Extracted)

In Phase 2, Pro modes, tenant tracking, and worker pool were wired through extension points inside the core codebase. In Phase 3, this code was extracted to the separate `nodyn-pro` repository. Pro registers the same way externally via the extension points listed above:

- **Pro modes** (`sentinel`, `daemon`, `swarm`): Registered via `ModeController.registerMode()`.
- **Tenant CLI** (`/tenant`): Registered via `registerCommand()`.
- **Tenant cost tracking**: Registered as an `onAfterRun` hook via `nodyn.registerHooks()`.
- **Worker pool lifecycle**: Registered as `onInit`/`onShutdown` hooks via `nodyn.registerHooks()`.
- **Slack integration**: Lives in `nodyn-pro` as a separate service.

## Registration Pattern

Pro extensions (or custom plugins) register at import time:

```typescript
// nodyn-pro/src/index.ts
import { ModeController, registerCommand, registerValidMode, registerFeature } from 'nodyn';
import { createTenantHook, createWorkerPoolHook } from 'nodyn';

// Register Pro modes
ModeController.registerMode('sentinel', sentinelHandler);
ModeController.registerMode('daemon', daemonHandler);
ModeController.registerMode('swarm', swarmHandler);

// Register Pro commands
registerCommand('/tenant', tenantCommand);

// Register Pro modes as valid
registerValidMode('sentinel');
registerValidMode('daemon');
registerValidMode('swarm');

// Register Pro feature flags
registerFeature('advanced-analytics', 'NODYN_FEATURE_ANALYTICS', false);
```

Then in the entry point:
```typescript
import 'nodyn-pro'; // side-effect: registers all extensions
import { Nodyn } from 'nodyn';

const nodyn = new Nodyn({});
nodyn.tenantId = 'my-tenant'; // Set active tenant for billing
nodyn.registerHooks(createTenantHook()); // Reads RunContext.tenantId
nodyn.registerHooks(createWorkerPoolHook(4));
await nodyn.init();
```
