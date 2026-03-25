# Architecture

## High-Level Overview

```
                         ┌─────────────────────────┐
                         │  CLI / Telegram / MCP    │
                         │   (src/index.ts)         │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │     Engine (singleton)    │
                         │   (src/core/engine.ts)    │
                         │  KG, Memory, DataStore,   │
                         │  Secrets, Config, Tools,  │
                         │  WorkerLoop, Notifier     │
                         └──┬──────┬──────┬──────┬──┘
                            │      │      │      │
                    ┌───────▼──────▼──────▼──────▼────┐
                    │   Session (per-conversation)     │
                    │   (src/core/session.ts)          │
                    │   Agent, messages, mode,         │
                    │   callbacks, run tracking        │
                    └──────────────┬───────────────────┘
                                   │
                          ┌────────▼────────┐
                          │ StreamProcessor │
                          │   (stream)      │
                          └────────┬────────┘
                                   │
                       ┌───────────▼───────────┐
                       │    Anthropic SDK      │
                       │  (beta messages API)  │
                       └───────────────────────┘
```

## Module Map

### `src/types/index.ts` -- Type System

Single source of truth for all types. Contains:

- `ModelTier`, `MODEL_MAP`, `CONTEXT_WINDOW` -- model tier definitions
- `ThinkingMode`, `EffortLevel` -- reasoning / accuracy configuration
- `ToolEntry`, `ToolHandler` -- tool contract
- `StreamEvent`, `StreamHandler` -- event union (includes `trigger`, `cost_warning`, `continuation`, `advice`)
- `IAgent`, `IMemory`, `IWorkerPool` -- core interfaces
- `AgentConfig`, `NodynConfig`, `NodynUserConfig`, `MCPServer` -- configuration
- `ChangesetEntry`, `ChangesetDiff`, `ChangesetResult`, `ChangesetManagerLike` -- changeset review types
- `SpawnSpec`, `BatchRequest`, `BatchResult` -- operation types (SpawnSpec includes `role`, `context`, `isolated_memory`)
- `Role`, `ToolScopeConfig` -- role-based agent configuration
- `TriggerConfig`, `ITrigger` -- triggers
- `NODYN_BETAS` -- beta header array
- `ALL_NAMESPACES` -- canonical list of all `MemoryNamespace` values (shared by knowledge system, knowledge-gc, knowledge tools)
- `TaskRecord`, `TaskStatus`, `TaskPriority` -- task management types. Task types: `manual`, `scheduled`, `watch`, `pipeline`
- `InlinePipelineStep` includes `role` field -- connects roles to DAG workflow steps
- `IsolationConfig`, `IsolationLevel` -- context isolation configuration (used by Pro tenant system)
- `MODEL_TIER_SET`, `EFFORT_LEVEL_SET`, `AUTONOMY_LEVEL_SET`, `SCOPE_TYPE_SET`, `OUTPUT_FORMAT_SET` -- centralized validation sets (never redeclare locally)

### `src/types/schemas.ts` -- Zod Schemas

Runtime validation schemas for JSON-serializable config types. Used where untrusted JSON is parsed:

- `RoleSchema` -- validates role JSON files (used by `parseRoleConfig()`)
- `NodynUserConfigSchema` -- validates `config.json` files (used by `readConfigFile()`)
- `TenantConfig`, `TenantStatus` -- tenant lifecycle and budget types (used by Pro tenant system)

### `src/core/` -- Core Engine

