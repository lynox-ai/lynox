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
  MagicLinkVerifyRequest,
  OAuthClaimResponse,
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
    spend_gate: 'balance',
    tier: 'managed',
  } satisfies UsageStatusResponse,
  // A comp account: metered (the balance is a real, here negative, number) but
  // never refused for money — `spend_gate: 'none'` is what tells the engine
  // to clear its mirror instead of anchoring on -250.
  'usage-status-response.comp.json': {
    balance_cents: -250,
    included_budget_cents: 3000,
    allowed: true,
    spend_gate: 'none',
    tier: 'managed',
  } satisfies UsageStatusResponse,
  'usage-status-response.hosted.json': {
    balance_cents: null,
    allowed: true,
    spend_gate: 'none',
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
  'magic-link-verify-request.json': {
    token: 'TEST-MAGIC-TOKEN',
    instanceId: 'TEST-INSTANCE-1',
  } satisfies MagicLinkVerifyRequest,
  'oauth-claim-response.json': {
    access_token: 'TEST-ACCESS-TOKEN',
    refresh_token: 'TEST-REFRESH-TOK',
    // Epoch MILLISECONDS (2100-01-01T00:00:00Z) — the unit is the field's
    // contract; a seconds-valued emit would land decades in the past and the
    // engine's token guard would reject it as already expired. Far future on
    // purpose: the engine-side parser rejects stale timestamps, so a fixture
    // pinned near today would start failing its own pair test with time.
    expires_at: 4102444800000,
    scopes: [
      'https://scopes.example.invalid/auth/test-read',
      'https://scopes.example.invalid/auth/test-write',
    ],
  } satisfies OAuthClaimResponse,
  'model-profile.json': {
    provider: 'openai',
    api_base_url: 'https://llm.example.invalid/v1',
    api_key: 'TEST-API-KEY',
    model_id: 'test-model-1',
    context_window: 128000,
    max_tokens: 16000,
  } satisfies ModelProfile,
};
