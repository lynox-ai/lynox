# CLAUDE.md

## Project

lynox — the AI that knows your business. ESM-only TypeScript, Node.js 22+.
Public OSS repo (lynox-ai/lynox). Internal docs in private lynox-pro repo.

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
npm run build       # tsc → dist/
npm run dev         # watch mode with tsx
npm run security    # security scan + vitest security tests
npx vitest run      # 113 test files / ~2601 tests
npx vitest run tests/online/  # 22 real API tests
```

## Architecture

Engine (singleton) + Session (per-conversation) + WorkerLoop (background tasks).

- `src/core/` — 66 modules: engine, session, agent, worker-loop, KG, memory, sentry, backup, api-store, crm, etc.
- `src/cli/` — Terminal UI + 14 command handler modules
- `src/tools/` — 14 builtin tools (incl. api_setup) + permission guard
- `src/orchestrator/` — DAG pipeline engine
- `src/integrations/` — Telegram, Google Workspace, Web Search
- `src/server/` — MCP server (stdio + HTTP SSE)
- `src/types/` — 12 domain type files, barrel re-export via index.ts

See `docs/src/content/docs/` for documentation source (Astro Starlight site).

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
- KG: LadybugDB graph + ONNX embeddings + entity extraction + contradiction detection
- Backup: VACUUM INTO + AES-256-GCM encryption + GDrive upload
- API Store: profile-first enforcement, agent-driven setup
- CRM: agent-driven contacts/deals, KG-primary, DataStore for structured tracking
- Sentry: opt-in error reporting (LYNOX_SENTRY_DSN), PII scrubbed

## Testing

113 offline test files / ~2601 tests. Co-located *.test.ts.
19 security audit tests in tests/security/.
5 online test files / 22 tests (real Haiku API).
Coverage enforced on src/core/, src/tools/, src/orchestrator/ (>=70%).

## Git

- Pre-commit: typecheck
- Pre-push: gitleaks + pattern-scan + security-scan
- Commits: English, imperative, first line <70 chars

## Docker

4-stage build on debian:trixie-slim (~523 MB). Non-root lynox:1001.
Entrypoint: entrypoint.sh (vault key auto-load, --version/--help without API key).
Healthcheck: `GET /health` → `{"status":"ok"}` on MCP port.
Hardened: no bash, no apt, no perl, no SUID, read-only root.