| Module | Class | Purpose |
|--------|-------|---------|
| `agent.ts` | `Agent` | Agentic loop with streaming, tool dispatch, permission checks, retry with backoff, knowledge context support (`setKnowledgeContext()`) |
| `stream.ts` | `StreamProcessor` | Assembles stream deltas into content blocks, emits `StreamEvent`s |
| `memory.ts` | `Memory` | Context-scoped local file storage in `~/.nodyn/memory/<contextId>/` with global fallback, `hasContent()`, publishes to `nodyn:memory:store`. Unified scope-keyed cache (`${type}:${id}:${ns}`) covers global, project, and user scopes |
| `engine.ts` | `Engine` | Shared singleton per process. Owns KG, Memory, DataStore, Secrets, Config, ToolRegistry, WorkerLoop, NotificationRouter. `init()` once, then `createSession()` for per-conversation state. `NodynHooks.onAfterRun` receives `RunContext` (includes `runId`, `contextId`, `modelTier`, `durationMs`, `source`, `tenantId?`). Hook errors logged to `costWarning` debug channel |
| `session.ts` | `Session` | Per-conversation state created via `engine.createSession()`. Implements `ModeOrchestrator`. Owns Agent, messages, mode, callbacks, run tracking. Entry point for `run()`, `batch()`, `shutdown()`. Per-session config isolation: `setModel()`, `setEffort()`, `setThinking()` mutate session-local fields, not `engine.config`. `SessionOptions`: `model`, `effort`, `thinking`, `autonomy`, `briefing`, `systemPromptSuffix` |
| `orchestrator.ts` | -- | Thin re-export shim for backward compatibility -- re-exports Engine + Session as `Nodyn` facade. Existing consumers continue to work without changes |
| `session-store.ts` | `SessionStore` | Multi-turn MCP session management |
| `batch-index.ts` | `BatchIndex` | Persists batch metadata to `~/.nodyn/batch-index.json` |
| `utils.ts` | -- | Shared utilities: `sleep()`, `getErrorMessage()`, `sha256Short()` (used by prompt-hash, run-history, project) |
| `observability.ts` | -- | `node:diagnostics_channel` + `node:perf_hooks` instrumentation (includes `nodyn:memory:store` channel) |
| `config.ts` | -- | 3-tier config merge (env > project > user), `PROJECT_SAFE_KEYS` allowlist, `getNodynDir()` canonical `~/.nodyn` path, parse error warning to stderr |
| `run-history.ts` | `RunHistory` | SQLite via `better-sqlite3` (WAL mode, 19 migrations) at `~/.nodyn/history.db`. Delegates analytics to `run-history-analytics.ts` (9 query functions) and domain persistence to `run-history-persistence.ts` (44 functions). Tables: runs, tool_calls, spawns, prompt_snapshots, pre_approval, pipelines, scopes, tasks, security_events, processes |
| `process-capture.ts` | -- | Extracts ProcessRecord from run_history tool calls. Haiku call for step naming + parameter identification. Sanitizes secrets, filters internal tools |
| `pricing.ts` | -- | Shared pricing table with `calculateCost()`, cache token support, optional JSON override |
| `project.ts` | -- | `detectProjectRoot()`, `generateBriefing()`, `buildFileManifest()` + `diffManifest()` |
| `prompt-hash.ts` | -- | SHA-256 prompt versioning via `sha256Short()` from utils |
| `embedding.ts` | `EmbeddingProvider` | Interface with `OnnxProvider` (model registry: multilingual-e5-small default 384d, all-minilm-l6-v2, bge-m3), `VoyageProvider` (HTTP, 1024d), `LocalProvider` (test-only), cosine similarity, BLOB serialization |
| `knowledge-graph.ts` | `KuzuGraph` | LadybugDB (Kuzu fork) embedded graph wrapper. Schema: Entity/Memory/Community nodes, MENTIONS/RELATES_TO/SUPERSEDES/COOCCURS edges. Cypher queries, similarity search, entity CRUD |
| `knowledge-layer.ts` | `KnowledgeLayer` | Unified `IKnowledgeLayer` implementation: store (embed + dedup + contradiction + entity extraction + graph write), retrieve (HyDE + vector + graph expansion + MMR), entity ops, GC |
| `retrieval-engine.ts` | `RetrievalEngine` | Graph-augmented retrieval: HyDE query expansion (Haiku), multi-signal search (vector 55% + FTS 30% + graph 15%), namespace-specific decay, MMR re-ranking (λ=0.7), XML context formatting |
| `entity-extractor.ts` | -- | Two-tier entity extraction: Tier 1 regex (DE/EN persons, orgs, tech, projects, locations), Tier 2 optional Haiku for high-value namespaces |
| `entity-resolver.ts` | `EntityResolver` | Canonical name resolution (exact → alias → normalized → create), entity merge with alias transfer |
| `contradiction-detector.ts` | -- | Contradiction detection for knowledge/learnings: vector search >0.80 → heuristic checks (negation DE/EN, number change, state change) |
| `datastore-bridge.ts` | `DataStoreBridge` | Connects DataStore tables to Knowledge Graph. `registerCollection()` creates collection entities, `indexRecords()` extracts entities from string fields via regex, `findRelatedData()` provides DataStore hints during retrieval. Entity type `'collection'`, relation type `has_data_in` |
| `roles.ts` | -- | 4 built-in roles as a const map (researcher, creator, operator, collector). No file-based CRUD. Roles define sub-agent tool restrictions, model defaults, and system prompts (compressed single-paragraph format) |
| `plugins.ts` | `PluginManager` | Validated `import()` from `~/.nodyn/plugins/node_modules/` only, `NPM_NAME_RE`, secrets stripped, lifecycle hooks |
| `features.ts` | -- | Feature flags (`NODYN_FEATURE_*` env vars), dynamic registration via `registerFeature()` for Pro |
| `cost-guard.ts` | `CostGuard` | Budget tracking + enforcement, cache tokens at correct rates (write 1.25x, read 0.1x) |
| `pre-approve.ts` | -- | Glob-based pattern matching for auto-approving operations in autonomous modes |
| `pre-approve-audit.ts` | `PreApproveAudit` | SQLite audit trail for pre-approval decisions |
| `task-manager.ts` | `TaskManager` | Task CRUD facade over RunHistory. Week summaries, briefing integration, scope-aware queries |
| `changeset.ts` | `ChangesetManager` | Backup-before-write system: copies originals to temp dir, generates unified diffs via `diff -u`, supports full/partial rollback. Created per-run by Session when `changeset_review` enabled |
| `worker-loop.ts` | `WorkerLoop` | Persistent background task executor. 60s tick interval, headless Sessions per task, `AbortSignal.timeout(5min)` per execution, `AsyncLocalStorage` per task for isolated context. Multi-turn support: wires `promptUser` on headless sessions so agent can `ask_user` — question sent as notification — promise-based pause/resume via `ActiveTask.pendingInput`. One-shot background tasks auto-trigger (`nextRunAt=now` when `assignee='nodyn'`). Retry with exponential backoff (1min to 30min cap). Calls `runManifest()` for pipeline tasks (`pipeline_id` set). Started on `engine.init()`, stopped on `engine.shutdown()` |
| `cron-parser.ts` | -- | 5-field standard cron expression parser + shorthand interval syntax (e.g. `every 5 minutes`). Pure function, no external dependencies. Used by WorkerLoop for scheduled task due-time calculation |
| `notification-router.ts` | `NotificationRouter` | Pluggable notification channel system. Registers `NotificationChannel` implementations, routes `NotificationMessage` to appropriate channels. Supports task completion, error, and inquiry notifications. Follow-up buttons on task completion (Details, Run again / Retry, Explain). Extension point for custom channels |
| `telegram-notification.ts` | `TelegramNotificationChannel` | Implements `NotificationChannel` for Telegram. Sends task results with inline follow-up buttons, handles inquiry responses for multi-turn tasks. Callback prefixes: `'t:'` for follow-ups, `'q:'` for inquiry responses. Integrates with `ActiveTask.pendingInput` for pause/resume |
| `workspace.ts` | -- | Workspace isolation for Docker: path validation, sandbox boundaries |
| `tool-context.ts` | -- | `ToolContext` interface — shared dependency container for tool handlers. Replaces module-level closure setters. Created by Session, passed via `agent.toolContext`. `createToolContext()` factory, `applyNetworkPolicy()`, `applyHttpRateLimits()` helpers |
| `errors.ts` | `NodynError` | Centralized error hierarchy: `NodynError` (base with `code` + `context`), `ValidationError`, `ConfigError`, `ExecutionError` (supports `Error.cause`), `ToolError`, `NotFoundError`. Business-friendly error codes |
| `input-guard.ts` | -- | Content policy — scans user input before LLM (Tier 1 hard block + Tier 2 soft flag) |
| `data-boundary.ts` | -- | Prompt injection defense: `wrapUntrustedData()` with boundary-escape neutralization, `detectInjectionAttempt()` for 17 patterns (12 categories), `escapeXml()`. Applied to web search, HTTP, Google tools, spawn context, pipeline templates, memory extraction, briefing |
| `output-guard.ts` | -- | Output validation: reverse shell, crypto miner, persistence mechanism detection. `scanToolResult()` for 8 external tools (bash, http_request, web_research, 5 Google tools). `ToolCallTracker` behavioral anomaly detection (read→exfil, burst HTTP, Google read→exfil, credential harvesting) |
| `security-audit.ts` | -- | Security event persistence to `security_events` SQLite table, secret masking |
| `scope-resolver.ts` | -- | 3-tier scope hierarchy (Global 0.3 > Context 0.8 > User 1.0). `inferScopeFromContext()` |
| `scope-classifier.ts` | -- | Heuristic scope classification (no API call), multilingual (DE/EN/FR) |
| `data-store.ts` | `DataStore` | SQLite-based structured data storage (`~/.nodyn/datastore.db`). Agent-defined collections, filter→SQL, aggregation, upsert |
| `secret-vault.ts` | `SecretVault` | Encrypted SQLite vault (`~/.nodyn/vault.db`), AES-256-GCM, PBKDF2 600K SHA-512 |
| `secret-store.ts` | `SecretStore` | Multi-source secrets: env (`NODYN_SECRET_*`) > vault > config. `extractSecretNames()` + `resolveSecretRefs()` |
| `session-budget.ts` | -- | $50 session cost ceiling shared by spawn + pipeline, daily/monthly persistent caps |
| `atomic-write.ts` | -- | Sync + async `ensureDir()` with secure permissions (`0o700`/`0o600`) |
| `constants.ts` | -- | Shared numeric constants: `MAX_BUFFER_BYTES`, `DIR_MODE_PRIVATE`, `FILE_MODE_PRIVATE`, `DEFAULT_BASH_TIMEOUT_MS` |
| `crypto-constants.ts` | -- | AES-256-GCM constants: `CRYPTO_ALGORITHM`, `CRYPTO_KEY_LENGTH`, `CRYPTO_IV_LENGTH`, `CRYPTO_TAG_LENGTH` |
| `debug-subscriber.ts` | -- | Debug channel subscriber for `NODYN_DEBUG` output |

