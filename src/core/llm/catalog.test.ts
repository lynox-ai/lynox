import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../types/models.js';
import { MODEL_CAPABILITIES, MODEL_MAP, VERTEX_MODEL_MAP, MISTRAL_MODEL_MAP, resolveBalancedModel } from '../../types/models.js';
import { LLM_CATALOG, getCatalogForProvider, getCatalogEntryByKey, catalogEntryKey, resolveCatalogKey, vaultSlotForEndpoint, endpointNeedsCredential, mainChatTierLabels, mainChatTierLabelsFromTierSet } from './catalog.js';
import type { TierSet } from '../../types/config.js';
import type { CatalogProviderEntry } from './catalog.js';
import { isAllowlistedEndpoint } from './endpoint-allowlist.js';

describe('LLM_CATALOG', () => {
  it('exposes the native entries plus the gateway/local-runtime presets', () => {
    // Mistral is split out from the generic OpenAI-compatible entry so the
    // EU-sovereign option is a first-class button in the provider picker
    // rather than hidden behind "OpenAI-compatible endpoint". The gateway +
    // local-runtime presets (2026-07-13) follow the same pattern: all serialise
    // to `provider: 'openai'` at the wire, disambiguated by `preset_id`.
    const keys = LLM_CATALOG.map(catalogEntryKey).sort();
    expect(keys).toEqual([
      'anthropic', 'custom', 'fireworks', 'groq', 'lmstudio', 'localai',
      'mistral', 'ollama', 'openai-compat', 'together', 'vertex', 'vllm',
    ]);
  });

  // The preset set is NOT free to grow: pinning an endpoint implies lynox may
  // send a user's data there. `endpoint-allowlist.ts` is a DPA / sub-processor
  // gate, not a technical one — a non-vetted host makes lynox a controller-side
  // party to that third-party relationship and has to be disclosed.
  //
  // So every preset with a pinned `base_url_default` must resolve to a host the
  // allowlist already vouches for. This is the tripwire: adding a preset for an
  // un-vetted host fails HERE, loudly, instead of silently bypassing the
  // disclosure gate. Such endpoints stay fully reachable through the generic
  // `openai-compat` tile, which routes them through that gate as designed.
  it('every pinned preset endpoint is already on the vetted sub-processor allowlist', () => {
    const offenders = LLM_CATALOG
      .filter((e) => e.base_url_default !== undefined)
      .filter((e) => !isAllowlistedEndpoint(e.base_url_default!))
      .map((e) => `${catalogEntryKey(e)} → ${e.base_url_default!}`);

    expect(offenders).toEqual([]);
  });

  it('every entry declares a verification level', () => {
    for (const entry of LLM_CATALOG) {
      expect(['native', 'verified', 'experimental']).toContain(entry.verification);
    }
  });

  // The vault slot now rides on the endpoint, so the host-matching in
  // `resolveCatalogKey` decides which credential an endpoint is handed. That
  // makes it a security boundary, not just a UI convenience: a host that could
  // impersonate a preset would inherit that preset's key — or, worse, could
  // impersonate a LOOPBACK preset and thereby claim `vault_slot: null`, which is
  // the "needs no credential" state readiness checks trust.
  describe('vaultSlotForEndpoint — slot inheritance under a hostile base URL', () => {
    it('a suffix-spoofing host cannot inherit a vendor preset’s slot', () => {
      expect(vaultSlotForEndpoint('openai', 'https://api.groq.com.attacker.com/v1')).not.toBe('GROQ_API_KEY');
      expect(vaultSlotForEndpoint('openai', 'https://groq.com.evil.io/v1')).not.toBe('GROQ_API_KEY');
      expect(vaultSlotForEndpoint('openai', 'https://evil.com/?proxy=api.groq.com')).not.toBe('GROQ_API_KEY');
    });

    it('a remote host cannot masquerade as a loopback runtime', () => {
      // Loopback endpoints are credential-OPTIONAL: readiness does not demand a
      // key. A remote host that reached that state would slip past the key check.
      expect(endpointNeedsCredential('openai', 'https://localhost.attacker.com:11434/v1')).toBe(true);
      expect(vaultSlotForEndpoint('openai', 'https://localhost.attacker.com:11434/v1')).not.toBe('OLLAMA_API_KEY');
    });

    it('a legitimate vendor subdomain still resolves to the vendor slot', () => {
      expect(vaultSlotForEndpoint('openai', 'https://eu.groq.com/v1')).toBe('GROQ_API_KEY');
    });

    it('an unrecognised or empty endpoint falls back to the legacy slot, never to key-less', () => {
      expect(vaultSlotForEndpoint('openai', '')).toBe('MISTRAL_API_KEY');
      expect(vaultSlotForEndpoint('openai', 'https://some-proxy.example.com/v1')).toBe('MISTRAL_API_KEY');
    });

    it('loopback presets get their OWN slot, and do not require a key', () => {
      // Their own slot is what keeps the leak shut: a Mistral key lives elsewhere
      // and can never reach them. But an authenticated local gateway (vLLM or
      // LiteLLM with --api-key) still has somewhere to put its key — an earlier
      // cut used `null` here and silently 401'd every such install.
      expect(vaultSlotForEndpoint('openai', 'http://localhost:11434/v1')).toBe('OLLAMA_API_KEY');
      expect(vaultSlotForEndpoint('openai', 'http://localhost:8000/v1')).toBe('VLLM_API_KEY');
      expect(endpointNeedsCredential('openai', 'http://localhost:11434/v1')).toBe(false);
      // Conservative default: an endpoint we cannot place still needs a key.
      expect(endpointNeedsCredential('openai', 'https://unknown.example.com/v1')).toBe(true);
    });
  });

  it('only entries with a proven wire are non-experimental', () => {
    // The two native providers, plus every preset whose tool-calling has been
    // PROVEN by a real round-trip in `tests/online/provider-preset-reachability`.
    //
    // `ollama` earned its place with a full tool_use → tool_result → answer run
    // on qwen2.5:7b — mutation-checked, so the assertion is known to be capable
    // of failing. `fireworks` joined it (2026-07-14) on gpt-oss-120b via the same
    // round-trip. The rest connect but are unproven: they stay `experimental`,
    // and the settings UI says so on the tile. Adding a preset without proving
    // it therefore fails HERE, which is the point.
    const proven = LLM_CATALOG
      .filter((e) => e.verification !== 'experimental')
      .map(catalogEntryKey)
      .sort();

    expect(proven).toEqual(['anthropic', 'fireworks', 'mistral', 'ollama']);
  });

  // Per-entry requires_base_url + requires_region matrix. UI uses these
  // to render conditional form fields, so a regression here would break the
  // LLM page (e.g. showing a base-URL input for Anthropic, or hiding it
  // for the generic OpenAI-compatible preset).
  it.each([
    ['anthropic',     { requires_base_url: false, requires_region: false }],
    ['vertex',        { requires_base_url: false, requires_region: true  }],
    ['mistral',       { requires_base_url: false, requires_region: false }],
    ['openai-compat', { requires_base_url: true,  requires_region: false }],
    ['custom',        { requires_base_url: true,  requires_region: false }],
  ] as const)('%s has expected requires_base_url/requires_region flags', (key, expected) => {
    const entry = getCatalogEntryByKey(key)!;
    expect(entry.requires_base_url).toBe(expected.requires_base_url);
    expect(entry.requires_region).toBe(expected.requires_region);
  });

  it('anthropic models pin Sonnet/Opus/Haiku with provider-specific IDs', () => {
    const entry = getCatalogForProvider('anthropic')!;
    // Two balanced Sonnets (4.6 default + opt-in Sonnet 5), one deep, one fast.
    const tiers = entry.models.map((m) => m.tier).sort();
    expect(tiers).toEqual(['balanced', 'balanced', 'deep', 'fast']);
    const byId = Object.fromEntries(entry.models.map((m) => [m.id, m]));
    expect(byId['claude-sonnet-4-6']?.tier).toBe('balanced');
    expect(byId['claude-sonnet-5']?.tier).toBe('balanced');
    expect(byId['claude-opus-4-6']?.tier).toBe('deep');
    // Haiku ID has date suffix on Anthropic Direct, NOT on Vertex — pin both.
    expect(byId['claude-haiku-4-5-20251001']?.tier).toBe('fast');
    // Canonical pricing (mirrors MODEL_CAPABILITIES — the pre-existing Opus
    // 15/75 + Haiku 0.80/4 drift was corrected in the Sonnet 5 pass).
    expect(byId['claude-sonnet-4-6']?.pricing).toEqual({ input: 3, output: 15 });
    expect(byId['claude-sonnet-5']?.pricing).toEqual({ input: 3, output: 15 });
    expect(byId['claude-sonnet-5']?.context_window).toBe(1_000_000);
    expect(byId['claude-opus-4-6']?.pricing).toEqual({ input: 5, output: 25 });
    expect(byId['claude-haiku-4-5-20251001']?.pricing).toEqual({ input: 1, output: 5 });
    expect(byId['claude-sonnet-4-6']?.notes).toContain('Recommended');
  });

  it('every catalog model in MODEL_CAPABILITIES mirrors its pricing + context window (SoT drift guard)', () => {
    // catalog.ts re-literals pricing/context_window that models.ts (MODEL_CAPABILITIES) owns,
    // and has drifted before (Opus 15/75, Haiku 0.80/4, corrected in the Sonnet 5 pass). Derive
    // the expectation from the SoT so any future divergence fails HERE, not as a wrong cost display.
    let checked = 0;
    for (const model of LLM_CATALOG.flatMap((cat) => cat.models)) {
      const cap = MODEL_CAPABILITIES[model.id];
      if (!cap) continue; // custom / provider-specific ids not in the registry
      checked++;
      expect(model.context_window, `${model.id} context_window`).toBe(cap.contextWindow);
      if (model.pricing) {
        expect(model.pricing.input, `${model.id} pricing.input`).toBe(cap.pricing.input);
        expect(model.pricing.output, `${model.id} pricing.output`).toBe(cap.pricing.output);
      }
    }
    expect(checked).toBeGreaterThan(0); // the guard actually exercised the registry-backed entries
  });

  it('vertex models use Vertex-specific IDs (haiku drops date suffix)', () => {
    const entry = getCatalogForProvider('vertex')!;
    const byTier = Object.fromEntries(entry.models.map((m) => [m.tier, m]));
    expect(byTier['balanced']?.id).toBe('claude-sonnet-4-6');
    expect(byTier['deep']?.id).toBe('claude-opus-4-6');
    // CRITICAL: vertex haiku is 'claude-haiku-4-5', NOT 'claude-haiku-4-5-20251001'
    // (matches VERTEX_MODEL_MAP in src/types/models.ts).
    expect(byTier['fast']?.id).toBe('claude-haiku-4-5');
  });

  it('mistral preset pins dated snapshots and EU-Paris residency', () => {
    const entry = getCatalogEntryByKey('mistral')!;
    // Pinned to dated snapshots — mirrors MISTRAL_MODEL_MAP. The previous
    // catalog shipped `*-latest` aliases which auto-roll at Mistral's
    // discretion, silently shifting cost + behaviour mid-billing-period.
    // Updated 2026-05-24: mistral-small-2603 retired, replaced by gen-3
    // ministrals in haiku slot; Large 3 ctx 256k + new $0.50/$1.50 pricing.
    expect(entry.models.map((m) => m.id)).toEqual([
      'mistral-large-2512',
      'ministral-14b-2512',
      'ministral-3b-2512',
      'ministral-8b-2512',
    ]);
    expect(entry.default_residency).toContain('EU-Paris');
    expect(entry.base_url_default).toBe('https://api.mistral.ai/v1');
    expect(entry.preset_id).toBe('mistral');
    expect(entry.provider).toBe('openai');
    // Tier mapping (2026-05-29 refresh): ministral-8b ↔ fast, ministral-14b ↔
    // balanced, mistral-large-3 ↔ deep (magistral dropped — deprecated). Kept
    // in sync with MISTRAL_MODEL_MAP. ministral-3b stays listed as opt-in fast.
    const byId = Object.fromEntries(entry.models.map((m) => [m.id, m]));
    expect(byId['ministral-3b-2512']?.tier).toBe('fast');
    expect(byId['ministral-8b-2512']?.tier).toBe('fast');
    expect(byId['ministral-14b-2512']?.tier).toBe('balanced');
    expect(byId['mistral-large-2512']?.tier).toBe('deep');
    // Mistral Large 3 pricing — 75% cut vs Large 2
    expect(byId['mistral-large-2512']?.pricing).toEqual({ input: 0.50, output: 1.50 });
  });

  it('generic OpenAI-compatible preset accepts free-text model + base URL', () => {
    const entry = getCatalogEntryByKey('openai-compat')!;
    expect(entry.models).toHaveLength(0);
    expect(entry.requires_base_url).toBe(true);
    expect(entry.preset_id).toBe('openai-compat');
    expect(entry.provider).toBe('openai');
    expect(entry.base_url_default).toBeUndefined();
  });

  it('mistral preset is ordered before the generic openai-compat preset', () => {
    // Visual priority guarantee for the EU-sovereign button — surfaced
    // above the catch-all OpenAI-compatible option in the picker.
    const order = LLM_CATALOG.map(catalogEntryKey);
    expect(order.indexOf('mistral')).toBeLessThan(order.indexOf('openai-compat'));
    expect(order.indexOf('anthropic')).toBeLessThan(order.indexOf('mistral'));
  });

  it('custom provider has zero preset models (user supplies free-text model ID)', () => {
    const entry = getCatalogForProvider('custom')!;
    expect(entry.models).toHaveLength(0);
    expect(entry.requires_base_url).toBe(true);
  });

  it('getCatalogForProvider returns the first openai entry (mistral) — preset disambig is UI-side', () => {
    // Backward-compat: callers reading by `provider` get the first match.
    // The UI uses `getCatalogEntryByKey` with the preset_id when it needs
    // to distinguish mistral vs openai-compat.
    const entry = getCatalogForProvider('openai' as LLMProvider)!;
    expect(entry.preset_id).toBe('mistral');
  });

  it('returns undefined for an unknown provider', () => {
    // @ts-expect-error — testing unknown provider
    expect(getCatalogForProvider('bogus')).toBeUndefined();
  });

  it('LLM_CATALOG is runtime-frozen against accidental mutation', () => {
    expect(Object.isFrozen(LLM_CATALOG)).toBe(true);
    const anthropic = getCatalogForProvider('anthropic')!;
    expect(Object.isFrozen(anthropic)).toBe(true);
    expect(Object.isFrozen(anthropic.models)).toBe(true);
    expect(Object.isFrozen(anthropic.models[0])).toBe(true);
  });

  it('getCatalogEntryByKey returns undefined for unknown keys', () => {
    expect(getCatalogEntryByKey('does-not-exist')).toBeUndefined();
    expect(getCatalogEntryByKey('')).toBeUndefined();
  });

  it('catalogEntryKey falls back to provider when preset_id is absent', () => {
    const anthropic = getCatalogForProvider('anthropic')!;
    expect(anthropic.preset_id).toBeUndefined();
    expect(catalogEntryKey(anthropic)).toBe('anthropic');
    const mistral = getCatalogEntryByKey('mistral')!;
    expect(mistral.preset_id).toBe('mistral');
    expect(catalogEntryKey(mistral)).toBe('mistral');
  });
});

