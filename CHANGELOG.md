# Changelog

## 1.0.4 — Multi-Provider Support (2026-04-15)

### Added

- **Native OpenAI-compatible provider adapter** — Use Mistral, Gemini, and any OpenAI-compatible API directly via a dedicated adapter, no proxy layer required.
- **Google Vertex AI (Claude)** — Connect Claude models via Google Vertex AI using OAuth, enabling regional deployment (EU, US) without BYOK API keys.
- **`llm_mode` toggle** — New configuration switch for EU-sovereign operation: when set to `eu-sovereign`, the engine runs Mistral-only without contacting Anthropic endpoints.
- **Postinstall hint** — `npm i -g @lynox-ai/core` now prints a one-liner steering users toward the recommended `npx @lynox-ai/core` or Docker Compose workflow for zero-config startup.

### Changed

- **Provider stack clarified** — Core now ships with Anthropic direct, Mistral direct (via OpenAI-compat adapter), Vertex AI (for Claude), and AWS Bedrock as BYOK. Managed hosting uses Anthropic + Mistral as native; Bedrock is BYOK-only.
- **CI coverage threshold** — Aligned global threshold with `vitest.config.ts` (65% lines, was 70%).
- **npm publish** — Removed OIDC provenance from the release workflow (operational fix for auth reliability).

### Fixed

- Bedrock 400 error when provider-incompatible `beta` flags were passed through (already in 1.0.3, noted here for completeness).

---

## 1.0.1 – 1.0.3

Incremental patches released without changelog entries. See `git log v1.0.0..v1.0.3` for the full history. Highlights:

- **1.0.3** — Prompt cache TTL fix (`ephemeral_1h` for Anthropic, `ephemeral` for Bedrock)
- **1.0.2** — Prompt caching uses correct extended TTL syntax
- **1.0.1** — npm publish auth fix (NPM_TOKEN with provenance, later removed in 1.0.4)

## 1.0.0 — Initial Release

One system that learns your business — replaces your CRM, workflows, outreach, and monitoring. Self-hosted, open, yours.

### Core

- **Agentic loop** — Streaming tool dispatch with adaptive thinking, automatic retry with exponential backoff, parallel tool execution via `Promise.allSettled`
- **Roles** — 4 built-in roles (Researcher, Creator, Operator, Collector) with tool scoping and isolated budgets
- **Engine/Session** — Engine (shared singleton) + Session (per-conversation) architecture enabling REPL + Telegram + MCP in one process
- **Persistent AI Worker** — WorkerLoop for background task execution with cron scheduling, watch-URL polling, and multi-turn conversations
- **Cost tracking** — Per-model pricing with cache token accounting (write 1.25x, read 0.1x) and budget enforcement via CostGuard

### Knowledge

- **Unified Agent Memory** — SQLite-based (crash-safe, WAL mode) with 9 tables: semantic memories, entity graph, episodic log, pattern detection, KPI metrics. Confidence evolution, memory consolidation, retrieval feedback loop
- **Knowledge Graph Retrieval** — HyDE query expansion, multi-signal search (vector 55% + graph 15% + episodic 10%), confidence multiplier with unconfirmed decay, MMR re-ranking, pattern + episode context injection
- **Persistent business knowledge** — Context-scoped flat-file storage with auto-extraction and selective extraction prompts
- **Knowledge levels** — Three tiers: organization, project, personal — with configurable relevance weights
- **Embeddings** — Local ONNX (multilingual-e5-small, 384d, 100 languages), fully offline
- **Auto role selection** — Simple tasks auto-downgrade to Haiku for cost optimization

### Tools (13 built-in)

- `bash` — Shell execution with dangerous command detection and environment sanitization
- `read_file` / `write_file` — File operations with path traversal protection and symlink validation
- `memory` — Store, recall, delete, update, list, promote across knowledge levels
- `spawn_agent` — Parallel sub-agents with per-agent budget limits and role-based scoping
- `ask_user` — Interactive user input with select, confirm, and freeform modes
- `batch_files` — Multi-file rename, move, and transform operations
- `http` — External API calls with SSRF protection, redirect handling, and network policy enforcement
- `run_pipeline` — Multi-step workflow execution with dependency graphs and parallel steps
- `task` — Task management with priority, due dates, scheduling, and watch-URL monitoring
- `plan_task` — Structured planning with automatic workflow conversion
- `data_store` — Structured SQLite storage with typed columns, filters, and aggregation
- `capture_process` / `promote_process` — Turn ad-hoc work into reusable workflows

### Automation

- **Workflow engine** — Declarative manifests with dependency graphs, parallel execution, conditions, and template syntax
- **Process capture** — Record what you did, save it as a reusable workflow with parameters
- **File trigger** — File system watcher with glob matching and debounce (CLI `--watch`)
- **Advisor** — Analyzes run history for patterns, suggests optimizations

### Integration

- **Telegram bot** — Primary mobile/async interface with rich status messages, inline keyboards, and follow-up suggestions
- **MCP server** — stdio + HTTP SSE transport with sync and async lifecycle, Bearer token auth, and per-IP rate limiting
- **Plugin system** — Validated plugin loading from `~/.lynox/plugins/`

### Security

- **Secret vault** — AES-256-GCM encrypted SQLite storage with PBKDF2 (600K iterations, SHA-512)
- **Multi-source secrets** — Environment variables, vault, and config with `secret:KEY` reference pattern
- **Pre-approval system** — Glob-based auto-approval with critical tool blocking, TTL, max-uses, and audit trail
- **Permission guard** — Critical/dangerous command detection with business-friendly block messages
- **Input guard** — Content policy scanning before LLM processing
- **Output guard** — Write content validation and injection detection

### Data

- **DataStore** — SQLite-based structured storage with agent-defined collections, typed columns, filter-to-SQL translation, aggregation, and upsert
- **DataStore ↔ Knowledge Graph bridge** — Automatic entity linking between structured data and the knowledge graph
- **Run history** — SQLite with WAL mode, 19 migrations, tracking runs, tool calls, spawns, workflows, and security events

### Infrastructure

- **Docker** — Single-stage `node:22-slim` image, non-root user, read-only root filesystem, tmpfs, no-new-privileges
- **Config system** — 3-tier merge (env > project > user) with project-safe allowlist
- **Setup wizard** — First-run guided configuration with API key validation and accuracy level selection
- **CLI** — 40+ slash commands for conversation, model control, project management, tools, knowledge, automation, tasks, history, and identity
