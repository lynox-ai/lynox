# Contract fixtures — golden wire bytes (source-only, never in `dist/`)

One JSON file per wire shape (`http.ts` + `shapes.ts`). Never hand-edit a
fixture; change the serializer (a wire-contract change) and let the pair tests
tell you the new golden bytes. Verification is split by who owns the
serializer: shapes the ENGINE emits are captured/shape-verified against the
real serializer in this repo's CI; shapes the control plane emits are the
private repo's responsibility — its pair tests drive them against its real
route handlers. Independently of either side's pair tests, this repo's CI
pins every fixture's exact key tree + types via the typed mirrors in
`fixtures/mirrors.ts`.

`mirrors.ts` carries the `satisfies`-typed mirror of every fixture — the
compile-checked weld between fixture bytes and the `http.ts`/`shapes.ts`
types (it lives in the contract, not in a test, because test files are
outside the root tsc scope). It ships compiled in `dist/`; the JSON + MD
files here stay source-only.

Value rules (PRD-CORE-PRO-CONTRACT S4): canonical obviously-fake values only
(short `TEST-…` tokens, `*.invalid` hosts, repeated-pattern SHAs) — no
entropy-realistic tokens, no real subdomains or customer names, no
production-mirroring secret lengths. `tests/contract-http.test.ts` enforces
this mechanically for every string leaf.

| Fixture | Shape (`http.ts`/`shapes.ts`) | Serializer (generator) | Parser (pair side) |
|---|---|---|---|
| `usage-flush-request.json` | `UsageFlushRequest` | engine `src/core/managed-hook.ts` `flush()` — captured in `src/core/managed-hook.test.ts` | control plane (pair test in the private repo) |
| `usage-flush-response.json` | `UsageFlushResponse` | control plane (pair test in the private repo) | engine `managed-hook.ts` `flush()` — driven in `src/core/managed-hook.test.ts` |
| `usage-status-response.managed.json` | `UsageStatusResponse` | control plane (pair test in the private repo) | engine `managed-hook.ts` `syncStatus()` — driven in `src/core/managed-hook.test.ts` |
| `usage-status-response.hosted.json` | `UsageStatusResponse` | control plane, non-managed branch (pair test in the private repo) | engine `managed-hook.ts` `syncStatus()` |
| `usage-summary-response.managed.json` | `UsageSummaryResponse` | control plane (pair test in the private repo) | engine `src/core/managed-usage-summary.ts` — driven in its test |
| `usage-summary-response.not-managed.json` | `UsageSummaryResponse` | control plane, non-managed branch (pair test in the private repo) | engine `src/core/managed-usage-summary.ts` |
| `health-body.json` | `HealthBody` | engine `src/server/http-api.ts` `_collectHealthMetrics()` — shape-verified in `src/server/http-api.test.ts` | control plane (pair test in the private repo) |
| `health-body.with-sha.json` | `HealthBody` (non-null `build_sha` variant) | same serializer, `BUILD_SHA` build-arg set | control plane (pair test in the private repo) |
| `model-profile.json` | `shapes.ts` `ModelProfile` | control plane config generator (pair test in the private repo); guarded here by `isModelProfile` in `tests/contract-http.test.ts` | engine `src/core/config.ts` via `isModelProfile` |