### `src/core/triggers/` -- Trigger System

| Module | Class | Purpose |
|--------|-------|---------|
| `file-trigger.ts` | `FileTrigger` | `fs.watch` + glob matching + debounce, with full tree fallback when recursive watch is unavailable |

> **Note:** `http-trigger.ts`, `cron-trigger.ts`, and `git-trigger.ts` have been removed. Cron scheduling is now handled by `WorkerLoop` + `cron-parser.ts`. Only `file-trigger` remains for filesystem watching (used by CLI `--watch` and `watchdog.ts`).

### `src/tools/` -- Tool System

| Module | Purpose |
|--------|---------|
| `registry.ts` | `ToolRegistry` with `register()`, `registerMCP()`, `find()`, `scopedView()` |
| `permission-guard.ts` | `isDangerous()` -- bash pattern + sensitive path checks, `autonomy` levels, pre-approval integration |
| `builtin/bash.ts` | Shell execution (120s timeout, 10MB buffer) |
| `builtin/fs.ts` | `read_file` + `write_file` with symlink resolution |
| `builtin/memory.ts` | `memory_store` + `memory_recall` (knowledge system) |
| `builtin/spawn.ts` | Sub-agent spawning with role resolution, tool scoping, context injection, recursion guard |
| `builtin/ask-user.ts` | Interactive prompting (select/confirm/freeform/tabbed) |
| `builtin/batch-files.ts` | Glob-based rename/move/transform |
| `builtin/http.ts` | HTTP requests with SSRF protection |
| `builtin/pipeline.ts` | `run_pipeline` — inline or stored workflow execution with parallel phases |
| `builtin/task.ts` | `task_create`, `task_update`, `task_list` with scope validation |
| `builtin/plan-task.ts` | `plan_task` — phased plan with workflow bridge. Auto-converts approved phases to workflow via `phasesToPipelineSteps()` |
| `builtin/process.ts` | `capture_process` + `promote_process` — structured process capture from run_history, converts to parameterized workflows |
| `resolve-tools.ts` | Shared `resolveTools()` — 3-tier tool resolution (explicit > role > parent) |

