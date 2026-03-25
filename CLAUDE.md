# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project

nodyn — open business AI engine built on native Anthropic SDK. ESM-only TypeScript, Node.js 22+.

## Repository Split

This is the **public** OSS repo (`nodyn-ai/nodyn`). Internal docs (PRDs, pricing, roadmaps, release strategy) live in the **private** `nodyn-ai/nodyn-pro` repo under `docs/internal/`. The `docs/` folder here contains only technical documentation. Never add business-sensitive documents to this repo.

## Commands

```bash
npm run typecheck   # tsc --noEmit — must pass with zero errors
npm run lint        # eslint src/ — must pass with zero errors
npm run build       # tsc → dist/
npm run dev         # node --env-file=.env --watch --import tsx src/index.ts
npm run start       # node dist/index.js
npm run coverage    # vitest + coverage report (CI enforces ≥80%)
npm run smoke:manual # offline smoke: typecheck + build + vitest + debug subscriber + MCP health/auth/client flow
npm run security    # security scan (scripts/security-scan.sh + vitest run tests/security/)
npx vitest run          # full suite (103 files / ~2481 tests)
npx vitest run <file>   # single file
pnpm bench              # offline performance benchmarks (no API key needed)
pnpm bench:online       # online benchmarks (requires API key, ~$0.02)
```

## Architecture

Single source of truth for types: `src/types/index.ts`. Barrel file re-exporting from 11 domain files (`models.ts`, `worker.ts`, `tools.ts`, `agent.ts`, `memory.ts`, `config.ts`, `roles.ts`, `pipeline.ts`, `security.ts`, `modes.ts`, `records.ts`) plus `ToolContext` from `core/tool-context.ts`. All external imports still use `types/index.js` — never duplicate types elsewhere.

### Directory Layout

```
src/
├── index.ts              # CLI REPL entry + thin command dispatcher + module exports (~1130 LOC). Exports: Engine, Session, WorkerLoop, NotificationRouter, TelegramNotificationChannel, NotificationChannel, NotificationMessage types
├── types/index.ts        # Barrel re-export from 11 domain files (models, worker, tools, agent, memory, config, roles, pipeline, security, modes, records)
├── core/                 # Agent framework + orchestration (60 modules + 1 trigger)
├── cli/                  # Terminal UI + command handlers
│   ├── cli-state.ts      # Mutable CLI state (showThinking, currentModelId, spinner, etc.)
│   ├── cli-helpers.ts    # gitExec, saveSession, printCost, aliases, PRICING
│   ├── help-text.ts      # HELP_TEXT, COMMANDS map, COMMAND_ALIASES, MODEL_ALIASES
│   ├── stream-handler.ts # streamHandler() + pipeline DAG renderer
│   ├── commands/         # Slash command handlers by domain (11 modules)
│   └── ...               # UI modules: banner, markdown, dialog, diff, footer, spinner, visualizer, autocomplete, ansi, setup-wizard, onboarding, interactive
├── tools/                # ToolRegistry + permission guard + 13 builtin tools
├── orchestrator/         # DAG pipeline engine: validate, graph, conditions, runner (9 modules)
├── integrations/search/  # Web search tool (Tavily/Brave providers, content extractor)
├── integrations/telegram/ # Telegram bot (formatter, runner, bot)
├── integrations/google/  # Google Workspace (Gmail, Sheets, Drive, Calendar, Docs)
└── server/mcp-server.ts  # MCP server (stdio + HTTP SSE transport)
```

### CLI Visual Design (`src/cli/`)

