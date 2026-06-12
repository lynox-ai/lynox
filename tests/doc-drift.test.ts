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
      deep: 'mistral-large-2512',
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

describe('cross-repo drift: billing-tier canonical spec (core/pro pin the same frozen literal)', () => {
  // FROZEN canonical spec — the SAME literals are pinned emitter-side in pro
  // (packages/managed/src/domain/env-abi-contract.test.ts). Core cannot import
  // pro (separate repo; CI checks out one at a time), so each repo asserts its
  // OWN billing-tier.ts against this shared literal: this catches CORE drifting
  // from the spec, and pro's mirror catches pro drifting — together they keep
  // the two modules in lockstep without a cross-repo fs read (the equality
  // guard that was previously missing).
  const CANONICAL_TIERS = ['hosted', 'managed', 'managed_pro'] as const;
  const CANONICAL_ALIASES: Record<string, string> = { starter: 'hosted', eu: 'managed' };

  for (const t of CANONICAL_TIERS) {
    it(`\`${t}\` normalizes to itself`, () => {
      expect(normalizeBillingTier(t)).toBe(t);
    });
  }
  it('legacy aliases map exactly as the frozen spec', () => {
    for (const [legacy, canonical] of Object.entries(CANONICAL_ALIASES)) {
      expect(normalizeBillingTier(legacy)).toBe(canonical);
    }
  });
  it('rejects unknown tiers and self-host (no tier)', () => {
    expect(normalizeBillingTier('enterprise')).toBeUndefined();
    expect(normalizeBillingTier(undefined)).toBeUndefined();
    expect(normalizeBillingTier('')).toBeUndefined();
  });
});

describe('env-ABI consume-side: loadConfig reads the engine-consumed var names (src/core/config.ts)', () => {
  // The CP emits these EXACT names (pinned emitter-side in pro
  // env-abi-contract.test.ts). If a consume-side rename drops one here, the ABI
  // silently breaks — the ACCOUNT_TIER-unset / worker-profile-dead bug class.
  // Match the actual `process.env['NAME']` read (not a bare substring) so a
  // renamed read fails CI even if a comment still mentions the old name; a
  // future rename window must add the new read-alias to keep this green.
  const config = read('src/core/config.ts');
  const ENGINE_CONSUMED = [
    'LYNOX_ACCOUNT_TIER',
    'LYNOX_MAX_TIER',
    'LYNOX_DEFAULT_TIER',
    'LYNOX_WORKER_PROFILE',
    'LYNOX_MODEL_PROFILES_JSON',
    'LYNOX_LLM_MODE',
    'LYNOX_LLM_PROVIDER',
  ];
  for (const name of ENGINE_CONSUMED) {
    it(`reads ${name} via process.env`, () => {
      expect(config).toMatch(new RegExp(`process\\.env\\['${name}'\\]`));
    });
  }
});
