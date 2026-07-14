# CLAUDE.md

## Project

lynox — business runtime engine + web UI. ESM-only TypeScript, Node.js 22+.
Public source-available repo under ELv2 (lynox-ai/lynox). pnpm workspace with 2 packages.
Internal docs in private lynox-pro repo.

## Commands

```bash
# Engine (@lynox-ai/core)
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # eslint src/
pnpm run build       # tsc → dist/
pnpm run dev         # watch mode with tsx
pnpm run security    # security scan + vitest security tests
npx vitest run       # ~200 test files (src + tests/)
npx vitest run tests/online/  # 10 test files (real API)

# Web UI (@lynox-ai/web-ui)
cd packages/web-ui && pnpm run dev        # standalone dev server (needs Engine running: `lynox` or `lynox --http-api`)
cd packages/web-ui && pnpm run build      # build standalone SvelteKit app
cd packages/web-ui && pnpm run package    # build library (dist/) for pro/pwa import
cd packages/web-ui && pnpm run typecheck  # svelte-check
```

## Architecture

pnpm workspace: root = `@lynox-ai/core` (engine), `packages/web-ui/` = `@lynox-ai/web-ui` (standalone web UI).

### Engine (`@lynox-ai/core`, root)

Engine (singleton) + Session (per-conversation) + ThreadStore (persistent threads) + WorkerLoop (background tasks).