### `src/cli/` -- CLI Interface

| Module | Purpose |
|--------|---------|
| `ansi.ts` | Centralized ANSI constants, `stripAnsi()`, `wordWrap()`, `TBL` box-drawing characters (shared by ui.ts and markdown.ts) |
| `ui.ts` | ANSI banner, styled renders (tool calls, errors, warnings, thinking) |
| `spinner.ts` | Braille spinner on stderr, `updateLabel()` for dynamic label changes |
| `markdown.ts` | Streaming markdown-to-ANSI renderer (bold, italic, code, headers, lists, tables, blockquotes, links, strikethrough) |
| `dialog.ts` | Interactive prompts (select, confirm, freeform, tabbed) |
| `diff.ts` | LCS-based line diff with red/green coloring, hunk-based output |
| `footer.ts` | Inline status line (tokens, context bar, cache %) |
| `watchdog.ts` | File change monitoring via `FileTrigger` |
| `profiles.ts` | Profile CRUD from `~/.nodyn/profiles/` |
| `setup-wizard.ts` | First-run wizard: API key (format + live validation), model tier, optional Telegram |
| `approval-dialog.ts` | 3-tab pre-approval dialog (summary, risk filter, limits) |
| `changeset-review.ts` | Post-run changeset review UI: colored unified diffs, Accept/Rollback/Partial flow via single keypress |

