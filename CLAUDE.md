# CLAUDE.md

## Project

nodyn — the AI that knows your business. ESM-only TypeScript, Node.js 22+.
Public OSS repo (nodyn-ai/nodyn). Internal docs in private nodyn-pro repo.

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

- `src/core/` — 60 modules: engine, session, agent, worker-loop, KG, memory, etc.
- `src/cli/` — Terminal UI + 11 command handler modules
- `src/tools/` — 14 builtin tools + permission guard
- `src/orchestrator/` — DAG pipeline engine
- `src/integrations/` — Telegram, Google Workspace, Web Search
- `src/server/` — MCP server (stdio + HTTP SSE)
- `src/types/` — 11 domain type files, barrel re-export via index.ts

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

4-stage build on debian:trixie-slim. Non-root nodyn:1001.
Entrypoint: entrypoint.sh (vault key auto-load).
