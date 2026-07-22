/**
 * Contract fixture guards (K-W2, PRD-CORE-PRO-CONTRACT §3.1 fixtures + S4).
 *
 * The serializer/parser PAIR tests live next to the real code they drive
 * (`src/core/managed-hook.test.ts`, `src/core/managed-usage-summary.test.ts`,
 * `src/server/http-api.test.ts`); this file guards the fixture SET itself:
 *
 * (a) TYPED MIRRORS (`src/contract/fixtures/mirrors.ts`): every fixture
 *     deep-equals a literal typed `satisfies` its `http.ts`/`shapes.ts` shape.
 *     This is the core-side rename tripwire for fields the engine's tolerant
 *     parsers never dereference (`accepted`, `tier`, `included_budget_cents`,
 *     …): renaming a key in a fixture breaks the deep-equal here, and renaming
 *     a field in `http.ts` breaks the mirror's compile (root tsc covers
 *     src/contract) — so a drift cannot ride on parse-tolerance.
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
import type { UsageSummaryResponse } from '../src/contract/http.js';
// The typed mirrors live INSIDE the contract (src/contract/fixtures/mirrors.ts)
// so their `satisfies` welds are checked by root tsc — this test dir is outside
// the tsc scope, so a `satisfies` here would never be type-checked (vitest
// strips types without checking them).
import { TYPED_MIRRORS } from '../src/contract/fixtures/mirrors.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/contract/fixtures');
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const readme = readFileSync(resolve(fixturesDir, 'README.md'), 'utf8');

const load = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

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
    // Reads the mirror; binds to the fixture bytes transitively via the
    // deep-equal test above.
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