describe('LLM_CATALOG.main_chat_models (standard-mode picker options)', () => {
  // The main-chat picker renders these verbatim; each option's (tier, balanced_model?)
  // MUST be a config the engine's tier router resolves BACK to the same model — the
  // #459 anti-pattern is a picker option that silently routes elsewhere.
  it('anthropic offers one option per reachable band, balanced split by Sonnet variant', () => {
    const entry = getCatalogForProvider('anthropic')!;
    expect(entry.main_chat_models).toEqual([
      { id: 'claude-haiku-4-5-20251001', tier: 'fast' },
      { id: 'claude-sonnet-4-6', tier: 'balanced', balanced_model: 'claude-sonnet-4-6' },
      { id: 'claude-sonnet-5', tier: 'balanced', balanced_model: 'claude-sonnet-5' },
      { id: 'claude-opus-4-6', tier: 'deep' },
    ]);
  });

  it('mistral offers exactly the 3 tier representatives — Ministral 3B (fast extra) is EXCLUDED', () => {
    // fast→ministral-8b (MISTRAL_MODEL_MAP), so 3B is a catalog extra a
    // default_tier:'fast' write can never reach; listing it would be the #459 lie.
    const entry = getCatalogEntryByKey('mistral')!;
    expect(entry.main_chat_models).toEqual([
      { id: 'ministral-8b-2512', tier: 'fast' },
      { id: 'ministral-14b-2512', tier: 'balanced' },
      { id: 'mistral-large-2512', tier: 'deep' },
    ]);
    const ids = (entry.main_chat_models ?? []).map((o) => o.id);
    expect(ids).not.toContain('ministral-3b-2512');
    // Non-Anthropic bands carry NO balanced_model (Mistral doesn't honour the override).
    expect((entry.main_chat_models ?? []).every((o) => o.balanced_model === undefined)).toBe(true);
  });

  it('every main_chat_models option maps to a model the catalog actually lists', () => {
    for (const entry of LLM_CATALOG) {
      for (const opt of entry.main_chat_models ?? []) {
        expect(entry.models.some((m) => m.id === opt.id), `${catalogEntryKey(entry)} → ${opt.id}`).toBe(true);
        // A balanced_model, when present, equals the option id (round-trips the pick).
        if (opt.balanced_model !== undefined) {
          expect(opt.tier).toBe('balanced');
          expect(opt.balanced_model).toBe(opt.id);
        }
      }
    }
  });

  it('free-text providers (openai-compat, custom) expose no main_chat_models', () => {
    expect(getCatalogEntryByKey('openai-compat')!.main_chat_models).toBeUndefined();
    expect(getCatalogForProvider('custom')!.main_chat_models).toBeUndefined();
  });

  it('main_chat_models is runtime-frozen', () => {
    const entry = getCatalogForProvider('anthropic')!;
    expect(Object.isFrozen(entry.main_chat_models)).toBe(true);
    expect(Object.isFrozen(entry.main_chat_models![0])).toBe(true);
  });

  // ── The anti-#459 end-to-end guard ──
  // Every picker option's (tier[, balanced_model]) MUST resolve, through the
  // SAME maps the engine's tier router uses on the wire, back to the option's own
  // id. This is what makes the picker honest: a `default_tier`/`balanced_model`
  // write can never silently route to a different model than the label shown.
  it('anthropic: each option resolves to its own id via MODEL_MAP / resolveBalancedModel', () => {
    for (const opt of getCatalogForProvider('anthropic')!.main_chat_models ?? []) {
      const resolved = opt.tier === 'balanced'
        ? resolveBalancedModel({ balanced_model: opt.balanced_model })
        : MODEL_MAP[opt.tier];
      expect(resolved, `${opt.id} (tier=${opt.tier}, balanced_model=${opt.balanced_model})`).toBe(opt.id);
    }
  });

  it('mistral: each option resolves to its own id via MISTRAL_MODEL_MAP', () => {
    for (const opt of getCatalogEntryByKey('mistral')!.main_chat_models ?? []) {
      expect(MISTRAL_MODEL_MAP[opt.tier], `${opt.id} (tier=${opt.tier})`).toBe(opt.id);
    }
  });

  it('vertex: each option resolves to its own id via VERTEX_MODEL_MAP (haiku suffix-drop)', () => {
    // Vertex builds main_chat_models too (VERTEX_MODEL_MAP; fast = claude-haiku-4-5,
    // NOT the ...-20251001 direct id). No balanced variant (vertex doesn't honour
    // the balanced_model override), so every option is a plain tier representative.
    const opts = getCatalogForProvider('vertex')!.main_chat_models ?? [];
    expect(opts.length).toBeGreaterThan(0);
    for (const opt of opts) {
      expect(opt.balanced_model).toBeUndefined();
      expect(VERTEX_MODEL_MAP[opt.tier], `${opt.id} (tier=${opt.tier})`).toBe(opt.id);
    }
  });
});

