# CI/CD

## Overview

GitHub Actions runs tests on every push to `main` and on pull requests.

| Job | Trigger | What it does |
|-----|---------|--------------|
| `test` | push + PR | typecheck + vitest |

## Pipeline

```
git push origin main
    ↓
GitHub Actions: npm ci → tsc --noEmit → vitest run
```

## Manual Release Gate

CI runs `typecheck` + `vitest`, but the stronger local pre-release gate is:

```bash
npm run typecheck
npm run build
npx vitest run
npm run smoke:manual
```

Optional real API validation:

```bash
ANTHROPIC_API_KEY=... NODYN_SMOKE_ONLINE=1 npm run smoke:manual
```

`npm run smoke:manual` starts a local MCP server, checks `/health`, verifies the auth guard, and runs an offline MCP client lifecycle. The online variant adds a real `nodyn_run_start` / `nodyn_poll` round-trip. On restricted desktop sandboxes, local port binding may require an unsandboxed shell.

## Workflow File

`.github/workflows/ci.yml`

- **`test` job**: `ubuntu-latest`, Node 22, runs `npm ci` + `npm run typecheck` + `npx vitest run`

## Monitoring

- Actions tab: GitHub repository → Actions tab

## Online Tests (`tests/online/`)

22 end-to-end tests that make real Haiku API calls (~$0.02 per full run, ~35s). These verify the full LLM integration path — not mocked.

```bash
npx vitest run tests/online/         # run all online tests
NODYN_DEBUG=1 npx vitest run tests/online/  # with debug output
```

**Not included in CI or `npx vitest run`** — must be run explicitly. Requires an API key via `~/.nodyn/config.json` or `ANTHROPIC_API_KEY` env var. Tests auto-skip when no key is available.

| File | Tests | What it verifies |
|------|-------|------------------|
| `agent.test.ts` | 6 | Agent loop, multi-turn context, streaming, tool dispatch, maxIterations, error handling |
| `dag-planner.test.ts` | 4 | DAG decomposition, project context, step dependencies, model assignment |
| `entity-extractor.test.ts` | 5 | Person/org extraction, relations, German text, empty text, regex+LLM combo |
| `process-capture.test.ts` | 3 | Step naming, parameter identification, internal tool filtering |
| `memory-extraction.test.ts` | 4 | Fact extraction, short-skip, Q&A-skip, concurrent safety |

Transient Anthropic 500/529 errors are caught and logged, not reported as test failures. Shared setup in `tests/online/setup.ts`.

## Performance Benchmarks (`tests/performance/`)

Vitest bench-based performance benchmarks. See [benchmarks.md](benchmarks.md) for full documentation.

```bash
pnpm bench              # offline benchmarks (~30s, no API key)
pnpm bench:online       # online benchmarks (requires API key, ~$0.02)
```

7 offline benchmark files (embedding, data-store, entity-extractor, security, memory, knowledge-graph, history-truncation) + 3 online files (agent-loop, retrieval-pipeline, dag-planner). Results saved to `tests/performance/results.json` (gitignored). Baselines committed in `tests/performance/baselines/`.

## Local Equivalent

```bash
# What CI runs:
npm ci
npm run typecheck
npx vitest run

# Stronger local gate before shipping:
npm run build
npm run smoke:manual
pnpm bench

# Optional online smoke:
ANTHROPIC_API_KEY=... NODYN_SMOKE_ONLINE=1 npm run smoke:manual

# Online integration tests (real Haiku API, ~$0.02):
npx vitest run tests/online/

# Performance benchmarks (online, ~$0.02):
pnpm bench:online

# Build Docker image locally:
docker build -t nodyn .
```
