# CLAUDE.md

## Project

lynox — business runtime engine + web UI. ESM-only TypeScript, Node.js 22+.
Public OSS repo (lynox-ai/lynox). pnpm workspace with 2 packages.
Internal docs in private lynox-pro repo.

## Commands

```bash
# Engine (@lynox-ai/core)
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # eslint src/
pnpm run build       # tsc → dist/
pnpm run dev         # watch mode with tsx
pnpm run security    # security scan + vitest security tests
npx vitest run       # 115 test files / ~2680 tests
npx vitest run tests/online/  # 22 real API tests

# Web UI (@lynox-ai/web-ui)
cd packages/web-ui && pnpm run dev        # standalone dev server (needs Engine --http-api running)
cd packages/web-ui && pnpm run build      # build standalone SvelteKit app
cd packages/web-ui && pnpm run package    # build library (dist/) for pro/pwa import
cd packages/web-ui && pnpm run typecheck  # svelte-check
```

## Architecture

pnpm workspace: root = `@lynox-ai/core` (engine), `packages/web-ui/` = `@lynox-ai/web-ui` (standalone web UI).

### Engine (`@lynox-ai/core`, root)

Engine (singleton) + Session (per-conversation) + ThreadStore (persistent threads) + WorkerLoop (background tasks).

- `src/core/` — 67 modules: engine, session, thread-store, agent, worker-loop, agent-memory-db, knowledge-layer, pattern-engine, memory, sentry, backup, api-store, crm, etc.
- `src/cli/` — Terminal UI + 14 command handler modules
- `src/tools/` — 17 builtin tools (incl. api_setup, artifact_save/list/delete) + permission guard
- `src/orchestrator/` — DAG pipeline engine
- `src/integrations/` — Telegram, Google Workspace, Web Search
- `src/server/` — MCP server (stdio + HTTP SSE), Engine HTTP API (REST + SSE for PWA)
- `src/types/` — 12 domain type files, barrel re-export via index.ts

### Web UI (`@lynox-ai/web-ui`, packages/web-ui/)

SvelteKit 2 + Svelte 5 + Tailwind v4. Dual-purpose: standalone app + component library.

- `src/lib/components/` — 30 components: ChatView (interleaved blocks), AppShell, ThreadList, MemoryView, HistoryView, ArtifactsView, KnowledgeGraphView, WorkflowsHub (list + analytics), WorkflowsView (expandable step details), PipelineProgress (sticky during execution), MarkdownRenderer (deferred artifact rendering), ContextPanel, ContactsView, DataStoreView, CommandPalette, StatusBar, etc.
- `src/lib/stores/chat.svelte.ts` — SSE streaming chat store with configurable API base, thread resume, interleaved ContentBlock rendering (text + tool_call blocks in chronological order)
- `src/lib/stores/threads.svelte.ts` — Thread list store (load, archive, delete, rename)
- `src/lib/stores/artifacts.svelte.ts` — Artifact gallery store (save, load, delete)
- `src/lib/config.svelte.ts` — configurable `apiBase` (/api/engine for standalone, /api/proxy for cloud)
- `src/lib/i18n.svelte.ts` — DE/EN translations (reactive, runtime switchable)
- `src/lib/index.ts` — barrel export for library consumers
- `src/routes/` — standalone app routes (thin wrappers around View components)
- `src/routes/api/engine/[...path]/` — proxy to Engine HTTP API (single-user, no auth)

**Chat rendering:** Tool calls render as user-facing inline text (e.g. "Daten abgefragt: revenue") interleaved with markdown content in chronological order via `ContentBlock[]`. Artifacts defer iframe rendering during streaming (syntax-highlighted code shown instead) to prevent flicker. PipelineProgress shows as a sticky bar above the input during workflow execution.

Pro/pwa imports `@lynox-ai/web-ui` and wraps View components with Lucia auth + onboarding.

**Interface priority:** Web UI (primary) → Telegram (secondary, mobile) → CLI (developer).
Telegram is pure task execution — setup/admin redirects to Web UI.

Docs source (Astro Starlight) in `docs/src/content/docs/` — organized by category:
- `getting-started/`, `daily-use/`, `features/`, `developers/`
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
- Security: 6 layers (input-guard, output-guard, permission-guard, data-boundary, secret-store, security-audit)
- Roles: 4 built-in (researcher, creator, operator, collector) as const map
- Background tasks: WorkerLoop + CronParser + NotificationRouter
- Agent Memory: SQLite (AgentMemoryDb, `~/.lynox/agent-memory.db`) — entity graph, thread insights (per-thread aggregated stats), pattern detection, KPI metrics, confidence evolution, memory consolidation, retrieval feedback loop. ONNX embeddings, brute-force cosine search, recursive CTE graph traversal
- Backup: VACUUM INTO + AES-256-GCM encryption + GDrive upload
- API Store: profile-first enforcement, agent-driven setup
- CRM: agent-driven contacts/deals, entity-primary, DataStore for structured tracking
- Sentry: opt-in error reporting (LYNOX_SENTRY_DSN), PII scrubbed

## Testing

110 offline test files / ~2658 tests. Co-located *.test.ts.
19 security audit tests in tests/security/.
5 online test files / 22 tests (real Haiku API).
Coverage enforced on src/core/, src/tools/, src/orchestrator/ (>=70%).

## Git

- Pre-commit: typecheck
- Pre-push: gitleaks + pattern-scan + security-scan
- Commits: English, imperative, first line <70 chars

## Docker

**Engine-only** (`Dockerfile`): 4-stage build on debian:trixie-slim (~523 MB). Non-root lynox:1001.
Entrypoint: entrypoint.sh (vault key auto-load, --version/--help without API key).
Healthcheck: `GET /health` → `{"status":"ok"}` on MCP port.
Hardened: no bash, no apt, no perl, no SUID, read-only root.

**Engine + Web UI** (`Dockerfile.web-ui`): Combined image for self-hosted single-user deployment.
Entrypoint: entrypoint-webui.sh (starts Engine --http-api + SvelteKit web-ui).
`docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/lynox-ai/lynox:webui`
