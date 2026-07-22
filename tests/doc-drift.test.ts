/**
 * Doc<->code coupling tests — the semantic slice of drift the deterministic
 * `drift-guard.sh` can't catch. Each test pins a high-churn surface where the
 * docs/comments have historically drifted from the code, so a future change to
 * the code fails CI until the matching doc is updated in the same commit.
 *
 * Add a case here whenever a doc states a specific code-derived fact that keeps
 * going stale (model tiers, role mappings, counts, env-var lists, …).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BUILTIN_ROLES } from '../src/core/roles.js';
import { MISTRAL_MODEL_MAP } from '../src/types/models.js';
import { normalizeBillingTier } from '../src/server/billing-tier.js';
import { CANONICAL_BILLING_TIERS, LEGACY_BILLING_TIER_ALIASES } from '../src/contract/vocab.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(repoRoot, p), 'utf8');

describe('doc<->code drift: role tiers (docs/features/workflows.md)', () => {
  const doc = read('docs/src/content/docs/features/workflows.md');

  for (const [role, cfg] of Object.entries(BUILTIN_ROLES)) {
    const Role = role.charAt(0).toUpperCase() + role.slice(1);
    it(`documents ${role} as the \`${cfg.model}\` tier`, () => {
      const row = new RegExp(`\\*\\*${Role}\\*\\*\\s*\\|\\s*\`?${cfg.model}\`?`, 'i');
      expect(doc).toMatch(row);
    });
  }

  it('roles table no longer uses retired Anthropic-brand model names', () => {
    // Roles resolve to provider-agnostic tiers (deep/balanced/fast), never to
    // Anthropic model brands — those drift the moment a non-Anthropic provider
    // is active.
    expect(doc).not.toMatch(/\bSonnet\b/);
    expect(doc).not.toMatch(/\bHaiku\b/);
  });
});

describe('doc<->code drift: Mistral tier map (src/types/models.ts)', () => {
  it('MISTRAL_MODEL_MAP holds the canonical pinned snapshots', () => {
    // If you change these, update the JSDoc above MISTRAL_MODEL_MAP AND
    // docs/setup/llm-providers.md in the same commit.
    expect(MISTRAL_MODEL_MAP).toEqual({
      deep: 'mistral-medium-2604',
      balanced: 'ministral-14b-2512',
      fast: 'ministral-8b-2512',
    });
  });
});

describe('doc<->code drift: LLM provider framing (src/types/models.ts LLMProvider)', () => {
  // SoT: `LLMProvider = 'anthropic' | 'vertex' | 'custom' | 'openai'` (models.ts).
  // Mistral runs via the 'openai' (OpenAI-compatible) path and is a FIRST-CLASS
  // native provider alongside Anthropic — NOT a fallback. These cases lock the
  // prose to that truth so the recurring "Mistral fallback" / "Bedrock" drift
  // (2026-06-09) can't silently reappear. SoT lives in code; prose must track it.
  const claude = read('CLAUDE.md');

  it('the in-product wizard lists Anthropic AND Mistral as first-class options', () => {
    expect(claude).toMatch(/Anthropic\s*\/\s*Mistral/i);
  });

  it('does NOT frame Mistral as a fallback (it is first-class native)', () => {
    // Narrow window so unrelated "fallback" mentions (DuckDuckGo, SvelteKit
    // handler) don't false-positive — only "Mistral … fallback" trips it.
    expect(claude).not.toMatch(/Mistral[^\n.]{0,30}fallback/i);
  });

  it('Bedrock, if mentioned, is only flagged as removed (never a live provider)', () => {
    const idx = claude.search(/\bBedrock\b/i);
    if (idx < 0) return; // absent is fine
    const window = claude.slice(Math.max(0, idx - 80), idx + 80);
    expect(window).toMatch(/remov|no longer|gone|retir|not the managed/i);
  });
});

describe('billing-tier canonical spec (src/contract/vocab.ts is the single source of truth)', () => {
  // The frozen-literal twin this block used to carry is retired: the shared
  // vocabulary now lives ONCE in `src/contract/vocab.ts`, and the CROSS-repo
  // lockstep is enforced on pro's side against its vendored byte-identical copy
  // (contract-sync CI job + CONTRACT.lock). What core still pins here is the
  // SEMANTIC spec itself — the wire values the CP emits — so a contract edit
  // that changes them fails CI until it is made deliberately, in this file, in
  // the same commit.
  it('canonical tiers are exactly hosted/managed/managed_pro', () => {
    expect([...CANONICAL_BILLING_TIERS].sort()).toEqual(['hosted', 'managed', 'managed_pro'].sort());
  });
  it('legacy aliases are exactly starter→hosted and eu→managed', () => {
    expect(LEGACY_BILLING_TIER_ALIASES).toEqual({ starter: 'hosted', eu: 'managed' });
  });
  it('the src/server/billing-tier.ts shim re-exports the contract behavior', () => {
    // `normalizeBillingTier` here is imported from the SHIM path — this asserts
    // the shim actually delegates to the contract module.
    for (const t of CANONICAL_BILLING_TIERS) expect(normalizeBillingTier(t)).toBe(t);
    for (const [legacy, canonical] of Object.entries(LEGACY_BILLING_TIER_ALIASES)) {
      expect(normalizeBillingTier(legacy)).toBe(canonical);
    }
  });
  it('rejects unknown tiers and self-host (no tier)', () => {
    expect(normalizeBillingTier('enterprise')).toBeUndefined();
    expect(normalizeBillingTier(undefined)).toBeUndefined();
    expect(normalizeBillingTier('')).toBeUndefined();
  });
});

// The former ENGINE_CONSUMED block (loadConfig read pins) is retired: the
// generated forward test in tests/contract-env.test.ts asserts every registry
// row's read form at its real site, driven by src/contract/env-registry.ts.

describe('env-ABI consume-side: renamed vars keep their legacy read-alias (src/core/env.ts)', () => {
  // Renamed CP→engine / self-host vars route through the ENV_ALIASES registry
  // (canonical-first, legacy accepted forever). A consume-side drop of EITHER
  // the canonical or a legacy name silently breaks the ABI for tenants still on
  // the other name — pin both so the drop fails CI. Add a row when a rename
  // lands; never remove a legacy name (the read-alias is permanent).
  const env = read('src/core/env.ts');
  const ALIAS_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['LYNOX_BILLING_TIER', ['LYNOX_MANAGED_MODE']],
    ['LYNOX_MAX_MODEL_TIER', ['LYNOX_MAX_TIER']],
    ['LYNOX_DEFAULT_MODEL_TIER', ['LYNOX_DEFAULT_TIER']],
    ['LYNOX_API_BASE_URL', ['ANTHROPIC_BASE_URL']],
    ['LYNOX_DATA_DIR', ['LYNOX_DIR']],
  ];
  for (const [canonical, legacies] of ALIAS_PAIRS) {
    it(`declares the canonical name ${canonical}`, () => {
      expect(env).toMatch(new RegExp(`\\b${canonical}\\b`));
    });
    for (const legacy of legacies) {
      it(`keeps ${legacy} as a read-alias of ${canonical}`, () => {
        expect(env).toMatch(new RegExp(`'${legacy}'`));
      });
    }
  }

  // Pin the consume-side CALL, not just the registry declaration: each renamed
  // var must actually be READ through the alias helper at its consuming site,
  // so a silent revert to a bare `process.env['LEGACY']` literal fails CI (the
  // registry pin above alone would not catch that).
  const ALIAS_CONSUMERS: ReadonlyArray<readonly [string, string, string]> = [
    ['LYNOX_BILLING_TIER', 'readEnvAlias', 'src/server/http-api.ts'],
    ['LYNOX_BILLING_TIER', 'readEnvAlias', 'src/core/engine.ts'],
    ['LYNOX_API_BASE_URL', 'readEnvAlias', 'src/server/http-api.ts'],
    ['LYNOX_API_BASE_URL', 'readEnvAlias', 'src/core/config.ts'],
    ['LYNOX_MAX_MODEL_TIER', 'envTier', 'src/core/config.ts'],
    ['LYNOX_DEFAULT_MODEL_TIER', 'envTier', 'src/core/config.ts'],
    ['LYNOX_DATA_DIR', 'readEnvAlias', 'src/core/config.ts'],
    ['LYNOX_DATA_DIR', 'readEnvAlias', 'src/core/openai-adapter.ts'],
  ];
  for (const [canonical, accessor, file] of ALIAS_CONSUMERS) {
    it(`${file} reads ${canonical} via ${accessor}()`, () => {
      expect(read(file)).toMatch(new RegExp(`${accessor}\\('${canonical}'\\)`));
    });
  }
});

// The former BEHAVIOR_CONSUMERS block (#830) is retired the same way — its five
// triples are registry rows now, asserted by the generated forward test.
