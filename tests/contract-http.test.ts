/**
 * Contract fixture guards (K-W2, PRD-CORE-PRO-CONTRACT §3.1 fixtures + S4).
 *
 * The serializer/parser PAIR tests live next to the real code they drive
 * (`src/core/managed-hook.test.ts`, `src/core/managed-usage-summary.test.ts`,
 * `src/server/http-api.test.ts`); this file guards the fixture SET itself:
 *
 * (a) TYPED MIRRORS: every fixture deep-equals a literal typed `satisfies` its
 *     `http.ts`/`shapes.ts` shape. This is the core-side rename tripwire for
 *     fields the engine's tolerant parsers never dereference (`accepted`,
 *     `tier`, `included_budget_cents`, …): renaming a key in a fixture breaks
 *     the deep-equal here, and renaming a field in `http.ts` breaks the
 *     literal's compile — so a drift cannot ride on parse-tolerance.
 * (b) README completeness: every fixture file has a generator-ref TABLE ROW,
 *     and every documented fixture exists.
 * (c) S4 value rules, mechanically: every string leaf is an OBVIOUSLY-fake
 *     value (short `TEST-…`/`test-…` tokens, `.invalid` hosts, contract
 *     literals, ISO timestamps, low-distinct-char SHAs). A realistic token or
 *     hostname pasted into a fixture fails here before gitleaks. Residual: a
 *     short real NAME inside a `TEST-…` token is not mechanically detectable —
 *     that class stays on review + public-repo-guard.
 * (d) The shapes.ts fixture round-trips the REAL runtime guard
 *     (`isModelProfile`), with drop-a-required-field red probes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isModelProfile } from '../src/contract/shapes.js';
import type { ModelProfile } from '../src/contract/shapes.js';
import type {
  UsageFlushRequest,
  UsageFlushResponse,
  UsageStatusResponse,
  UsageSummaryResponse,
  HealthBody,
} from '../src/contract/http.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/contract/fixtures');
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const readme = readFileSync(resolve(fixturesDir, 'README.md'), 'utf8');

const load = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

// ── (a) Typed mirrors — one `satisfies`-checked literal per fixture ─────────
// The literal IS the fixture (deep-equal below); `satisfies` welds it to the
// contract type, so fixture-bytes ↔ http.ts cannot drift apart silently.

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

const TYPED_MIRRORS: Record<string, unknown> = {
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

// ── (c) S4 allowlist — one pattern per obviously-fake value class. Keep this
// tight: widening it to admit a "realistic" value defeats the rule. The
// 20-char cap on TEST- tokens stops a realistic credential riding in as a
// suffix (`TEST-AKIA…EXAMPLE`-style smuggling).
const OBVIOUSLY_FAKE: RegExp[] = [
  /^TEST-[A-Z0-9-]{1,15}$/,          // canonical fake tokens / run ids (≤20 chars total)
  /^test-[a-z0-9-]{1,15}$/,          // fake model ids
  /^https:\/\/[a-z0-9.-]+\.invalid(?:\/[a-z0-9./-]*)?$/, // RFC-2606 reserved hosts
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,       // ISO timestamps
  /^0\.0\.0-test$/,                  // fake version
  /^(?:ok|hosted|managed|managed_pro|balanced|deep|fast|stripe-billing|openai)$/, // contract literals (vocab + shapes + http)
];
// A 40-hex SHA is fake iff it is blatantly low-entropy: ≤4 distinct chars.
function isObviouslyFakeSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) && new Set(s).size <= 4;
}

function stringLeaves(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => stringLeaves(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      stringLeaves(v, `${path}.${k}`, out);
    }
  }
}

describe('contract fixtures: typed mirrors (fixture bytes ≡ contract types)', () => {
  it('every fixture has a typed mirror and vice versa', () => {
    expect(Object.keys(TYPED_MIRRORS).sort()).toEqual(fixtureFiles);
  });

  for (const [file, mirror] of Object.entries(TYPED_MIRRORS)) {
    it(`${file} deep-equals its \`satisfies\`-typed mirror`, () => {
      expect(load(file)).toEqual(mirror);
    });
  }

  it('the managed summary fixture is internally consistent (available = budget + topup; used = available - balance)', () => {
    const f = TYPED_MIRRORS['usage-summary-response.managed.json'] as UsageSummaryResponse;
    expect(f.available_cents).toBe(f.budget_cents! + f.topup_cents!);
    expect(f.used_cents).toBe(f.available_cents! - f.balance_cents!);
  });
});

describe('contract fixtures: set hygiene', () => {
  it('every fixture file has a generator-ref table row in fixtures/README.md and vice versa', () => {
    for (const file of fixtureFiles) {
      // A table ROW (`| \`file\` | ... |`), not a mere mention — the row is
      // where the generator ref lives.
      const row = new RegExp(`^\\| \`${file.replace(/\./g, '\\.')}\` \\|.+\\|.+\\|.+\\|$`, 'm');
      expect(readme, `fixtures/${file} has no generator-ref table row in fixtures/README.md`).toMatch(row);
    }
    for (const documented of readme.matchAll(/`([a-z0-9.-]+\.json)`/g)) {
      expect(fixtureFiles, `README documents ${documented[1]!} but the file is missing`).toContain(documented[1]!);
    }
  });

  for (const file of fixtureFiles) {
    it(`${file}: every string leaf is obviously fake (S4)`, () => {
      const leaves: Array<{ path: string; value: string }> = [];
      stringLeaves(load(file), file.replace(/\.json$/, ''), leaves);
      const offenders = leaves.filter(
        ({ value }) => !OBVIOUSLY_FAKE.some((re) => re.test(value)) && !isObviouslyFakeSha(value),
      );
      expect(
        offenders,
        'string leaves that do not match any obviously-fake pattern (S4: no realistic tokens/hosts/names in fixtures)',
      ).toEqual([]);
    });
  }
});

describe('contract fixtures: model-profile round-trips the real guard', () => {
  const profile = load('model-profile.json') as Record<string, unknown>;

  it('the fixture satisfies isModelProfile (the guard both repos run at their boundary)', () => {
    expect(isModelProfile(profile)).toBe(true);
  });

  for (const required of ['provider', 'api_base_url', 'api_key', 'model_id'] as const) {
    it(`renaming/dropping \`${required}\` flips the guard to reject (rename-fails probe)`, () => {
      const mutated = { ...profile };
      delete mutated[required];
      expect(isModelProfile(mutated)).toBe(false);
    });
  }
});
