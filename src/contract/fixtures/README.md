# Contract fixtures — golden wire bytes (source-only, never in `dist/`)

One JSON file per wire shape (`http.ts` + `shapes.ts`). Each is **generated
from the real serializer** named below and re-verified against it on every CI
run — never hand-edit a fixture; change the serializer (a wire-contract
change) and let the generator test tell you the new golden bytes.

Value rules (PRD-CORE-PRO-CONTRACT S4): canonical obviously-fake values only
(`TEST-…` tokens, `*.invalid` hosts, repeated-pattern SHAs) — no
entropy-realistic tokens, no real subdomains or customer names, no
production-mirroring secret lengths. `tests/contract-http.test.ts` enforces
this mechanically for every string leaf.

| Fixture | Shape (`http.ts`/`shapes.ts`) | Serializer (generator) | Parser (pair side) |
|---|---|---|---|
| `usage-flush-request.json` | `UsageFlushRequest` | engine `src/core/managed-hook.ts` `flush()` — captured in `src/core/managed-hook.test.ts` | CP `api/internal/usage.ts` POST handler |
| `usage-flush-response.json` | `UsageFlushResponse` | CP `api/internal/usage.ts` POST handler (pro pair test) | engine `managed-hook.ts` `flush()` — driven in `src/core/managed-hook.test.ts` |
| `usage-status-response.managed.json` | `UsageStatusResponse` | CP `api/internal/usage.ts` GET /status (pro pair test) | engine `managed-hook.ts` `syncStatus()` — driven in `src/core/managed-hook.test.ts` |
| `usage-status-response.hosted.json` | `UsageStatusResponse` | CP `api/internal/usage.ts` GET /status, non-managed branch | engine `managed-hook.ts` `syncStatus()` |
| `usage-summary-response.managed.json` | `UsageSummaryResponse` | CP `api/internal/usage.ts` GET /summary (pro pair test) | engine `src/core/managed-usage-summary.ts` — driven in its test |
| `usage-summary-response.not-managed.json` | `UsageSummaryResponse` | CP `api/internal/usage.ts` GET /summary, non-managed branch | engine `src/core/managed-usage-summary.ts` |
| `health-body.json` | `HealthBody` | engine `src/server/http-api.ts` `_collectHealthMetrics()` — shape-verified in `src/server/http-api.test.ts` | CP `update-manager.ts` + `health-monitor.ts` |
| `health-body.with-sha.json` | `HealthBody` (non-null `build_sha` variant) | same serializer, `BUILD_SHA` build-arg set | CP `update-manager.ts` build_sha rollout gate |
| `model-profile.json` | `shapes.ts` `ModelProfile` | CP config generator emits it (pro pair test); guarded here by `isModelProfile` in `tests/contract-http.test.ts` | engine `src/core/config.ts` via `isModelProfile` |