describe('mainChatTierLabels (composer picker — DEF-0082 name-enrichment + hide)', () => {
  it('anthropic: per-tier labels, balanced defaults to the configured Sonnet 4.6', () => {
    const entry = getCatalogForProvider('anthropic')!;
    expect(mainChatTierLabels(entry, resolveBalancedModel({}))).toEqual({
      fast: 'Haiku 4.5',
      balanced: 'Sonnet 4.6',
      deep: 'Opus 4.6',
    });
  });

  it('anthropic: balanced label follows the tenant-selected Sonnet variant (5)', () => {
    const entry = getCatalogForProvider('anthropic')!;
    const resolved = resolveBalancedModel({ balanced_model: 'claude-sonnet-5' });
    expect(mainChatTierLabels(entry, resolved)?.balanced).toBe('Sonnet 5');
  });

  it('mistral: the three tier representatives, labelled', () => {
    const entry = getCatalogEntryByKey('mistral')!;
    expect(mainChatTierLabels(entry, resolveBalancedModel({}))).toEqual({
      fast: 'Ministral 8B',
      balanced: 'Ministral 14B',
      deep: 'Mistral Large 3',
    });
  });

  it('free-text providers (openai-compat, custom) yield undefined → picker hides', () => {
    expect(mainChatTierLabels(getCatalogEntryByKey('openai-compat')!, resolveBalancedModel({}))).toBeUndefined();
    expect(mainChatTierLabels(getCatalogForProvider('custom')!, resolveBalancedModel({}))).toBeUndefined();
  });

  it('a single-model provider (all tiers → one id) yields undefined → picker hides', () => {
    // Synthetic entry: three bands, all pointing at the SAME catalog model.
    // The distinct-count guard must collapse it to undefined so a proxy that
    // serves exactly one model never shows a fake 3-way picker (DEF-0082b).
    const oneModel: CatalogProviderEntry = {
      provider: 'openai',
      preset_id: 'synthetic-single',
      label: 'Synthetic single-model',
      models: [{ id: 'only-model', label: 'The Only Model', tier: 'balanced' }],
      main_chat_models: [
        { id: 'only-model', tier: 'fast' },
        { id: 'only-model', tier: 'balanced' },
        { id: 'only-model', tier: 'deep' },
      ],
    } as unknown as CatalogProviderEntry;
    expect(mainChatTierLabels(oneModel, resolveBalancedModel({}))).toBeUndefined();
  });

  it('two distinct models across bands DO surface (≥2 is the real-picker threshold)', () => {
    const twoModel: CatalogProviderEntry = {
      provider: 'openai',
      preset_id: 'synthetic-two',
      label: 'Synthetic two-model',
      models: [
        { id: 'small', label: 'Small', tier: 'fast' },
        { id: 'big', label: 'Big', tier: 'deep' },
      ],
      main_chat_models: [
        { id: 'small', tier: 'fast' },
        { id: 'big', tier: 'deep' },
      ],
    } as unknown as CatalogProviderEntry;
    expect(mainChatTierLabels(twoModel, resolveBalancedModel({}))).toEqual({ fast: 'Small', deep: 'Big' });
  });

  it('the distinct threshold is on model id, NOT label — two ids, one shared label still surfaces', () => {
    // Two genuinely different models that happen to render the same display
    // label. There IS a real choice (different ids route differently), so the
    // picker must surface — deduping on the label would wrongly collapse+hide it.
    const sharedLabel: CatalogProviderEntry = {
      provider: 'openai',
      preset_id: 'synthetic-collision',
      label: 'Synthetic label-collision',
      models: [
        { id: 'model-a', label: 'Same Name', tier: 'fast' },
        { id: 'model-b', label: 'Same Name', tier: 'deep' },
      ],
      main_chat_models: [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'deep' },
      ],
    } as unknown as CatalogProviderEntry;
    expect(mainChatTierLabels(sharedLabel, resolveBalancedModel({}))).toEqual({ fast: 'Same Name', deep: 'Same Name' });
  });
});