- **Prompt**: Green `❯` when idle (user's turn). Braille spinner (`⠋⠙⠹…`) with label + elapsed time while working
- **Indentation**: Tool calls, tool results, spawn, thinking, and errors are 2-space indented to visually separate from answer text
- **Thinking display**: Two modes toggled via `/effort`:
  - **Daily** (default, `showThinking=false`): Braille spinner runs through thinking phase, no thinking text shown
  - **Detailed** (`showThinking=true`): Spinner stops, thinking text streams inline with `👾` prefix. Footer shows `👾 detailed` indicator
- **Spinner** (`spinner.ts`): `Spinner` class — braille frames at 80ms interval, writes to stderr. `updateLabel()` for dynamic label changes (retry feedback). `PROMPT_READY` constant exports the `❯` prompt
- **Footer** (`footer.ts`): Right-aligned status line with `─` line-fill after each turn: token counts, elapsed time, context bar (10-char `█░`, green/yellow/red), cache hit %, mode indicator, thinking indicator. Single source of turn-end stats
- **Autocomplete** (`autocomplete.ts`): Bordered dropdown (thin `─` borders) triggered by `/` at prompt. Arrow keys scroll, Enter selects, Tab fills, Esc cancels. `buildCommandDefs()` parses `HELP_TEXT`. Pagination with `(n/total)` indicator
- **ANSI** (`ansi.ts`): Centralized ANSI constants (`BOLD`, `DIM`, colors, cursor), `stripAnsi()`, `wordWrap()`

### Core Modules (`src/core/`)

| Module | Purpose | Key Gotchas |
|--------|---------|-------------|
| `agent.ts` | Agentic loop with streaming, parallel tool dispatch (`Promise.allSettled`), adaptive thinking, retry with exponential backoff | `maxIterations: 0` = unlimited but hard-capped at `ABSOLUTE_MAX_ITERATIONS` (500). `MAX_MESSAGE_COUNT` (500) truncates history to 60% keeping head + tail. Thinking blocks stripped from history (signatures invalidated by API proxies). 3 `cache_control: ephemeral` blocks in system prompt. Model-aware `MAX_CONTINUATIONS` (Opus 20, Sonnet 10, Haiku 5). Model-aware `DEFAULT_MAX_TOKENS` (Opus 32K, Sonnet 16K, Haiku 8K). Truncation scales with `CONTEXT_WINDOW` (Opus 1M keeps 5x more history). `CHARS_PER_TOKEN = 3.5` for token estimation (all `/3` magic numbers replaced). Tool results truncated at `DEFAULT_MAX_TOOL_RESULT_CHARS` (80K, configurable via `max_tool_result_chars`). `context_budget` stream event emitted when context usage >70% (breakdown: system/tool/message tokens). Optional per-agent `costGuard` for spawn budget enforcement. Tracks `_loopToolCount` per `send()` for memory extraction heuristics. Secret ref extraction/resolution delegated to `SecretStoreLike.extractSecretNames()` / `resolveSecretRefs()`. Security: `_buildSystemPrompt()` wraps knowledge context in `<retrieved_context>` with anti-injection note, briefing gets anti-injection note inside `<session_briefing>` tags. `_executeOne()` scans external tool results (bash, http_request, web_research, google_gmail, google_sheets, google_drive, google_calendar, google_docs) via `scanToolResult()` then truncates oversized results |
| `stream.ts` | Pure stream transformer — no imports from agent/memory/tools | — |
| `context.ts` | `resolveContext(config)` — CLI: project detection + wrap, non-CLI: use explicit `NodynContext` | `NodynContext { id, name?, source, workspaceDir, localDir? }`. Sources: cli, telegram, slack, mcp, pwa |
| `memory.ts` | Flat-file storage in `~/.nodyn/memory/<contextId>/` with global fallback. Dirs created with `0o700` permissions. Base CRUD methods (`load`, `append`, `delete`, `update`) delegate to scoped variants via `_defaultScope()`. `GLOBAL_SCOPE` constant for module-level global scope reference | `MAX_MEMORY_FILE_BYTES` (256KB) — trims oldest lines on append. Extraction throttling: skips Haiku call after empty extractions (3-turn interval, 5 after 3+ empties). Skips no-tool short responses (`toolsUsed === 0 && < 300 chars`). Heuristic scope classification when >1 scope (no API call). Context entries get `[YYYY-MM-DD]` prefix for 30-day TTL. Selective extraction prompt (quality over quantity). Opt-out via `memory_extraction: false` in config. Security: extracted entries scanned via `detectInjectionAttempt()` — 2+ patterns → blocked with security event, 1 pattern → flagged but allowed |
| `engine.ts` | `Engine` class — shared singleton per process. Owns KG, Memory, DataStore, Secrets, Config, ToolRegistry, WorkerLoop, NotificationRouter. `init()` once, then `createSession()` for per-conversation state. `NodynHooks.onAfterRun` receives `(runId: string, costUsd: number, context: RunContext)` where `RunContext` includes `runId`, `contextId`, `modelTier`, `durationMs`, `source`, `tenantId?`. Hook errors are logged to `costWarning` debug channel instead of silently swallowed | Pipeline tools registered at init. DataStore tools on demand (~350 tokens saved). Auto-GC every 50 runs. WorkerLoop started on init, stopped on shutdown |
| `session.ts` | `Session` class — per-conversation state created via `engine.createSession()`. Implements `ModeOrchestrator`. Owns Agent, messages, mode, callbacks, run tracking. Entry point for `run()`, `batch()`, `shutdown()`. Per-session config isolation: `setModel()`, `setEffort()`, `setThinking()` mutate session-local fields, not `engine.config`. `SessionOptions` includes `model`, `effort`, `thinking`, `autonomy` | Briefing cleared after turn 1. `_recreateAgent()` preserves conversation history on agent recreation. `abort()` propagates to spawn + pipeline child agents. System prompt enforces `write_file` over bash for file operations |
| `worker-loop.ts` | `WorkerLoop` — persistent background task executor. 60s tick interval, headless Sessions per task, `AbortSignal.timeout(5min)` per execution, `AsyncLocalStorage` per task for isolated context. Multi-turn support: wires `promptUser` on headless sessions so agent can `ask_user` → question sent as notification → promise-based pause/resume via `ActiveTask.pendingInput`. One-shot background tasks auto-trigger (`nextRunAt=now` when `assignee='nodyn'`) | `WORKER_MAX_ITERATIONS=30` per task execution. Retry logic with exponential backoff (1min → 30min cap). Calls `runManifest()` for pipeline tasks (`pipeline_id` set). Stopped gracefully on engine shutdown |
| `cron-parser.ts` | 5-field standard cron expression parser + shorthand interval syntax (e.g. `every 5 minutes`). Pure function, no external dependencies | Used by WorkerLoop for scheduled task due-time calculation |
| `notification-router.ts` | `NotificationRouter` — pluggable notification channel system. Registers `NotificationChannel` implementations, routes `NotificationMessage` to appropriate channels. Supports task completion, error, and inquiry notifications | Follow-up buttons on task completion notifications (Details, Run again / Retry, Explain). Context-continuity via callback data |
| `telegram-notification.ts` | `TelegramNotificationChannel` — implements `NotificationChannel` for Telegram. Sends task results with inline follow-up buttons, handles inquiry responses for multi-turn tasks | Telegram callback prefixes: `'t:'` for follow-ups (Details/Retry/Explain), `'q:'` for inquiry responses. Integrates with `ActiveTask.pendingInput` for pause/resume |
| `prompts.ts` | System prompt constants: `SYSTEM_PROMPT`, `PIPELINE_PROMPT_SUFFIX`, `DATASTORE_PROMPT_SUFFIX`. Pure constants, zero coupling | Business-friendly language throughout: no model names, no cost references, no developer jargon. Roles described by capability, not model tier. Background task intent recognition: natural language triggers in DE/EN (e.g. "Research X and get back to me", "Jeden Tag um 8...") mapped to `task_create` with appropriate fields (`schedule`, `watch_url`, `pipeline_id`). Proactive suggestions: agent offers background work for long tasks. Multi-turn: background tasks can `ask_user` (pauses until user responds via notification channel) |
| `engine-init.ts` | Extracted init helpers (pure functions): `configureBudgetAndRateLimits`, `setupHistorySubscriptions`, `generateInitBriefing`, `initSecrets`, `initScopes`, `initMemoryInstance`, `initEmbeddingProvider`, `initKnowledgeLayer`, `initDataStoreBridge`, `setupMemoryStoreSubscription`. `initSecrets` auto-migrates all config secrets (`api_key`, `google_client_secret`, `search_api_key`, `voyage_api_key`) to vault, loads `NODYN_MCP_SECRET` from vault, warns on stale MCP secret (>90 days) | Same pattern as run-history-analytics.ts / run-history-persistence.ts. Functions take explicit parameters, return explicit results |
| `batch.ts` | Extracted batch processing: `parseBatchItem`, `submitBatch`, `pollBatch`. Pure functions operating on Anthropic client + RunHistory + BatchIndex | Batch parent/child run tracking. Exponential backoff polling (30s → 5min) |
| `tool-context.ts` | `ToolContext` interface — shared dependency container for tool handlers. Replaces module-level closure setters (`setDataStore()`, `setPipelineConfig()`, etc.). Created by orchestrator, passed to Agent via `agent.toolContext`. Includes core deps (DataStore, TaskManager, KnowledgeLayer, RunHistory), pipeline/process refs, network policy, and isolation config | `createToolContext()` factory, `applyNetworkPolicy()`, `applyHttpRateLimits()` helpers. `ToolCallCountProvider` interface for cross-session HTTP rate limiting |
| `errors.ts` | Centralized error hierarchy: `NodynError` (base with `code` + `context`), `ValidationError`, `ConfigError`, `ExecutionError` (supports `Error.cause`), `ToolError`, `NotFoundError` | Business-friendly error codes. Used across tools and core modules for typed error handling |
| `data-store.ts` | SQLite-based structured data storage (`~/.nodyn/datastore.db`). Agent-defined collections with typed columns, filter→SQL translation, aggregation, upsert, delete | One-table-per-collection (dynamic DDL). WAL mode. Max 100 collections, 50 columns, 100K records. `MAX_DB_SIZE_BYTES` (500MB) checked before insert. Filter operators: `$eq`, `$neq`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$like`, `$is_null`, `$or`, `$and`. Upsert via `uniqueKey` + `ON CONFLICT DO UPDATE`. `deleteRecords()` requires filter (no bulk delete) |
| `datastore-bridge.ts` | `DataStoreBridge`: connects DataStore tables to Knowledge Graph. `registerCollection()` creates collection entities, `indexRecords()` extracts entities from string fields, `findRelatedData()` provides DataStore hints during retrieval | Entity type `'collection'` for tables. `has_data_in` relation type. Regex-only extraction (no LLM for bulk data). Max 20 entities per batch, max 100 records scanned |
| `config.ts` | 3-tier merge: env > project `.nodyn/config.json` > user `~/.nodyn/config.json`. `setVaultApiKeyExists()` signals vault-stored API key to `hasApiKey()` | Project config restricted to `PROJECT_SAFE_KEYS` allowlist |
| `run-history.ts` | SQLite at `~/.nodyn/history.db`. WAL mode, 19 migrations. Transparent AES-256-GCM encryption of sensitive columns when `NODYN_VAULT_KEY` set. Delegates analytics to `run-history-analytics.ts` (9 functions) and persistence to `run-history-persistence.ts` (44 functions). `deleteRun()`, `deleteRunsByContext()`, `deleteRunsByTenant()`, `vacuum()`, `resetDatabase()` (delete all run data for clean-slate release upgrades). `reEncryptAll(newVaultKey)` for key rotation (decrypts with current key, re-encrypts with new key). Decryption failures warned to stderr (once for missing key, max 3 for bad key — rate-limited) | Tables: runs, run_tool_calls, run_spawns, prompt_snapshots, pre_approval_sets/events, pipeline_runs/step_results, scopes, advisor_suggestions, tasks, tenants, security_events, processes. Encrypted columns: task_text, response_text, input_json, output_json. Mixed mode: encrypted + plaintext rows coexist |
| `run-history-analytics.ts` | 9 extracted analytics functions from RunHistory (stats, aggregation, query helpers) | Pure functions operating on RunHistory's db instance |
| `run-history-persistence.ts` | 44 extracted persistence functions from RunHistory (CRUD, migrations, encryption) | Pure functions operating on RunHistory's db instance |
| `embedding.ts` | ONNX model registry (multilingual-e5-small default, 384d, 100 langs), Voyage (1024d), Local (test-only). `OnnxModelId` type + `ONNX_MODEL_REGISTRY` constant | ONNX forces `device: 'wasm'`. Cold start ~800ms (multilingual) / ~370ms (MiniLM). `createEmbeddingProvider()` accepts `model` param |
| `knowledge-graph.ts` | `KuzuGraph` class: LadybugDB (Kuzu fork) embedded graph DB wrapper. Schema init (Entity/Memory/Community nodes, MENTIONS/RELATES_TO/SUPERSEDES/COOCCURS edges), Cypher query wrapper, typed result extraction | DB at `~/.nodyn/knowledge-graph/`. `findSimilarMemories()` brute-force cosine (upgradeable to HNSW). `createEntity/Memory/Mention/Relation()`. LadybugDB native addon: SIGSEGV on process exit (non-functional, handled). **Security**: All namespace/scopeType/filter values use parameterized Cypher queries (`$ns`, `$filterNs`, `$filterScopeTypes`). LIMIT values validated with `Math.floor()`/`Math.min()` and capped at 100 |
| `knowledge-layer.ts` | `KnowledgeLayer` implementing `IKnowledgeLayer`: unified store/retrieve/update/delete API. Composes KuzuGraph + EntityExtractor + EntityResolver + ContradictionDetector + RetrievalEngine | `store()`: embed → dedup → contradiction → graph write → entities. `retrieve()`: HyDE → vector + graph → MMR. `deactivateByPattern()`: sync graph on memory_delete. `updateMemoryText()`: sync graph on memory_update + re-extract entities |
| `retrieval-engine.ts` | Graph-augmented retrieval: HyDE query expansion (Haiku), multi-signal search (vector 55% + FTS 30% + graph 15%), namespace-specific decay (knowledge 365d, project-state 21d), MMR re-ranking (λ=0.7), XML context formatting | `RetrievalEngine` class with `retrieve()` + `formatContext(result, maxChars?)`. `formatContext` drops lowest-scored memories when output exceeds `DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS` (12K). Entity-based graph expansion: query entities → resolve → 1-2 hop traversal → connected memories |
| `entity-extractor.ts` | Two-tier entity extraction: Tier 1 regex (DE/EN, persons/orgs/tech/projects/locations), Tier 2 optional Haiku for high-value namespaces | `extractEntitiesRegex()` (zero cost), `extractEntitiesLLM()` (~$0.001). `shouldUseLLMExtraction()` gates Tier 2: only knowledge/methods, >200 chars, 0 regex entities |
| `entity-resolver.ts` | `EntityResolver` class: canonical name resolution (exact → alias → normalized → create new), entity merge | `resolve()` priority: exact canonical match → alias match → lowercase match → create. `merge()`: transfers aliases + mention count, deletes source entity |
| `contradiction-detector.ts` | Detects contradicting facts at store time for knowledge/learnings namespaces | `detectContradictions()`: vector search (>0.80 sim) → heuristic checks (negation DE/EN, number change, state change). Contradicted memories: `is_active=false`, SUPERSEDES edge |
| `scope-resolver.ts` | 3-tier scope hierarchy: Global(0.3) > Context(0.8) > User(1.0) | `scopeToDir()` maps to flat-file paths. `inferScopeFromContext()` uses cosine similarity 0.85 |
| `scope-classifier.ts` | Heuristic scope classification (no API call), multilingual (DE/EN/FR) | Personal preferences → user, universal knowledge → global, default → context |
| `secret-vault.ts` | Encrypted SQLite vault (`~/.nodyn/vault.db`), AES-256-GCM, PBKDF2 600K SHA-512. `deriveTenantKey()` via HKDF-SHA256 for per-tenant cryptographic isolation. `rotateVault()` for in-place key rotation. `estimateKeyEntropy()` for Shannon entropy validation (warns <128 bits). Decryption failures logged to stderr (not silent). Imports crypto constants from `crypto-constants.ts` and shared constants from `constants.ts` | Requires `NODYN_VAULT_KEY` env var |

| `secret-store.ts` | Multi-source secrets: env (`NODYN_SECRET_*`) > vault > config fields. `extractSecretNames()` and `resolveSecretRefs()` centralize secret reference handling (moved from agent.ts) | Consent gate. `SECRET_REF_PATTERN` with `\b` word boundaries. `SecretStoreLike` interface includes extraction + resolution methods. Memory guard blocks secret content |
| `pre-approve.ts` | Glob pattern matching for autonomous mode auto-approval | TTL + maxUses enforcement. `isCriticalTool()` moved to `permission-guard.ts` |
| `permission-guard.ts` | Tool permission checks before execution. Business-friendly block messages ("this action needs to be run manually for safety", "I need your OK before doing this", "I can only write files within the current project") | `normalizeCommand()` defeats encoding bypasses (ANSI-C quoting, hex escapes). `splitCommandSegments()` checks each chained command independently. `CRITICAL_BASH` blocks rm -rf, sudo, env dumps, SQL DROP/TRUNCATE, payment mutations, ncat/socat, /dev/tcp, openssl s_client, curl upload, python http.server. `DANGEROUS_BASH` adds database CLIs, email, payments, webhooks, messaging, xxd/printf piped to shell. HTTP POST/PUT/PATCH blocked in autonomous mode (pre-approvable). Google write actions (including `draft`, `append`) blocked in autonomous. `spawn_agent` task+context scanned for injection patterns in autonomous mode via `detectInjectionAttempt()`. Guard blocks published to `nodyn:guard:block` diagnostic channel |
| `input-guard.ts` | Content policy — scans user input before LLM | Tier 1 hard block: malware/exploit/phishing creation. Tier 2 soft flag: social engineering, brute force, DDoS. Intent-based matching (verb+target, not keywords). Wired in `orchestrator.run()` |
| `data-boundary.ts` | Prompt injection defense | `wrapUntrustedData(content, source)` wraps external data in `<untrusted_data>` boundary tags with boundary-escape neutralization (`</untrusted_data>` in content → entity-escaped). `detectInjectionAttempt()` scans for 17 patterns across 12 categories (tool invocation incl. Google tools, instruction override, role reassignment, ChatML/Llama/XML tokens, boundary escape, role impersonation, data exfiltration, email exfiltration). `escapeXml()` prevents XML tag injection. Applied at: web search, HTTP responses, content extraction, system prompt (knowledge context + briefing), spawn agent context, pipeline template resolution, memory extraction validation, briefing generation, permission guard (spawn task scanning), **all Google tool read handlers** (Gmail body, Calendar events, Sheets cells, Drive content, Docs markdown), **MCP user_context**, **Telegram voice transcription** |
| `output-guard.ts` | Output validation — scans writes + tool results | `checkWriteContent()` detects reverse shells, crypto miners, persistence mechanisms. `scanToolResult()` detects injection in tool results — applied to external tool results (bash, http_request, web_research, **google_gmail, google_sheets, google_drive, google_calendar, google_docs**) in `agent._executeOne()`. `ToolCallTracker` detects read-then-exfil, burst HTTP, **Google read→exfil** (google_read → email send/http_request), and **Google read→credential harvest** (google_read → sensitive file read) anomalies |
| `security-audit.ts` | Security event persistence + query | Subscribes to `guardBlock` + 3 security channels. Persists to `security_events` SQLite table. Masks secrets in previews. `getRecentEvents()`, `getEventCounts()` |
| `pricing.ts` | `calculateCost(model, usage)` with cache token support | Cache write 1.25x, cache read 0.1x. Optional `~/.nodyn/pricing.json` override |
| `workspace.ts` | Docker sandbox: write to `/workspace` + `/tmp` only, read also `/app`. `ensureContextWorkspace()` for non-CLI | Non-CLI sources auto-sandboxed. CLI retains direct filesystem access |
| `project.ts` | `detectProjectRoot()` walks up for `.git`, `package.json`, `.nodyn-project`. `generateBriefing()` from last 3-5 runs | Briefing enriched with last response summary, failed status, top-3 tool usage. Security: `task_text` and `response_text` scanned via `detectInjectionAttempt()` — injection patterns redacted with `[redacted]` |
| `plugins.ts` | Validated `import()` from `~/.nodyn/plugins/node_modules/` only | Plugin names validated against `NPM_NAME_RE`. Secrets stripped from context |
| `process-capture.ts` | Extracts reusable ProcessRecord from run_history tool calls. Filters internal tools, Haiku call for step naming + parameter identification. Sanitizes secrets, truncates inputs | `INTERNAL_TOOLS` set excludes memory/ask_user/plan_task/capture_process. `MAX_INPUT_CHARS` (500), `MAX_OUTPUT_CHARS` (200) for LLM context. Uses forced tool_choice for structured JSON output |
Also: `cost-guard.ts`, `session-budget.ts` ($50 session ceiling shared by spawn + pipeline), `session-store.ts`, `batch-index.ts`, `prompt-hash.ts`, `roles.ts`, `dag-planner.ts`, `observability.ts`, `debug-subscriber.ts` (token masking for `ya29.*`/JWT patterns via `maskTokenPatterns()`, debug file written with 0o600, production warning when `NODYN_DEBUG` + `NODE_ENV=production`), `atomic-write.ts` (sync + async `ensureDir()` variant, imports from `constants.ts`), `constants.ts` (shared numeric constants: `MAX_BUFFER_BYTES`, `DIR_MODE_PRIVATE`, `FILE_MODE_PRIVATE`, `DEFAULT_BASH_TIMEOUT_MS`, `WORKER_MAX_ITERATIONS`, `DEFAULT_TASK_TIMEOUT_MS`), `crypto-constants.ts` (shared AES-256-GCM constants: `CRYPTO_ALGORITHM`, `CRYPTO_KEY_LENGTH`, `CRYPTO_IV_LENGTH`, `CRYPTO_TAG_LENGTH`), `task-manager.ts` (extended: `createScheduled()`, `createWatch()`, `createPipelineTask()`, `getDueTasks()`, `recordTaskRun()`, `updateWatchConfig()`. Task types: `manual`, `scheduled`, `watch`, `pipeline`. DB migrations v20 (scheduling columns) + v21 (`pipeline_id`). Watch tasks use direct HTTP fetch + `crypto.createHash('sha256')` for change detection — first run = baseline, only notifies on actual changes), `features.ts`, `changeset.ts`, `memory-gc.ts` (`temporalDecay()` utility), `triggers/` (file-trigger only — http-trigger, cron-trigger, git-trigger deleted).

### Roles (`src/core/roles.ts`)

4 built-in roles as a const map. System prompt describes them by capability, not model tier.

| ID | Model | Effort | Autonomy | Tools | User-Facing Description |
|----|-------|--------|----------|-------|------------------------|
| `researcher` | opus | max | guided | deny: write_file, bash | Thorough exploration, source citation. Read-only |
| `creator` | sonnet | high | guided | deny: bash | Content creation, tone adaptation. No system commands |
| `operator` | haiku | high | autonomous | deny: write_file | Fast status checks, concise reporting. Read-only |
| `collector` | haiku | medium | supervised | allow: ask_user, memory_store, memory_recall | Structured Q&A with user. Minimal tools |

No file-based CRUD. Spawn and pipeline steps use `role` field exclusively. CLI command: `/roles`.

**Web search integration** (in core): `src/integrations/search/` — `search-provider.ts` (Tavily + Brave providers, factory), `content-extractor.ts` (Readability + SSRF-protected URL reading), `web-search-tool.ts` (`web_research` with search/read actions), `index.ts` (barrel + registration). Conditional — requires `TAVILY_API_KEY` or `BRAVE_API_KEY`.

**Telegram integration** (in core): `src/integrations/telegram/` — `telegram-bot.ts` (Telegraf setup, message routing, commands, follow-up callbacks, inquiry callbacks, `MAX_DOCUMENT_BYTES` 10MB), `telegram-runner.ts` (run lifecycle, rich status edits with tool details, follow-up suggestions, serialized run queue, context trim notification), `telegram-formatter.ts` (markdown→HTML, message splitting, inline keyboards, `buildRichStatus` for progressive status edits, `toolInputPreview`, `parseFollowUps`, `friendlyError`), `telegram-session.ts` (per-chat conversation persistence with sliding window, run queue serialization, session eviction, `trimNotified` flag), `telegram-i18n.ts` (DE/EN string table for all bot chrome, `TOOL_LABELS_DE` + `friendlyToolName()` reusing `TOOL_DISPLAY_NAMES` from types, auto-detect via `language_code`). **Notification channel**: `TelegramNotificationChannel` (in `core/telegram-notification.ts`) implements `NotificationChannel` — receives task completion/error notifications from `NotificationRouter`, sends results with inline follow-up buttons (`'t:'` prefix: Details, Run again/Retry, Explain) and handles multi-turn inquiry responses (`'q:'` prefix) for background tasks that need user input. **Business-friendly UX**: tool names shown as labels via `friendlyToolName()` (reuses `TOOL_DISPLAY_NAMES` from `types/modes.ts` + DE translations in `telegram-i18n.ts`). Error messages sanitized via `friendlyError()` (pattern-match ENOENT/401/429/5xx etc. → plain language, unmatched errors stripped of IPs/paths/stack traces, capped at 200 chars). File paths shown as basename only. `/cost` shows only dollar amount (no token counts). `/secret` uses plain business language (no `.env`/SSH jargon). Document uploads checked against `MAX_DOCUMENT_BYTES` (10MB). Context window trimming notified once per session. Rich status: one editable message shows thinking summary → tool list with ✅/❌/⏳ + friendly labels + input previews → done/stopped/error. Follow-up buttons attached inline to result or error messages (no separate message). Abort immediately edits status to stopped. **Agent-generated follow-ups**: system prompt instructs agent to include `<follow_ups>[{label, task}]</follow_ups>` at end of response; `parseFollowUps()` extracts and strips the block. Fallback (error/abort): `fallbackFollowUps()` provides Retry/Explain buttons. No static rule engine. **Conversation persistence**: sliding window (20 messages / ~10 turns) per chat, `save()` returns `boolean` (trimmed), one-time `msg.context_trimmed` notification, long-term knowledge preserved via Knowledge Graph, `/clear` to reset. **Vision**: photos sent as base64 image content blocks (not URL text). **Voice**: whisper.cpp + ffmpeg included in Docker image, auto-transcription, transcribed text wrapped via `wrapUntrustedData()` for injection defense. **i18n**: all bot chrome (status, commands, errors, tool labels) in DE/EN, detected from Telegram user language. Follow-up labels generated by agent in user's language. **Commands**: `/start`, `/stop`, `/clear`, `/cost`, `/status`, `/secret`, `/help`. **Onboarding**: first-time users get warm welcome + agent prompted to ask about business context.

**Google Workspace integration** (in core): `src/integrations/google/` — `google-auth.ts` (OAuth 2.0 localhost redirect + device flow + service account JWT + token refresh), `google-gmail.ts` (search/read/send/reply/draft/archive/labels), `google-sheets.ts` (read/write/append/create/list/format), `google-drive.ts` (search/read/upload/create_doc/list/move/share), `google-calendar.ts` (list/create/update/delete/free_busy), `google-docs.ts` (read/create/append/replace), `google-docs-format.ts` (Docs JSON→markdown, markdown→HTML for import), `index.ts` (barrel + `createGoogleTools()`). CLI `/google auth` uses localhost OAuth only (browser redirect). Device flow code retained for future Telegram/headless use. Tokens encrypted in SecretVault (`GOOGLE_OAUTH_TOKENS` key, requires `NODYN_VAULT_KEY`). Conditional — requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. Default OAuth scopes are **read-only** (`READ_ONLY_SCOPES`); write scopes (`WRITE_SCOPES`) opt-in via `google_oauth_scopes` config or `requestScope()` at runtime. Service account key files validated: must be absolute path, permissions 0o600/0o400 on Unix, valid JSON with `type: "service_account"` + required fields. **Security hardening (anti-injection)**: All 5 Google tools in `EXTERNAL_TOOLS` → `scanToolResult()` applied to every response. Defense in depth: all read handlers wrap external content via `wrapUntrustedData()` (Gmail body, Calendar events, Sheets cells, Drive file content, Docs markdown). Gmail `stripHtml()` strips HTML comments/CDATA/hidden elements to prevent injection hiding. Search snippets excluded from results. `wrapUntrustedData()` neutralizes `</untrusted_data>` boundary escape tags. `ToolCallTracker` detects Google-specific exfiltration patterns (google_read → email_send, google_read → http_request, google_read → sensitive_file_read). `detectInjectionAttempt()` patterns include Google tool invocation, email exfiltration instructions, and boundary escape.

**Pro modules** (in `nodyn-pro`): `tenant.ts`, `isolation.ts`, `worker-pool.ts`, `pro-hooks.ts` (tenant cost + worker pool lifecycle), Slack integration. Uses `Engine` + `Session` architecture — tenant billing reads `RunContext.tenantId` (set via `Session.tenantId` property). Sentinel/daemon/swarm modes are deprecated.

### Builtin Tools (`src/tools/builtin/`)

All tool descriptions use business-friendly language (no model names, no developer jargon). LLM sees capability descriptions, not implementation details.

bash, fs (read_file + write_file, `MAX_WRITE_BYTES_PER_SESSION` 100MB, symlink escape → business-friendly error), memory (store/recall/delete/update/list/promote — descriptions use "knowledge" language, scope descriptions use "organization/personal/project". Delete/update/promote sync with Knowledge Graph: deactivate/update Memory nodes + re-extract entities), spawn (spawn_agent — "delegate to roles", per-agent $5 default budget via CostGuard, $50 session ceiling, unknown role → "Unknown role" with available roles listed, `spec.context` XML-escaped via `escapeXml()` to prevent tag injection), ask-user (options use `\x00` sentinel to suppress "Other"), batch-files (`MAX_FIND_DEPTH` 10, `MAX_FIND_FILES` 10K), http (SSRF-protected with `friendlyBlockMessage()` wrapper — "internal network", "only HTTP/HTTPS", "limit reached", `MAX_REQUESTS_PER_SESSION` 100, `enforce_https` config blocks plain HTTP except localhost, sensitive response headers redacted: Set-Cookie/Authorization/X-Auth-Token/Cookie → `[redacted]`), pipeline (run_pipeline — inline steps or stored workflow execution, registered at init, 15s heartbeat), task (create/update/list + extended: `schedule` field for cron expressions, `watch_url` for URL monitoring, `pipeline_id` for pipeline bridge — scope format error improved), plan-task (phased plan with workflow bridge + auto-planning fallback via planDAG — see below), process (capture_process + promote_process — structured process capture from run_history, converts to parameterized workflows), data-store (create/insert/query/delete/list — "data table" language, errors wrapped with "Error working with data table:", filter description uses examples not syntax docs. Delete requires filter — no bulk delete. DataStore bridge auto-indexes entities from string fields into Knowledge Graph). **Conditional:** web-search (Tavily/Brave), google_* tools (Gmail/Sheets/Drive/Calendar/Docs).

### Plan Task (`src/tools/builtin/plan-task.ts`)

Structured planning tool with automatic pipeline bridge. Follows: understand → plan → approve → execute → verify.

**Schema** (simplified for LLM reliability):
- `summary`: Plain-language description of what will be done
- `context`: Exploration findings (`summary`, `findings[]`) — shown to user before the plan
- `phases[]`: Steps with `name`, `steps[]`, `verification?`, `depends_on?`, `assignee?` (`"agent"` | `"user"`)
- `steps[]`: Legacy flat step list (backward compat, no pipeline conversion)

**What the LLM does NOT decide**: `model`, `role`, `effort`, `on_failure` — runtime assigns these.

**Auto-planning fallback**: When no `phases` or `steps` are provided, `plan_task` auto-generates phases via `planDAG()` (Haiku call). API key and dependencies accessed via `agent.toolContext` (ToolContext pattern). Falls back gracefully if planning fails.

**Pipeline bridge**: On approval, agent phases are auto-converted to `InlinePipelineStep[]` via `phasesToPipelineSteps()` and stored as `PlannedPipeline`. Returns `pipeline_id` → agent calls `run_pipeline`. User phases (`assignee: "user"`) are excluded from the pipeline — agent handles them via `ask_user` (instant) or `task_create` (async).

**Cost gate**: Pre-approval cost estimate shown to user via `estimatePipelineCost()`. Session ceiling ($50) enforced per-step during execution.

**Presentation**: Business-friendly numbered list, no jargon. User phases marked `[your input needed]`. No model names, file paths, or dependency syntax shown.

**Key functions**: `phasesToPipelineSteps()` (exported, converts phases to DAG steps with `slugify` for IDs, `depends_on` → `input_from`), `formatPresentation()` (business-user output), `convertToPipeline()` (stores `PlannedPipeline`).

### Process Capture (`src/tools/builtin/process.ts` + `src/core/process-capture.ts`)

Structured bridge from ad-hoc execution to reusable pipelines. Core value: "discover processes through collaboration, then automate."

**Architecture**: `run_history (tool calls)` → `captureProcess()` → `ProcessRecord` → `promote_process` → `PlannedPipeline`

**Types** (in `types/index.ts`):
- `ProcessRecord`: id, name, description, sourceRunId, steps[], parameters[], createdAt, promotedToPipelineId?
- `ProcessStep`: order, tool, description, inputTemplate, dependsOn?
- `ProcessParameter`: name, description, type (string/number/date), defaultValue?, source (user_input/relative_date/context)

**capture_process tool**: Reads `run_tool_calls` from current run (via `agent.currentRunId`). Filters internal tools. Haiku call (~$0.001) names steps in plain language and identifies fixed vs. variable elements. Returns typed ProcessRecord stored in SQLite (`processes` table, migration v18).

**promote_process tool**: Converts ProcessRecord → InlinePipelineStep[] (description → task, dependsOn → input_from). Parameters become pipeline context variables with `{{param}}` templates. Stores as PlannedPipeline → agent calls `run_pipeline`.

**Promote flow** (system prompt guided):
1. After multi-step work → agent offers to save as reusable process
2. `capture_process` reads actual steps (not LLM memory)
3. Agent presents steps + parameters for user confirmation
4. `promote_process` creates parameterized pipeline
5. Agent suggests scheduling (background task + cron)

**Storage**: SQLite `processes` table with CRUD (insertProcess, getProcess with prefix match, listProcesses, updateProcessPromotion, deleteProcess). Dependencies accessed via `agent.toolContext` (ToolContext pattern).

### DAG Engine (`src/orchestrator/`)

Declarative JSON manifest runner. v1.0 = sequential, v1.1 = parallel (phase-based `Promise.allSettled`). 4 runtime types: `agent`, `mock`, `inline`, `pipeline` (max depth 3). 9 condition operators (YAML manifests only). `{{step.result}}` template syntax. Simple per-step cost estimation (opus=$1.20, sonnet=$0.08, haiku=$0.005), step retry, DAG visualization.

**Pipeline step optimization:**
- Inline steps get minimal tool set (bash, read_file, write_file, http, ask_user) — saves ~3000 tokens/turn vs loading all parent tools. Roles with `allowedTools` get full tool resolution.
- `input_from` context truncated at 16000 chars (configurable via `pipeline_context_limit`) to prevent token blowup from verbose upstream outputs.
- Planned pipelines persisted to SQLite (`pipeline_runs` with `status='planned'`) for cross-session availability.
- Cost estimate emitted as `pipeline_progress` event before execution starts.
- Per-step `effort` field supported, with resolution: step > role > config > 'medium'.

**Model behavior in pipeline steps:**

| Model | Thinking | Effort | CostGuard | Best for |
|-------|----------|--------|-----------|----------|
| Haiku (`haiku`) | `enabled` (4096 budget) | not sent (unsupported) | $2 | Read-only tasks, validation, data extraction |
| Sonnet (`sonnet`) | `adaptive` | config (default: `high`) | $2 | File writes, analysis, code review, reports |
| Opus (`opus`) | `adaptive` | config (default: `high`) | $10 | Complex architecture, ambiguous requirements |

IMPORTANT: Haiku is unreliable at writing files with exact filenames. Any step that must produce file artifacts for downstream consumption should use `sonnet`.

### MCP Server (`src/server/mcp-server.ts`)

Stdio + HTTP SSE transport. Uses `Engine` (not `Nodyn` directly) — `SessionStore` holds per-session `Session` instances. Sync (`nodyn_run`) and async (`nodyn_run_start`/`nodyn_poll`/`nodyn_reply`/`nodyn_abort`) lifecycle. Per-run and global buffering caps. Persisted async run state. Periodic GC for completed runs (>30min) and rate limiter map pruning (5min interval). TLS warning on network-exposed plain HTTP. `NODYN_MCP_SECRET` loadable from vault (set by `initSecrets()` on `process.env`). **Security**: `user_context` wrapped via `wrapUntrustedData()` (prevents tag-breakout injection). `session_id` mandatory on `nodyn_poll`/`nodyn_reply` (prevents cross-session data access). `MAX_REQUEST_BODY_BYTES` (30MB) enforced via `Content-Length` header check. Bearer token validated with `timingSafeEqual()`.

### CLI Slash Commands

Commands are implemented in `src/cli/commands/` as domain-grouped modules. `handleCommand()` in `index.ts` dispatches via a `DISPATCH` record to the appropriate handler function. `InternalHandler` type signature: `(parts: string[], session: Session, ctx: CommandContext)` — all 11 command modules take `Session` (not `Nodyn`). Pro registers additional commands via `registerCommand()` (e.g. `/tenant`).

| Module | Commands |
|--------|----------|
| `commands/basic.ts` | `/clear` (`/reset`), `/compact`, `/save`, `/load`, `/export`, `/history`, `/help`, `/exit` (`/quit`) |
| `commands/model.ts` | `/model`, `/accuracy` (was `/effort`), `/cost`, `/context` |
| `commands/config.ts` | `/config`, `/status`, `/hooks`, `/approvals` |
| `commands/git.ts` | `/git`, `/pr`, `/diff` |
| `commands/memory.ts` | `/memory`, `/scope`, `/knowledge` |
| `commands/pipeline.ts` | `/pipeline`, `/tools`, `/mcp`, `/chain`, `/manifest` |
| `commands/history.ts` | `/runs`, `/stats`, `/batch`, `/batch-status`, `/tree` |
| `commands/mode.ts` | `/mode` (status-only), `/roles`, `/profile` |
| `commands/identity.ts` | `/alias`, `/google`, `/vault`, `/secret`, `/plugin` |
| `commands/task.ts` | `/task`, `/business` |
| `commands/schedule.ts` | `/schedule list`, `/schedule details <id>`, `/schedule cancel <id>`, `/schedule test <cron>` |
| `commands/quickstart.ts` | `/quickstart` — guided first steps (3 starter tasks) |

### Setup Wizard (`src/cli/setup-wizard.ts`)

Streamlined 2-interaction onboarding: (1) API key with live validation, (2) integration checklist (Google Workspace, Telegram, Web Research) via `multiSelect()` — arrow keys + Space to toggle + Enter to confirm. Encryption always enabled (no prompt), accuracy defaults to Balanced/sonnet (no prompt). Prerequisites check (Node version, directory, network) runs first. Credentials collected only for selected integrations. Vault key set in `process.env` immediately for seamless REPL start. Shell profile injection: append-only with duplicate guard, supports zsh/bash/fish. `--init` flag continues into REPL instead of exiting. Business profile onboarding (`src/cli/onboarding.ts`) runs after setup: 4 optional questions, stored in `~/.nodyn/memory/_global/facts.txt`.

**Vault key persistence**: 3-tier auto-load ensures the vault key survives restarts:
1. `index.ts` `loadDotEnv()` — reads `~/.nodyn/.env` on CLI startup (local npm/npx)
2. `entrypoint.sh` — grep-parses `~/.nodyn/.env` before Node starts (Docker, never sourced as script)
3. Shell profile injection — sources on shell login (belt-and-suspenders)

**Security hardening**: Both auto-load paths validate before reading: reject symlinks (`lstatSync` / `-L`), check file ownership (`statSync().uid` vs `getuid()`), reject group/other permissions (must be `0o600`/`0o400`), validate vault key format (`^[A-Za-z0-9+/=]{32,128}$`), warn on low entropy (<10 unique chars in `loadDotEnv()`, <128 bits Shannon in `SecretVault` constructor). Only `NODYN_VAULT_KEY` extracted — never API keys, never eval'd as code. Shell profile injection uses `basename($SHELL)` (not `endsWith`), `writeFileAtomicSync` for .env (no race window), single quotes in fallback. If vault.db exists but key is missing, `engine-init.ts` warns to stderr. Docker `entrypoint.sh` skips vault key load when permissions cannot be determined (previously loaded without check).

## TypeScript Rules

- `strictest` config: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`
- Zero `any` — use `unknown` plus type narrowing. Catch variables are `unknown` — always narrow before use
- **ESLint** (`eslint.config.js`): `no-explicit-any`, `no-floating-promises`, `consistent-type-imports`, `no-unused-vars`, `eqeqeq`, `no-console`, `no-eval`. Run via `npm run lint`
- Optional properties must be typed as `T | undefined` (required by `exactOptionalPropertyTypes`)
- All imports use `.js` extensions (ESM + NodeNext resolution)
- `NODYN_BETAS` must be included in every beta API call
- `MODEL_MAP` values must use full model IDs (e.g. `claude-haiku-4-5-20251001`, not short forms) for proxy compatibility
- **Interface naming**: `I`-prefix (`IAgent`, `IMemory`, `IWorkerPool`) for minimal interfaces in `types/index.ts` that break circular deps. `Like`-suffix (`SecretStoreLike`, `ChangesetManagerLike`) for dependency-inversion interfaces. `Provider`-suffix (`EmbeddingProvider`, `CostQueryProvider`) for capability interfaces. No prefix for data types and configs
- **Validation sets**: Centralized in `types/index.ts` (`MODEL_TIER_SET`, `EFFORT_LEVEL_SET`, `AUTONOMY_LEVEL_SET`, `SCOPE_TYPE_SET`, `OUTPUT_FORMAT_SET`). Never redeclare locally
- **Zod schemas**: `types/schemas.ts` — runtime validation for JSON-serializable types (`RoleSchema`, `NodynUserConfigSchema`). Used in role parsing and config loading

## SDK Patterns

- **Adaptive thinking**: `thinking: { type: 'adaptive' }` — Claude decides depth per request. Haiku does not support adaptive — falls back to `{ type: 'enabled', budget_tokens: 4096 }` in pipeline steps or `disabled` system-wide
- **Effort**: `effort: 'high'` default. Sent via `output_config: { effort }` independently of thinking. Haiku does not support effort — not sent. Effort propagates to pipeline steps via `step.effort > role.effort > config.effort_level > 'medium'`
- **Prompt caching**: GA — no beta header. `cache_control: { type: 'ephemeral' }` on API calls + per system prompt block. Cache is per-conversation (effective within multi-turn steps, NOT shared between parallel steps). Opus requires 4,096+ tokens for caching to activate
- **Eager tool streaming**: `eager_input_streaming: true` on tool definitions
- **Error isolation**: `Promise.allSettled` for parallel tool dispatch. `Error.cause` chaining. `AggregateError` for parallel failures
- **API retry**: Exponential backoff on 429/529/5xx (3 retries, 2s base: 2→4→8s). Network errors (ECONNRESET, ETIMEDOUT) also retried. 4xx (except 429) throw immediately
- **Cache token pricing**: Write 1.25x input rate, read 0.1x input rate — tracked separately in `CostGuard`

## Resource Limits

Hard caps on unbounded resource consumption. All limits have sensible defaults that don't affect normal usage.

| Resource | Constant | Value | Location |
|----------|----------|-------|----------|
| Batch file traversal depth | `MAX_FIND_DEPTH` | 10 | `tools/builtin/batch-files.ts` |
| Batch file count | `MAX_FIND_FILES` | 10,000 | `tools/builtin/batch-files.ts` |
| Agent loop iterations | `ABSOLUTE_MAX_ITERATIONS` | 500 | `core/agent.ts` |
| Session cost (spawn + pipeline) | `MAX_SESSION_COST_USD` | $50 | `core/session-budget.ts` |
| Daily cost cap (persistent) | `max_daily_cost_usd` | configurable | `core/session-budget.ts` |
| Monthly cost cap (persistent) | `max_monthly_cost_usd` | configurable | `core/session-budget.ts` |
| HTTP requests per session | `MAX_REQUESTS_PER_SESSION` | 100 | `tools/builtin/http.ts` |
| HTTP response body size | `http_response_limit` | 100KB (configurable) | `tools/builtin/http.ts` |
| HTTP requests per hour (persistent) | `max_http_requests_per_hour` | configurable | `tools/builtin/http.ts` |
| HTTP requests per day (persistent) | `max_http_requests_per_day` | configurable | `tools/builtin/http.ts` |
| Pipeline step result size | `pipeline_step_result_limit` | 50KB (configurable) | `tools/builtin/pipeline.ts` |
| Pipeline step→step context | `pipeline_context_limit` | 16KB (configurable) | `orchestrator/context.ts` |
| Memory extraction input | `memory_extraction_limit` | 16KB (configurable) | `core/memory.ts` |
| Tool result size | `max_tool_result_chars` | 80K chars (configurable) | `core/agent.ts` |
| Knowledge context size | `DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS` | 12K chars | `core/retrieval-engine.ts` |
| Session briefing size | `MAX_BRIEFING_CHARS` | 8K chars | `core/engine-init.ts` |
| Message history count | `MAX_MESSAGE_COUNT` | 500 | `core/agent.ts` |
| Memory file size | `MAX_MEMORY_FILE_BYTES` | 256KB | `core/memory.ts` |
| File writes per session | `MAX_WRITE_BYTES_PER_SESSION` | 100MB | `tools/builtin/fs.ts` |
| DataStore disk size | `MAX_DB_SIZE_BYTES` | 500MB | `core/data-store.ts` |
| MCP completed run GC | — | 30min | `server/mcp-server.ts` |
| Worker task iterations | `WORKER_MAX_ITERATIONS` | 30 | `core/constants.ts` |
| Worker task timeout | `DEFAULT_TASK_TIMEOUT_MS` | 5min (300000ms) | `core/constants.ts` |
| Worker tick interval | — | 60s | `core/worker-loop.ts` |
| MCP rate limiter pruning | — | 5min | `server/mcp-server.ts` |

Session counters (cost, HTTP requests, write bytes) reset on process restart. Export `reset*()` functions for testing. The $50 session cost ceiling (`core/session-budget.ts`) is shared across spawn_agent tool calls AND pipeline step agents — neither path can bypass it. Persistent caps (`max_daily_cost_usd`, `max_monthly_cost_usd`, `max_http_requests_per_hour`, `max_http_requests_per_day`) survive restarts via SQLite queries against the `runs`/`run_tool_calls` tables in `history.db`.

## Testing

**103 test files / ~2481 tests** (offline) + **19 security tests** (`tests/security/agent-security.test.ts`) + **5 online test files / 22 tests** (real API). Framework: Vitest (`pool: 'forks'`, `testTimeout: 10_000`). Co-located `*.test.ts` beside source files. Integration tests in `tests/integration/`. Security tests in `tests/security/`. Performance benchmarks in `tests/performance/`.

```bash
npx vitest run                    # full offline suite (103 files / ~2481 tests)
npx vitest run tests/online/      # online tests with real Haiku API (~$0.02, ~35s)
NODYN_DEBUG=1 npx vitest run      # with debug output
```

### Offline Tests (mocked SDK)

Key patterns:
- Real filesystem via `mkdtemp` for fs/batch-files/batch-index/profiles/data-store
- Real HTTP server (port 0) for http-trigger tests
- `vi.mock` for SDK, child_process, node:fs, node:os, node:worker_threads
- `vi.useFakeTimers()` for cron/spinner/file-trigger debounce
- `BetaUsage` mocks require `as BetaUsage` cast (strict type has many required fields)
- Mock `node:fs` `watch` call access needs `(mock.calls[0] as unknown[])` cast
- Full suite and smoke scripts bind local ports; in restricted sandboxes may need unsandboxed shell

### Online Tests (`tests/online/`, real Haiku API)

End-to-end tests that make real LLM API calls via Haiku (~$0.001/call). **Not included in `npx vitest run`** — must be run explicitly. API key loaded from `~/.nodyn/config.json` or `ANTHROPIC_API_KEY` env var. Tests auto-skip when no key is available (`describe.skipIf`). Transient Anthropic 500/529 errors are caught and skipped, not reported as failures.

| File | Tests | Feature |
|------|-------|---------|
| `agent.test.ts` | 6 | Agent loop, multi-turn context, streaming, tool dispatch, maxIterations, error handling |
| `dag-planner.test.ts` | 4 | DAG decomposition, project context, step dependencies, model assignment |
| `entity-extractor.test.ts` | 5 | Person/org extraction, relations, German text, empty text, regex+LLM combo |
| `process-capture.test.ts` | 3 | Step naming, parameter identification, internal tool filtering |
| `memory-extraction.test.ts` | 4 | Fact extraction, short-skip, Q&A-skip, concurrent safety |

Shared setup in `tests/online/setup.ts`: `getApiKey()`, `hasApiKey()`, `createTmpDir()`, `HAIKU` constant.

### Performance Benchmarks (`tests/performance/`)

Vitest bench-based performance benchmarks. Config in `vitest.bench.config.ts`. JSON output to `tests/performance/results.json` (gitignored).

```bash
pnpm bench              # all offline benchmarks (~30s, no API key)
pnpm bench:online       # online benchmarks (requires API key, ~$0.02)
```

**Offline benchmarks** (7 files):

| File | What it measures |
|------|-----------------|
| `embedding.bench.ts` | ONNX cold/warm start, cosine similarity, blob serialization |
| `data-store.bench.ts` | SQLite collection CRUD, insert (single/batch), query with filters/sort/aggregation |
| `entity-extractor.bench.ts` | Regex tier entity extraction throughput |
| `security.bench.ts` | Injection detection, write scanning, tool result scanning, data wrapping |
| `memory.bench.ts` | Flat-file save/load/append/delete/render |
| `knowledge-graph.bench.ts` | LadybugDB init, entity/memory creation, Cypher queries |
| `history-truncation.bench.ts` | Message history truncation at various sizes and context pressures |

**Online benchmarks** (3 files in `online/`):

| File | What it measures | Cost |
|------|-----------------|------|
| `agent-loop.bench.ts` | Agent send() round-trip, streaming, multi-turn, tool dispatch | ~$0.005 |
| `retrieval-pipeline.bench.ts` | Full retrieval: embed → vector → graph → MMR, with/without HyDE | ~$0.01 |
| `dag-planner.bench.ts` | Haiku DAG decomposition for simple/medium/complex goals | ~$0.005 |

Shared setup in `tests/performance/setup.ts`: `createBenchDir()`, `generateText()`, `generateEntityText()`.

## Git Hooks & CI Security

- **lefthook** (`lefthook.yml`): pre-push runs `gitleaks protect --staged` + regex pattern scan for secrets + `security-scan` (static analysis via `scripts/security-scan.sh`); pre-commit runs typecheck
- **CI** (`.github/workflows/ci.yml`): `gitleaks/gitleaks-action@v2` scans full history, `npm run lint` (ESLint), `npm run typecheck`, `vitest run --coverage` (≥80% line coverage enforced), Trivy Docker scan
- `"prepare": "lefthook install || true"` in `package.json` — auto-installs hooks on `npm install`
- Requires `lefthook` + `gitleaks` binaries (`brew install lefthook gitleaks`)

## Dependencies

- `@anthropic-ai/sdk` — Anthropic API client
- `@modelcontextprotocol/sdk` — MCP server/client protocol
- `better-sqlite3` — Synchronous SQLite3 (native C++ addon). Requires `python3 make g++` build deps in Docker
- `@huggingface/transformers` — ONNX inference for local embeddings. Default model: `multilingual-e5-small` (384d, 100 languages, ~118MB). Configurable via `embedding_model` config. Docker uses `node:22-slim` (Debian) because `onnxruntime-node` requires glibc
- `@ladybugdb/core` — LadybugDB embedded graph database (Kuzu fork, Apple acquired Kuzu Oct 2025). Native C++ addon with prebuilt binaries. Used for Knowledge Graph (`~/.nodyn/knowledge-graph/`). Known issue: SIGSEGV on process exit (non-functional, after `close()`)
- `zod` — Schema validation for DAG manifests
- `eslint` + `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` — Linting (dev)
- `@vitest/coverage-v8` — Coverage reporting (dev)

## Docker & Deployment

Setup wizard handles first-time configuration. Docker supported via `--init` flag.

```bash
# npm (primary — wizard runs on first launch)
npx @nodyn-ai/core

# Docker (interactive setup)
docker run -it --rm -v ~/.nodyn:/home/nodyn/.nodyn ghcr.io/nodyn-ai/nodyn:latest --init

# Docker (direct start with env var)
docker run -it --rm -e ANTHROPIC_API_KEY=sk-ant-... -v ~/.nodyn:/home/nodyn/.nodyn ghcr.io/nodyn-ai/nodyn:latest
```

Entrypoint (`entrypoint.sh`): auto-loads `~/.nodyn/.env` (vault key), allows `--init` without API key env var, checks config file for stored key, MCP auth warning only for `--mcp-server` flag.

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint (optional) |
| `NODYN_MCP_SECRET` | Bearer token for MCP HTTP auth |
| `NODYN_WORKSPACE` | Workspace sandbox root (set to `/workspace` in Docker) |
| `NODYN_VAULT_KEY` | Master key for encrypted secret vault |
| `NODYN_EMBEDDING_PROVIDER` | Override: `onnx`, `voyage`, `local` |
| `NODYN_USER` | User scope identity for multi-scope memory |
| `NODYN_FEATURE_TENANTS` | Enable tenant isolation (off by default) |
| `NODYN_FEATURE_PLUGINS` | Enable plugin loading (off by default) |
| `NODYN_FEATURE_WORKER_POOL` | Enable worker pool (off by default) |
| `NODYN_DEBUG` | Debug logging: `1`/`true`/`*` for all, or comma-separated groups (`tool,spawn,dag,trigger,cost,preapproval,memory,secret`). `memory` group also includes memory extraction success/error events. `tool` group includes content truncation events. `trigger` group includes file watcher fallback events |
| `NODYN_DEBUG_FILE` | Write debug output to file instead of stderr |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token — auto-starts bot mode |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated chat IDs to restrict bot access |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (from GCP Console) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Absolute path to service account JSON key file (for headless/Docker). File must have 0o600/0o400 permissions, valid JSON with `type: "service_account"` |

### Config-Only Fields (`~/.nodyn/config.json`)

| Field | Default | Purpose |
|-------|---------|---------|
| `greeting` | `true` | Auto-greeting on interactive REPL start (uses Haiku, single API call with pre-loaded context). Set `false` to disable |
| `memory_extraction` | `true` | Automatic memory extraction from agent responses. Set `false` to disable (privacy opt-out) |
| `memory_half_life_days` | `90` | Memory temporal decay half-life in days |
| `pipeline_context_limit` | `16000` | Pipeline step context truncation limit (chars) |
| `pipeline_step_result_limit` | `51200` | Pipeline step result truncation limit (bytes) |
| `memory_extraction_limit` | `16000` | Memory extraction input truncation limit (chars) |
| `http_response_limit` | `100000` | HTTP response body size limit (bytes) |
| `max_tool_result_chars` | `80000` | Max chars per tool result before truncation |
| `knowledge_graph_enabled` | `true` | Knowledge Graph is mandatory. Field retained for migration compatibility but ignored — KG is always initialized |
| `embedding_model` | `multilingual-e5-small` | ONNX model: `all-minilm-l6-v2` (23MB, EN-only), `multilingual-e5-small` (118MB, 100 langs), `bge-m3` (570MB, 1024d) |
| `google_oauth_scopes` | read-only | Override Google OAuth scopes. Default: `READ_ONLY_SCOPES`. Add write scopes (`WRITE_SCOPES`) as needed |
| `enforce_https` | `false` | Block plain HTTP requests (except localhost). When `true`, only HTTPS allowed for external URLs |

### Persistence Volumes

- `nodyn-config:/home/nodyn/.nodyn` — config, history.db, vault.db, datastore.db, roles, plugins, memory

### Dockerfile

4-stage build on `node:22-slim` (Debian slim, pinned digest, glibc required by onnxruntime-node):
1. **build** — `npm ci --ignore-optional`, compiles TypeScript
2. **deps** — `npm ci --omit=dev --ignore-optional`, production dependencies only
3. **whisper-build** — compiles whisper.cpp (pinned v1.8.4, `GGML_NATIVE=OFF`) + downloads ggml-base.bin (sha256-verified)
4. **production** — only `dist/`, prod `node_modules/`, ffmpeg, wget, whisper-cli + shared libs (libwhisper, libggml), model. No source code, no build tools, no npm/npx

Hardening: non-root `nodyn:1001`, `read_only: true` root, `tmpfs /tmp`, `no-new-privileges`, `STOPSIGNAL SIGTERM`, OCI labels, wget-based health check. Attack surface reduced: apt/dpkg/perl/bash removed, all SUID bits stripped, root/node login shells set to nologin. CI: Trivy scan (CRITICAL/HIGH) gates push, semver + SHA + latest tags. Network egress documented in `docs/docker.md` (required domains, iptables example).