### `src/orchestrator/` -- DAG Engine

| Module | Purpose |
|--------|---------|
| `types.ts` | `Manifest`, `ManifestStep` (includes `role` field), `AgentDef`, `AgentOutput`, `RunState`, `RunHooks`, `GateAdapter`, `GateDecision`, `GateRejectedError`, `GateExpiredError` |
| `validate.ts` | `validateManifest()` + `loadManifestFile()` via Zod v4 |
| `conditions.ts` | `shouldRunStep()`, `evaluateCondition()`, `getByPath()` — 7 operators (lt/gt/eq/gte/lte/exists/not_exists) |
| `context.ts` | `buildStepContext()` — merges global context + `input_from` step outputs |
| `agent-registry.ts` | `loadAgentDef()` — dynamic ES module import with `SAFE_AGENT_NAME_RE` path guard |
| `gates.ts` | `LocalGateAdapter` (prompt-fn) |
| `runtime-adapter.ts` | `convertAgentTools()`, `wrapWithGate()`, `spawnViaAgent()`, `spawnInline()` (with role support), `spawnPipeline()` (propagates `role`), `spawnMock()` |
| `runner.ts` | `runManifest()` — sequential DAG loop with conditions, gates, failure strategy |

See [DAG Engine](dag-engine.md) for full documentation.

### `src/integrations/telegram/` -- Telegram Bot

In-process Telegram bot using Telegraf. Connects directly to `session.run()` (no MCP needed). Three modules: `telegram-bot.ts` (Telegraf setup, message routing, commands), `telegram-runner.ts` (run lifecycle, stream handling, status edits), `telegram-formatter.ts` (markdown→HTML, message splitting, inline keyboards). Also serves as a notification channel for background tasks via `TelegramNotificationChannel` (registered with `NotificationRouter`).

### `src/server/mcp-server.ts` -- MCP Server

Exposes NODYN as an MCP server with stdio and HTTP transport. Uses `Engine` internally — `SessionStore` holds per-session `Session` instances (not raw Agents). Includes async run polling with cursor-based event log, reply/abort flow, file attachments, buffered output limits, and persisted async run state for restart-resilient polling.

### `src/index.ts` -- Entry Point

Module re-exports (Engine, Session, WorkerLoop, NotificationRouter, TelegramNotificationChannel, NotificationChannel, NotificationMessage) + CLI REPL with interactive dialog, streaming, session management, slash commands. Extension points: `registerCommand()` for Pro slash commands.

## Data Flow

```
User Input
    │
    ▼
Session.run(task)                   (Session created via engine.createSession())
    │
    ├──► loadConfig() ──► 3-tier merge (env > project > user)
    ├──► detectProjectRoot() ──► project ID (SHA-256)
    ├──► generateBriefing() ──► last 3-5 runs
    ├──► KnowledgeLayer.retrieve() ──► agent.setKnowledgeContext()
    │
    ▼
Agent.send(userMessage)
    │
    ├──► _callAPI() ──► Anthropic SDK (streaming)
    │         │              │
    │         │         StreamProcessor
    │         │              │
    │         │         StreamEvents ──► CLI renders
    │         │
    │         ├──► retry on 429/529/5xx (3 retries, exponential backoff)
    │
    ├──► stop_reason: "tool_use"
    │        │
    │        ▼
    │    _dispatchTools() ──► Promise.allSettled()
    │        │                    │
    │        │              WorkerPool (bash, fs)
    │        │              or direct handler
    │        │
    │        ▼
    │    tool_result ──► next iteration
    │
    ├──► stop_reason: "max_tokens" + continuationPrompt
    │        │
    │        ▼
    │    auto-continue (up to MAX_CONTINUATIONS per model: Opus 20, Sonnet 10, Haiku 5)
    │
    └──► stop_reason: "end_turn"
             │
             ├──► Memory.maybeUpdate() (fire-and-forget) → nodyn:memory:store channel
             ├──► RunHistory.updateRun() (cost, tokens, status)
             ├──► storeKnowledgeEmbedding() (bounded queue, max 3 concurrent, errors logged)
             │
             ▼
         Return text response
```