describe('mainChatTierLabelsFromTierSet (hybrid picker — labels follow the tier_set, not the base provider)', () => {
  it('labels each tier by its configured slot model, across providers', () => {
    // The exact bug: hybrid config with balanced→Mistral Large, deep→Sonnet, but
    // the picker showed the Anthropic default (balanced "Sonnet 5", deep "Opus 4.6").
    // Labels must now follow the tier_set — catalog-wide by model id.
    const tierSet: TierSet = {
      fast: { provider: 'anthropic', model_id: 'claude-haiku-4-5-20251001' },
      balanced: { provider: 'mistral', model_id: 'mistral-large-2512' },
      deep: { provider: 'anthropic', model_id: 'claude-sonnet-5' },
    };
    expect(mainChatTierLabelsFromTierSet(tierSet, 'anthropic')).toEqual({
      fast: 'Haiku 4.5',
      balanced: 'Mistral Large 3', // NOT the base-provider "Sonnet 5"
      deep: 'Sonnet 5', // NOT the base-provider "Opus 4.6"
    });
  });

  it('falls an unset tier back to the base provider tier model', () => {
    // Only balanced is overridden; fast/deep fall back to the base (anthropic).
    const tierSet: TierSet = { balanced: { provider: 'mistral', model_id: 'mistral-large-2512' } };
    const out = mainChatTierLabelsFromTierSet(tierSet, 'anthropic');
    expect(out?.balanced).toBe('Mistral Large 3');
    expect(out?.fast).toBe('Haiku 4.5');
    expect(out?.deep).toBe('Opus 4.6');
  });
});

