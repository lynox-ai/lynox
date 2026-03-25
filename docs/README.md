# nodyn Documentation

Open agent engine — persistent knowledge, autonomous workflows, tool connections.

## Start Here

- [Getting Started](getting-started.md) — install and first run
- [CLI Reference](cli.md) — slash commands and modes
- [Configuration](configuration.md) — settings and environment variables

## By Goal

### Get running
[Getting Started](getting-started.md) → [CLI Reference](cli.md) → [Configuration](configuration.md)

### Automate business tasks
[Knowledge](memory.md) → [Workflows](dag-engine.md) → [Pre-Approve](pre-approve.md)

### Connect your tools
[Telegram Bot](telegram.md) → [Google Workspace](google-workspace.md) → [MCP Server](mcp-server.md)

### Build on nodyn
[SDK](sdk.md) → [Extension Points](extension-points.md) → [Batch API](batch-api.md)

### Deploy to production
[Docker](docker.md) → [Security](security.md) → [Configuration](configuration.md)

### Measure performance
[Benchmarks](benchmarks.md)

## All Documents

| Document | Description |
|----------|-------------|
| [Getting Started](getting-started.md) | Installation, setup wizard, first run |
| [CLI Reference](cli.md) | Modes, flags, slash commands, UI components |
| [Configuration](configuration.md) | Config tiers, env vars, profiles |
| [Knowledge](memory.md) | Storage, scopes, auto-extraction, retrieval |
| [Workflows](dag-engine.md) | Multi-step automation, dependency graphs, conditions |
| [Tools](tools.md) | Tool system, 10+ builtin tools reference |
| [Security](security.md) | Permission guard, SSRF protection, path validation |
| [Docker](docker.md) | Container deployment, production hardening |
| [Telegram Bot](telegram.md) | Setup, commands, inline keyboards, file handling |
| [Google Workspace](google-workspace.md) | Gmail, Sheets, Drive, Calendar, Docs |
| [MCP Server](mcp-server.md) | nodyn as MCP server (stdio + HTTP) |
| [SDK](sdk.md) | Use nodyn as a TypeScript library |
| [Pre-Approve](pre-approve.md) | Glob-based auto-approval, audit trail |
| [Batch API](batch-api.md) | Batch processing, index, CLI commands |
| [Agent Loop](agent-loop.md) | Agentic loop, streaming, tool dispatch, caching |
| [Architecture](architecture.md) | Module map, data flow, design decisions |
| [Extension Points](extension-points.md) | Mode registry, hooks, CLI commands, feature flags |
| [CI/CD](ci.md) | Test workflow, local validation |
| [Benchmarks](benchmarks.md) | Performance benchmarks, baselines, regression detection |
| [Slack](slack.md) | Slack integration (Pro feature) |

## Pro Features

The following features are available in [`nodyn-pro`](https://github.com/nodyn-ai/nodyn-pro) (separate repository, commercial license):

- Slack integration (Socket Mode, MCP bridge)
- Watchdog, Background, Team operational modes
- Tenant isolation (multi-tenant, 4 isolation levels)
- Worker pool (thread-based parallel execution)
- Docker Compose multi-service deployment

## Project

- **Runtime:** Node.js 22+, ESM-only TypeScript
- **License:** Elastic License 2.0 (source-available)
- **Package:** `@nodyn-ai/core`

## Validation Baseline

- Current verified baseline: `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest run` (`113` files / `2610` tests, coverage ≥80%), and `npm run smoke:manual`
- Online integration tests: `npx vitest run tests/online/` (`5` files / `22` tests, real Haiku API, ~$0.02)
- Performance benchmarks: `pnpm bench` (offline, ~30s) + `pnpm bench:online` (~$0.02)
- Real API smoke is available via `NODYN_SMOKE_ONLINE=1 npm run smoke:manual` and requires a configured API key