## Key Design Decisions

- **ESM-only**: All imports use `.js` extensions. `"type": "module"` in package.json.
- **Strict TypeScript**: `strictest` config -- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zero `any`.
- **Zero `any`**: Use `unknown` + type narrowing throughout.
- **Single type file**: All types in `src/types/index.ts`, Zod schemas in `src/types/schemas.ts`. Validation sets co-located with their types.
- **Beta API**: All API calls use `NODYN_BETAS` header (`token-efficient-tools-2025-02-19`).
- **Error isolation**: `Promise.allSettled` for parallel tool dispatch -- one failure doesn't kill others.
- **Cancellation**: `AbortController` on streams, file I/O, subprocesses.
- **Proxy-safe**: Thinking blocks stripped from message history (proxy signatures).
- **3-tier config**: env vars > project `.nodyn/config.json` > user `~/.nodyn/config.json`.
- **Security-first**: `PROJECT_SAFE_KEYS` allowlist, `NPM_NAME_RE`/`SAFE_ROLE_NAME_RE`/`SAFE_PROFILE_NAME_RE` validation, SSRF protection, XML escaping in RAG.
- **DRY utilities**: Shared primitives in `src/core/utils.ts` (`sha256Short`, `getErrorMessage`, `sleep`) and `src/cli/ansi.ts` (`TBL`, `stripAnsi`, `wordWrap`). Constants like `ALL_NAMESPACES` live in `src/types/index.ts`.
- **Open-core extensibility**: Core provides 4 extension points (Orchestrator Hooks, CLI Command Registry, Feature Flags, Notification Router) so Pro can integrate without modifying core source. See [Extension Points](extension-points.md).

## Error Handling

Centralized error hierarchy in `src/core/errors.ts`. All errors extend `NodynError` with a machine-readable `code` and optional structured `context`.

| Error Class | Code | Use Case |
|-------------|------|----------|
| `NodynError` | *(base)* | Base class — `code: string`, `context?: Record<string, unknown>` |
| `ValidationError` | `VALIDATION_ERROR` | Bad arguments, schema mismatch, missing required fields |
| `ConfigError` | `CONFIG_ERROR` | Missing config keys, invalid tiers, schema parse failures |
| `ExecutionError` | `EXECUTION_ERROR` | Runtime failures, API errors, timeouts. Supports `Error.cause` chaining |
| `ToolError` | `TOOL_ERROR` | Tool-specific errors returned to the LLM as `tool_result` |
| `NotFoundError` | `NOT_FOUND` | Missing pipelines, tasks, tenants, processes |

All error classes are exported from `@nodyn-ai/core`.

## Model Tiers

| Tier | Context | Default max_tokens | Use Case |
|------|---------|-------------------|----------|
| `opus` (thorough) | 1M | 32,000 | Architecture, complex reasoning, large context |
| `sonnet` (balanced) | 200K | 16,000 | Implementation, general tasks (default) |
| `haiku` (fast) | 200K | 8,192 | Transforms, knowledge extraction, classification |

The thorough tier has a 1M token context window; balanced and fast tiers have 200K. All model-specific defaults (max_tokens, continuations, truncation thresholds) scale automatically via `DEFAULT_MAX_TOKENS`, `MAX_CONTINUATIONS`, and `CONTEXT_WINDOW` in `src/types/index.ts`.

## Background Tasks

ModeController, GoalTracker, and the 5-mode system have been removed. Background work is handled by `WorkerLoop` via `task_create` with scheduling fields. The `--task` CLI flag creates a background task directly. Pro's sentinel/daemon/swarm modes are deprecated. See [Extension Points](extension-points.md) for how Pro integrates via hooks.
