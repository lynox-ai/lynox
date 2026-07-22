/**
 * Contract fixture hygiene (K-W2, PRD-CORE-PRO-CONTRACT §3.1 fixtures + S4).
 *
 * The serializer/parser PAIR tests live next to the real code they drive
 * (`src/core/managed-hook.test.ts`, `src/core/managed-usage-summary.test.ts`,
 * `src/server/http-api.test.ts`); this file guards the fixture SET itself:
 *
 * (a) README completeness: every fixture file is documented with its generator
 *     ref, and every documented fixture exists — an undocumented fixture has
 *     no named generator and would rot as hand-edited bytes.
 * (b) S4 value rules, mechanically: every string leaf is an OBVIOUSLY-fake
 *     value (`TEST-…`/`test-…` tokens, `.invalid` hosts, contract vocab,
 *     ISO timestamps, low-distinct-char SHAs). A real token, subdomain, or
 *     customer name pasted into a fixture fails here before gitleaks.
 * (c) The shapes.ts fixture round-trips the REAL runtime guard: the wire's
 *     `isModelProfile` accepts `model-profile.json`, and dropping any of the
 *     required fields it dereferences flips it to reject (rename-fails probe).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isModelProfile } from '../src/contract/shapes.js';
import type { ModelProfile } from '../src/contract/shapes.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/contract/fixtures');
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const readme = readFileSync(resolve(fixturesDir, 'README.md'), 'utf8');

// The S4 allowlist — one pattern per obviously-fake value class. Keep this
// tight: widening it to admit a "realistic" value defeats the rule.
const OBVIOUSLY_FAKE: RegExp[] = [
  /^TEST-[A-Z0-9-]+$/,               // canonical fake tokens / run ids
  /^test-[a-z0-9-]+$/,               // fake model ids
  /^https:\/\/[a-z0-9.-]+\.invalid(?:\/[a-z0-9./-]*)?$/, // RFC-2606 reserved hosts
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,       // ISO timestamps
  /^0\.0\.0-test$/,                  // fake version
  /^(?:ok|hosted|managed|managed_pro|balanced|deep|fast|stripe-billing|openai)$/, // contract vocab literals
];
// A 40-hex SHA is fake iff it is low-entropy (repeated-pattern): ≤5 distinct chars.
function isObviouslyFakeSha(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) && new Set(s).size <= 5;
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

describe('contract fixtures: set hygiene', () => {
  it('at least the K-W2 fixture set is present', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(9);
  });

  it('every fixture file is documented in fixtures/README.md (generator ref) and vice versa', () => {
    for (const file of fixtureFiles) {
      expect(readme, `fixtures/${file} has no generator-ref row in fixtures/README.md`).toContain(`\`${file}\``);
    }
    for (const documented of readme.matchAll(/`([a-z0-9.-]+\.json)`/g)) {
      expect(fixtureFiles, `README documents ${documented[1]!} but the file is missing`).toContain(documented[1]!);
    }
  });

  for (const file of fixtureFiles) {
    it(`${file}: parses as JSON and every string leaf is obviously fake (S4)`, () => {
      const parsed: unknown = JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf8'));
      const leaves: Array<{ path: string; value: string }> = [];
      stringLeaves(parsed, file.replace(/\.json$/, ''), leaves);
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
  const profile = JSON.parse(
    readFileSync(resolve(fixturesDir, 'model-profile.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('the fixture satisfies isModelProfile (the guard both repos run at their boundary)', () => {
    expect(isModelProfile(profile)).toBe(true);
    // Compile-time pin: the fixture's shape assignment must keep typechecking.
    const typed: ModelProfile = profile as unknown as ModelProfile;
    expect(typed.provider).toBe('openai');
  });

  for (const required of ['provider', 'api_base_url', 'api_key', 'model_id'] as const) {
    it(`renaming/dropping \`${required}\` flips the guard to reject (rename-fails probe)`, () => {
      const mutated = { ...profile };
      delete mutated[required];
      expect(isModelProfile(mutated)).toBe(false);
    });
  }
});
