/**
 * Typed mirrors of the golden fixtures — SINGLE SOURCE OF TRUTH, part of the
 * vendored contract. Each literal is `satisfies`-welded to its `http.ts` /
 * `shapes.ts` shape and must deep-equal its JSON fixture byte-for-byte
 * (asserted in `tests/contract-http.test.ts`).
 *
 * This file exists so the fixture↔type weld is COMPILE-CHECKED: test files are
 * outside the root tsc scope (vitest strips types without checking), so a
 * `satisfies` living in a test would never run. Here, renaming a field in
 * `http.ts`/`shapes.ts` without updating the mirror (and thus the fixture)
 * fails `tsc` in both repos. Downstream pair tests may deep-equal real
 * serializer output against these mirrors directly.
 *
 * VENDORED DOWNSTREAM — edit ONLY here; values follow the fixture rules in
 * `fixtures/README.md` (obviously-fake only). Ships compiled in `dist/` —
 * acceptable: the values are the same public fixture bytes.
 */
import type {
  UsageFlushRequest,
  UsageFlushResponse,
  UsageStatusResponse,
  UsageSummaryResponse,
  HealthBody,
} from '../http.js';
import type { ModelProfile } from '../shapes.js';

const HEALTH_BASE = {
  status: 'ok',
  version: '0.0.0-test',
  uptime_s: 123,
  process: { memory_used_mb: 100, memory_rss_mb: 200, cpu_user_ms: 1000, cpu_system_ms: 500 },
  system: {
    memory_total_mb: 16384,
    memory_free_mb: 8192,
    load_avg_1m: 0.5,
    load_avg_5m: 0.25,
    disk_total_gb: 100,
    disk_used_gb: 50,
  },
  engine: { active_sessions: 0, total_threads: 0 },
};

/** Fixture file name (relative to `fixtures/`) → its typed mirror. */
export const TYPED_MIRRORS: Record<string, unknown> = {
  'usage-flush-request.json': {
    runs: [
      { run_id: 'TEST-RUN-0001', model: 'balanced', cost_cents: 3 },
      { run_id: 'TEST-RUN-0002', model: 'deep', cost_cents: 12 },
    ],
  } satisfies UsageFlushRequest,
  'usage-flush-response.json': {
    accepted: 2,
    balance_cents: 2985,
    allowed: true,
  } satisfies UsageFlushResponse,
  'usage-status-response.managed.json': {
    balance_cents: 2985,
    included_budget_cents: 3000,
    allowed: true,
    tier: 'managed',
  } satisfies UsageStatusResponse,
  'usage-status-response.hosted.json': {
    balance_cents: null,
    allowed: true,
    tier: 'hosted',
  } satisfies UsageStatusResponse,
  'usage-summary-response.managed.json': {
    managed: true,
    tier: 'managed',
    budget_cents: 3000,
    topup_cents: 500,
    available_cents: 3500,
    used_cents: 515,
    balance_cents: 2985,
    period: {
      start_iso: '2026-01-01T00:00:00.000Z',
      end_iso: '2026-02-01T00:00:00.000Z',
      source: 'stripe-billing',
    },
  } satisfies UsageSummaryResponse,
  'usage-summary-response.not-managed.json': {
    managed: false,
  } satisfies UsageSummaryResponse,
  'health-body.json': { ...HEALTH_BASE, build_sha: null } satisfies HealthBody,
  'health-body.with-sha.json': {
    ...HEALTH_BASE,
    build_sha: 'aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd',
  } satisfies HealthBody,
  'model-profile.json': {
    provider: 'openai',
    api_base_url: 'https://llm.example.invalid/v1',
    api_key: 'TEST-API-KEY',
    model_id: 'test-model-1',
    context_window: 128000,
    max_tokens: 16000,
  } satisfies ModelProfile,
};