describe('resolveCatalogKey', () => {
  // Single-entry providers — base URL is irrelevant; preset is forced.
  it.each([
    ['anthropic', undefined,                       'anthropic'],
    ['anthropic', 'https://api.anthropic.com',     'anthropic'],
    ['vertex',    undefined,                       'vertex'],
    ['custom',    'https://litellm.local',         'custom'],
  ] as const)('single-entry provider %s + url=%s → %s', (provider, url, expected) => {
    expect(resolveCatalogKey(provider as LLMProvider, url)).toBe(expected);
  });

  // Multi-preset provider (openai) — disambiguation by hostname.
  it('mistral host (api.mistral.ai) activates the mistral preset', () => {
    expect(resolveCatalogKey('openai', 'https://api.mistral.ai/v1')).toBe('mistral');
  });
  it('mistral subdomain (eu.mistral.ai) activates the mistral preset', () => {
    expect(resolveCatalogKey('openai', 'https://eu.mistral.ai/v1')).toBe('mistral');
  });
  it('mistral apex (mistral.ai) activates the mistral preset', () => {
    // Defensive: a user typing `https://mistral.ai/v1` should land on the
    // Mistral preset, not silently fall through to the generic openai
    // entry. Mirrors the apex-match clause in `resolveCatalogKey`.
    expect(resolveCatalogKey('openai', 'https://mistral.ai/v1')).toBe('mistral');
  });
  it('hostname normalises case', () => {
    expect(resolveCatalogKey('openai', 'https://API.MISTRAL.AI/v1')).toBe('mistral');
  });
  it('an openai host with no preset falls through to openai-compat', () => {
    // openrouter.ai is deliberately NOT a preset: it is not on the vetted
    // sub-processor allowlist, so it must keep routing through the generic tile
    // and its disclosure gate. If someone ever adds an OpenRouter preset without
    // vetting the host, this line and the allowlist tripwire above both fire.
    expect(resolveCatalogKey('openai', 'https://openrouter.ai/api/v1')).toBe('openai-compat');
    expect(resolveCatalogKey('openai', 'https://api.deepseek.com/v1')).toBe('openai-compat');
  });

  // Ollama, LM Studio, vLLM and LocalAI ALL live on `localhost` — only the port
  // tells them apart. Matching on hostname alone resolved every one of them to
  // whichever sat first in the catalog, so a user who saved LM Studio would come
  // back to the Ollama tile. These pin the host:port comparison that fixes it.
  it('loopback presets are disambiguated by port, not just hostname', () => {
    expect(resolveCatalogKey('openai', 'http://localhost:11434/v1')).toBe('ollama');
    expect(resolveCatalogKey('openai', 'http://localhost:1234/v1')).toBe('lmstudio');
    expect(resolveCatalogKey('openai', 'http://localhost:8000/v1')).toBe('vllm');
    expect(resolveCatalogKey('openai', 'http://localhost:8080/v1')).toBe('localai');
  });

  it('every loopback spelling of the same port resolves to the same preset', () => {
    // `localhost`, `127.0.0.1` and `0.0.0.0` are the same machine, and users write
    // all three. Matching the literal string would send `127.0.0.1:11434` to the
    // GENERIC tile — whose slot is the shared one — and thus put the Mistral key,
    // in plaintext, on a local port.
    expect(resolveCatalogKey('openai', 'http://127.0.0.1:11434/v1')).toBe('ollama');
    expect(resolveCatalogKey('openai', 'http://0.0.0.0:1234/v1')).toBe('lmstudio');
  });

  it('a loopback host on an unknown port falls through to the generic tile', () => {
    // Failing to the generic tile (which shows the base-URL input the user needs)
    // is the safe direction — far better than silently claiming they are on Ollama
    // when they are running something else on :9999.
    expect(resolveCatalogKey('openai', 'http://localhost:9999/v1')).toBe('openai-compat');
  });

  it('remote gateway presets resolve by host', () => {
    expect(resolveCatalogKey('openai', 'https://api.groq.com/openai/v1')).toBe('groq');
    expect(resolveCatalogKey('openai', 'https://api.together.xyz/v1')).toBe('together');
    expect(resolveCatalogKey('openai', 'https://api.fireworks.ai/inference/v1')).toBe('fireworks');
  });
  it('hostile URL smuggling mistral.ai in path/query does not activate mistral', () => {
    // Substring-match used to leak: `'https://attacker.example.com/?proxy=mistral.ai'`
    // would have picked the Mistral preset. Hostname-match prevents that.
    expect(resolveCatalogKey('openai', 'https://attacker.example.com/?proxy=mistral.ai')).toBe('openai-compat');
    expect(resolveCatalogKey('openai', 'https://api.mistral.ai.attacker.com/v1')).toBe('openai-compat');
    expect(resolveCatalogKey('openai', 'https://example.com/mistral.ai/v1')).toBe('openai-compat');
  });
  it('malformed URL falls through to the generic openai-compat preset', () => {
    expect(resolveCatalogKey('openai', 'not-a-url')).toBe('openai-compat');
    expect(resolveCatalogKey('openai', 'mistral.ai')).toBe('openai-compat'); // missing scheme
  });
  it('no baseUrl supplied falls through to the requires_base_url preset', () => {
    // Empty/undefined api_base_url on a multi-preset provider — the user
    // hasn't picked, so render the input that asks them to. Generic
    // openai-compat is the only preset with requires_base_url=true.
    expect(resolveCatalogKey('openai', undefined)).toBe('openai-compat');
    expect(resolveCatalogKey('openai', '')).toBe('openai-compat');
  });
});