- `src/core/` — ~130 modules: engine, session, thread-store, prompt-store, agent, worker-loop, agent-memory-db, engine-db (subject-graph store, flag-gated OFF), subject-store, knowledge-layer, memory-facade, subject-merge-runner, pattern-engine, memory, error-reporting, backup, api-store, crm, migration-crypto, migration-export, migration-import, workspace, etc.
- `src/cli/` — Terminal utilities (ansi, spinner, stream-handler, docker-installer, approval-dialog, changeset-review, dag-visualizer, markdown, interactive)
- `src/tools/builtin/` — 41 builtin tool functions across 22 modules (incl. api_setup, media_process, artifact_save/list/delete/history/restore, subjects_merge); `src/tools/` holds the registry + permission guard
- `src/orchestrator/` — DAG pipeline engine
- `src/integrations/` — Mail (IMAP/SMTP), Unified Inbox, Google Workspace, Web Search (SearXNG default, DuckDuckGo HTML-scrape fallback), Push notifications. (Telegram removed 2026-05-15 — see `src/index.ts` comment + `docs/src/content/docs/setup/remote-access.md`. WhatsApp removed 2026-05-23 pending staging E2E coverage — see `docs/src/content/docs/archive/whatsapp-inbox.md`.)
- `src/server/` — Engine HTTP API (REST + SSE for PWA). (MCP server removed 2026-05-23 pending re-introduction with full E2E test coverage — see core PR #536.)
- `src/types/` — 15 domain type files, barrel re-export via index.ts

### Web UI (`@lynox-ai/web-ui`, packages/web-ui/)

SvelteKit 2 + Svelte 5 + Tailwind v4. Dual-purpose: standalone app + component library.

- `src/lib/components/` — ~75 components, ~75 exports via `lib/index.ts` for `pro/pwa` consumers. Entry points: ChatView (interleaved blocks), AppShell, SettingsIndex, ChannelHub, IntelligenceHub, AutomationHub, InboxView. Full authoritative list in `packages/web-ui/src/lib/index.ts`.
- `src/lib/stores/chat.svelte.ts` — SSE streaming chat store with configurable API base, thread resume, interleaved ContentBlock rendering (text + tool_call blocks in chronological order)
- `src/lib/stores/threads.svelte.ts` — Thread list store (load, archive, delete, rename)
- `src/lib/stores/artifacts.svelte.ts` — Artifact gallery store (save, load, delete)
- `src/lib/stores/context-panel.svelte.ts` — Side panel state (active context: tool, entity, file; pin state)
- `src/lib/stores/migration.svelte.ts` — Migration wizard store (preview, ECDH handshake, SSE transfer progress, provisioning poll)
- `src/lib/stores/toast.svelte.ts` — Toast notifications (success, error, info; auto-dismiss)
- `src/lib/config.svelte.ts` — configurable `apiBase` (/api for standalone, /api/proxy for cloud)
- `src/lib/i18n.svelte.ts` — DE/EN translations (reactive, runtime switchable)
- `src/lib/index.ts` — barrel export for library consumers
- `src/routes/` — standalone app routes (thin wrappers around View components)

**Chat rendering:** Tool calls render as user-facing inline text (e.g. "Daten abgefragt: revenue") interleaved with markdown content in chronological order via `ContentBlock[]`. Artifacts defer iframe rendering during streaming (syntax-highlighted code shown instead) to prevent flicker. PipelineProgress shows as a sticky bar above the input during workflow execution.

Pro/pwa imports `@lynox-ai/web-ui` and wraps View components with Lucia auth + onboarding.

**Interface priority:** Web UI (primary) → PWA + mail/voice (mobile) → CLI (headless/automation).
No interactive REPL — CLI is for single-task, watch, manifest, and server modes only.

Docs source (Astro Starlight) in `docs/src/content/docs/` — organized by category:
- `getting-started/`, `daily-use/`, `features/`, `setup/`, `developers/`, `integrations/`, `archive/`
- Sidebar uses `autogenerate` — add new page = drop `.md` file + set `sidebar.order` frontmatter
- CI: `docs.yml` builds docs on `docs/**` changes; `ci.yml` ignores `docs/**`

## TypeScript Rules

- strictest: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
- Zero `any` — use unknown + narrowing
- All imports use .js extensions (ESM + NodeNext)
- Optional properties: T | undefined (required by exactOptionalPropertyTypes)
- ESLint: no-explicit-any, no-floating-promises, consistent-type-imports

## Key Patterns

- Types: single source of truth in src/types/index.ts — never duplicate
- Tools: ToolRegistry + ToolContext dependency injection
- Security: 5 layers actually wired (input-guard, permission-guard, data-boundary, secret-store, security-audit) + tool-result injection scan (`scanToolResult` in `src/core/output-guard.ts`) + malicious-write scan (`checkWriteContent` in `output-guard.ts`, wired into `write_file`/`edit_file`) + configurable outbound network policy (`network_policy`: allow-all default / deny-all / allow-list, gates `http_request`/`api_setup`/`web_research`). `ToolCallTracker` (tool-call anomaly detector) is wired via `Session._toolCallTracker`. Env vars always override vault (priority: env > vault > config).
- Cost & rate limits: Session $50, daily $100, monthly $500 (all configurable via config.json). HTTP tool: 200 req/hr, 2000 req/day default. Per-session: 100 HTTP requests, 500 max agent iterations. Spawn depth: 5 levels, $5 default budget per spawn.
- Resumable Prompts: PromptStore (SQLite, shared DB with RunHistory) — ask_user/ask_secret survive SSE disconnects, page refreshes, thread switches. Agent polls SQLite every 2s. 24h expiry.
- Roles: 4 built-in (researcher, creator, operator, collector) as const map
- Background tasks: WorkerLoop + CronParser + NotificationRouter
- Agent Memory: SQLite (AgentMemoryDb, `~/.lynox/agent-memory.db`) — entity graph, thread insights (per-thread aggregated stats), pattern detection, KPI metrics, confidence evolution, memory consolidation, retrieval feedback loop. ONNX embeddings, brute-force cosine search, recursive CTE graph traversal. The Foundation-Rework-v2 subject-graph store (`engine.db`, `engine-db.ts`/`subject-store.ts`) is flag-gated OFF (`subject_graph_enabled` config / `LYNOX_SUBJECT_GRAPH_ENABLED` env) — legacy agent-memory path stays default until a per-tenant cutover
- Backup: VACUUM INTO + AES-256-GCM encryption + GDrive upload
- Migration: Zero-knowledge self-hosted→managed transfer. X25519 ECDH + AES-256-GCM chunk encryption + HMAC-signed handshake. Engine-to-engine (browser orchestrates via SSE). Migration token auth, DB name whitelist, 64 chunks × 8 MB each (~512 MB total ceiling).
- API Store: profile-first enforcement, agent-driven setup
- CRM: agent-driven contacts/deals, entity-primary, DataStore for structured tracking
- Bugsink: error reporting, PII scrubbed. Managed: always active (Art. 6(1)(f) legitimate interest, self-hosted EU). Self-hosted: opt-in via LYNOX_BUGSINK_DSN.
- i18n: write each language natively with same meaning — never translate one from the other. Translated text reads unnaturally.

## Testing

~180 co-located *.test.ts in src/, ~20 in tests/ (integration + security + smoke).
Online tests in tests/online/ (real Haiku API).
Coverage enforced on src/core/, src/tools/, src/orchestrator/, src/cli/, src/integrations/ (lines >=65%, functions >=60%, branches >=50%, statements >=65%).

## Git

- Pre-commit: typecheck + hex-guard
- Pre-push: gitleaks + pattern-scan + security-scan + public-repo-guard (internal-infra leaks) + drift-guard (doc/code drift) + positioning-guard (copy vs POSITIONING.md). All three guards re-run as required CI checks so `--no-verify` can't bypass them.
- Commits: English, imperative, first line <70 chars

## Docker

**Single image** (`Dockerfile`): Combined Engine + Web UI for all deployments.
Single process: Engine HTTP API auto-loads SvelteKit handler as fallback for non-API routes.
Entrypoint: entrypoint-webui.sh (env setup, then `exec node dist/index.js --http-api`).
LLM credentials are optional at startup — without them, engine starts in browse mode and SetupBanner shows a provider-aware wizard (Anthropic / Mistral / Custom — OpenAI-compat proxy) to enter credentials via the UI (stored in vault). Vertex is no longer offered by the installer or in-product wizard but stays wired for existing `provider: 'vertex'` config.json setups. Never set placeholder env vars as env vars override vault.
Web UI handler resolved from `/app/web-ui/handler.js` (adapter-node export).
`docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/lynox-ai/lynox:latest`

**Docker Compose** (`docker-compose.yml`): Recommended deployment method.
Bundles Engine+Web UI with SearXNG sidecar for free, unlimited web search.
`docker compose up` — serves on :3000, SearXNG on internal :8080.
Env: ANTHROPIC_API_KEY required, SEARXNG_URL pre-configured to http://searxng:8080.
SearXNG settings in `searxng/settings.yml` (optimized engine selection, JSON API enabled).
