/**
 * Static LLM model catalog. Pricing here is approximate "headline" USD
 * per 1M tokens — real cost accounting goes through `core/pricing.ts`
 * (cache discounts etc.). Catalog is frozen so consumers can pass it
 * by reference without risk of cross-request mutation.
 */

import type { LLMProvider, ModelTier } from '../../types/models.js';
import {
  MODEL_MAP,
  VERTEX_MODEL_MAP,
  MISTRAL_MODEL_MAP,
  SERVED_BALANCED_SONNET_IDS,
} from '../../types/models.js';

export interface CatalogModel {
  id: string;
  /** Tier alias for the Claude family (also drives `default_tier` config + spawn role mapping). */
  tier?: ModelTier;
  label: string;
  context_window: number;
  /** Headline pricing per 1M tokens. Cache discounts NOT modelled — see `core/pricing.ts`. */
  pricing?: { input: number; output: number };
  capabilities?: ReadonlyArray<'vision' | 'tool_use' | 'extended_thinking'>;
  residency: string;
  notes?: string;
}

/**
 * One selectable main-chat model in standard (non-hybrid) routing. Mirrors the
 * reachable `(default_tier[, balanced_model])` config combos for a provider so
 * the UI can render the "Main chat model" picker without mirroring the engine's
 * tier→model maps (drift-free — computed here where the maps live).
 */
export interface MainChatModel {
  /** Catalog model id this option represents (label/pricing looked up in `models`). */
  id: string;
  /** Routing band written to `config.default_tier` when picked. */
  tier: ModelTier;
  /**
   * For the Anthropic balanced band only: the served-Sonnet variant to write to
   * `config.balanced_model` so the picker round-trips (Sonnet 4.6 vs Sonnet 5).
   * Absent for bands with a single reachable model.
   */
  balanced_model?: string;
}

export interface CatalogProviderEntry {
  /**
   * Wire-level provider — what the engine sends to `createLLMClient`. Multiple
   * UI entries can share a `provider` (e.g. both 'Mistral (EU-Paris)' and
   * generic 'OpenAI-compatible endpoint' serialise to provider='openai'); the
   * UI keys buttons off `preset_id ?? provider` to disambiguate them.
   */
  provider: LLMProvider;
  /**
   * Optional UI-only identifier for catalog entries that share a `provider`.
   * Stable across rebuilds — used as a localStorage key and the UI button
   * identity. Omit when the provider field is itself unique.
   */
  preset_id?: string;
  display_name: string;
  /** Empty array signals free-text fallback — user types model ID themselves. */
  models: ReadonlyArray<CatalogModel>;
  /**
   * The models pickable as the MAIN chat model in standard routing — one per
   * reachable band, the Anthropic balanced band split by served-Sonnet variant.
   * Excludes same-band catalog extras standard-mode tier-routing can't reach
   * (e.g. Ministral 3B — `fast` resolves to 8B). Absent for free-text providers.
   * Computed at module load (see the freeze block below), never hand-authored.
   */
  main_chat_models?: ReadonlyArray<MainChatModel>;
  requires_base_url: boolean;
  requires_region: boolean;
  default_residency: string;
  /**
   * Pre-filled api_base_url for this preset. Used when `requires_base_url` is
   * false but the entry still needs a non-default URL (e.g. Mistral preset
   * implies api.mistral.ai without making the user type it).
   */
  base_url_default?: string;
  /**
   * How far this entry has actually been proven. Structural, because the prose
   * convention it replaces ("Experimental — wired but not regularly tested",
   * buried in `notes`) was neither greppable nor testable — nothing could act
   * on it, and the UI could not surface it.
   *
   *   'native'       — first-class, regularly exercised by the online suite.
   *   'verified'     — a real-API tool-calling walk passes for this preset
   *                    (`tests/online/provider-preset-reachability.test.ts`).
   *   'experimental' — wired, but tool-calling through it is NOT proven.
   *
   * Why it matters: lynox is an agent, so an endpoint that streams fluent prose
   * but fumbles tool calls is useless to it — and tool-calling support varies
   * sharply by model and endpoint. A preset is a promise ("point lynox here and
   * it works"), so we mark the ones we have actually kept. A passing mock does
   * not prove a model; only a real call does.
   */
  verification: 'native' | 'verified' | 'experimental';
  notes?: string;
}

export type LLMCatalog = ReadonlyArray<CatalogProviderEntry>;

const ANTHROPIC_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'claude-sonnet-4-6',
    tier: 'balanced',
    label: 'Sonnet 4.6',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Recommended default — best balance of cost, latency, and capability.',
  },
  {
    id: 'claude-sonnet-5',
    tier: 'balanced',
    label: 'Sonnet 5',
    context_window: 1_000_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Newest balanced model — 1M native context, near-Opus capability, same $3/$15 rate as Sonnet 4.6 (intro $2/$10 through 2026-08-31). Opt-in via balanced_model.',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'deep',
    label: 'Opus 4.6',
    context_window: 1_000_000,
    pricing: { input: 5, output: 25 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Highest capability; ~1.7× the cost of Sonnet — reserve for deep reasoning.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    tier: 'fast',
    label: 'Haiku 4.5',
    context_window: 200_000,
    pricing: { input: 1, output: 5 },
    capabilities: ['vision', 'tool_use'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Fastest tier — ideal for high-volume orchestration and classification.',
  },
];

const VERTEX_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'claude-sonnet-4-6',
    tier: 'balanced',
    label: 'Sonnet 4.6 (Vertex)',
    context_window: 200_000,
    pricing: { input: 3, output: 15 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-opus-4-6',
    tier: 'deep',
    label: 'Opus 4.6 (Vertex)',
    context_window: 1_000_000,
    pricing: { input: 5, output: 25 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'GCP region (configurable)',
  },
  {
    id: 'claude-haiku-4-5',
    tier: 'fast',
    label: 'Haiku 4.5 (Vertex)',
    context_window: 200_000,
    pricing: { input: 1, output: 5 },
    capabilities: ['vision', 'tool_use'],
    residency: 'GCP region (configurable)',
  },
];

/**
 * Mistral models pinned to dated snapshots — mirrors MISTRAL_MODEL_MAP in
 * types/models.ts so the EU-sovereign tier router and the user-facing
 * catalog stay aligned. `*-latest` aliases auto-roll silently → bad for
 * cost predictability + behaviour-drift in managed-EU tenants.
 *
 * Tier mapping (updated 2026-05-29): ministral-8b ↔ fast, ministral-14b ↔
 * balanced, mistral-large-2512 ↔ deep. magistral-medium dropped from the catalog
 * — Mistral deprecated the Magistral family (retires 2026-07-31) and Set-Bench
 * v4 (fair judge panel) showed it never beats mistral-large-2512 at 6× the
 * cost. ministral-3b stays listed as the cheapest opt-in orchestration model.
 */
const MISTRAL_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: 'mistral-large-2512',
    tier: 'deep',
    label: 'Mistral Large 3',
    context_window: 256_000,
    pricing: { input: 0.50, output: 1.50 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Mistral quality leader — the deep tier. Set-Bench v4 top Mistral scorer on the open-ended analysis axes; no Mistral model beats it. 256k context, native prompt-cache, multimodal input.',
  },
  {
    id: 'ministral-14b-2512',
    tier: 'balanced',
    label: 'Ministral 14B',
    context_window: 262_144,
    pricing: { input: 0.20, output: 0.20 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended balanced default. Gen-3 mid model, text+vision. 100% pass on every Set-Bench axis at near-Large quality and ~6× lower cost.',
  },
  {
    id: 'ministral-3b-2512',
    tier: 'fast',
    label: 'Ministral 3B',
    context_window: 262_144,
    pricing: { input: 0.10, output: 0.10 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Cheapest Mistral model. Orchestration, classification, routing.',
  },
  {
    id: 'ministral-8b-2512',
    tier: 'fast',
    label: 'Ministral 8B',
    context_window: 262_144,
    pricing: { input: 0.15, output: 0.15 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended fast-tier default. 100% pass on all 8 bench axes at $0.00006–$0.00038 warm per loop.',
  },
];

/**
 * Gateway / local-runtime presets — the base URL a user would otherwise have to
 * look up and type by hand, pinned to a one-click tile.
 *
 * ## Why this set, and not the obvious longer one
 *
 * A preset is not merely a UX nicety: shipping one implies lynox may send a
 * user's data to that host. `endpoint-allowlist.ts` is the gate, and it is a
 * **DPA / sub-processor** control rather than a technical one — a non-vetted
 * host makes lynox "a controller-side party to the third-party data-processing
 * relationship" and has to be disclosed (Prighter requires explicit listing).
 *
 * So this set is exactly the intersection of "useful" and "already vetted":
 *
 *   - **Loopback runtimes** (Ollama, LM Studio, vLLM, LocalAI) — `localhost` is
 *     allowlisted precisely because there is NO third-party exposure: the data
 *     never leaves the user's machine. Nothing to disclose, and the closest fit
 *     there is to what self-hosting is for.
 *   - **Groq / Together / Fireworks** — already in `ALLOWLISTED_HOSTS`.
 *
 * Deliberately absent — OpenRouter, DeepSeek, Cloudflare AI Gateway, Portkey,
 * Baseten and friends: each would be a NEW vetted sub-processor, which is a
 * disclosure decision, not a code change. They stay fully reachable through the
 * generic `openai-compat` tile, which routes them through the disclosure gate
 * exactly as designed. Adding one here would silently skip that gate — hence the
 * test that asserts every pinned `base_url_default` is already allowlisted.
 *
 * ## Tool-calling is the real bar
 *
 * lynox is an agent, so an endpoint that streams prose but fumbles tool calls is
 * worthless to it — and the generic tile already warns that tool-calling
 * reliability varies sharply by model and endpoint. Every preset here is
 * therefore born `experimental` and is promoted to `verified` only by a REAL
 * tool-calling round-trip (`tests/online/provider-preset-reachability.test.ts`),
 * never by a passing mock.
 *
 * `models: []` keeps the model free-text on purpose: the user (or their runtime)
 * chooses it, and we do not pretend to a tier map we have not measured.
 */
const OPENAI_COMPAT_PRESETS: ReadonlyArray<CatalogProviderEntry> = [
  {
    provider: 'openai',
    preset_id: 'ollama',
    display_name: 'Ollama (local)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:11434/v1',
    default_residency: 'Your machine — nothing leaves the host',
    // Promoted 2026-07-13: `tests/online/provider-preset-reachability.test.ts`
    // drove a full tool_use → tool_result → answer round-trip through Ollama on
    // qwen2.5:7b, and a mutation run confirmed the assertion can actually fail.
    // The WIRE is proven; the model is still the user's choice, hence the note.
    verification: 'verified',
    notes: 'Local models via Ollama — nothing leaves your machine. Pick a tool-capable model (qwen2.5, llama3.1, mistral-nemo): lynox is an agent, and a model without tool support cannot drive it.',
  },
  {
    provider: 'openai',
    preset_id: 'lmstudio',
    display_name: 'LM Studio (local)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:1234/v1',
    default_residency: 'Your machine — nothing leaves the host',
    verification: 'experimental',
    notes: 'Local models via LM Studio\'s OpenAI-compatible server. Requires a tool-capable model.',
  },
  {
    provider: 'openai',
    preset_id: 'vllm',
    display_name: 'vLLM (self-hosted)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:8000/v1',
    default_residency: 'Your own vLLM server',
    verification: 'experimental',
    notes: 'Self-hosted vLLM inference server. Change the port if yours differs.',
  },
  {
    provider: 'openai',
    preset_id: 'localai',
    display_name: 'LocalAI (self-hosted)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:8080/v1',
    default_residency: 'Your own LocalAI server',
    verification: 'experimental',
    notes: 'Self-hosted LocalAI. Change the port if yours differs.',
  },
  {
    provider: 'openai',
    preset_id: 'groq',
    display_name: 'Groq',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.groq.com/openai/v1',
    default_residency: 'US (Groq Inc.) — on lynox\'s vetted sub-processor list',
    verification: 'experimental',
    notes: 'Fast inference. Model is free-text — pick a tool-capable one.',
  },
  {
    provider: 'openai',
    preset_id: 'together',
    display_name: 'Together AI',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.together.xyz/v1',
    default_residency: 'US (Together Computer) — on lynox\'s vetted sub-processor list',
    verification: 'experimental',
    notes: 'Model is free-text — pick a tool-capable one.',
  },
  {
    provider: 'openai',
    preset_id: 'fireworks',
    display_name: 'Fireworks AI',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.fireworks.ai/inference/v1',
    default_residency: 'US (Fireworks AI) — on lynox\'s vetted sub-processor list',
    verification: 'experimental',
    notes: 'Model is free-text — pick a tool-capable one.',
  },
];

export const LLM_CATALOG: LLMCatalog = [
  {
    provider: 'anthropic',
    display_name: 'Anthropic',
    models: ANTHROPIC_MODELS,
    requires_base_url: false,
    requires_region: false,
    default_residency: 'US (Anthropic; DPA + GDPR)',
    verification: 'native',
  },
  // Mistral is rendered as a first-class native option (its own button above
  // the generic OpenAI-compatible entry) so EU-sovereign customers don't
  // have to know they're going through the OpenAI wire format. Same
  // `provider: 'openai'` under the hood — disambiguated in the UI via
  // `preset_id`. The hostname-match in `getOpenAIModelMap` activates the
  // tier router regardless of which preset the user picked.
  {
    provider: 'openai',
    preset_id: 'mistral',
    display_name: 'Mistral',
    models: MISTRAL_MODELS,
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.mistral.ai/v1',
    default_residency: 'EU-Paris (Mistral SAS; DPA + GDPR)',
    verification: 'native',
    notes: 'EU-sovereign option. Pinned to api.mistral.ai — no base URL needed. Tier-aware: ministral / mistral-large picked from the model dropdown.',
  },
  ...OPENAI_COMPAT_PRESETS,
  {
    provider: 'custom',
    display_name: 'Anthropic-compatible endpoint',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'e.g. LiteLLM in Anthropic mode, or an Anthropic-API-compatible gateway',
    verification: 'experimental',
    notes: 'Anthropic wire (POST /v1/messages) against a custom base URL. Model ID is free-text — the endpoint routes.',
  },
  {
    provider: 'openai',
    preset_id: 'openai-compat',
    display_name: 'OpenAI-compatible endpoint',
    models: [],
    requires_base_url: true,
    requires_region: false,
    default_residency: 'depends on the operator-configured endpoint',
    verification: 'experimental',
    notes: 'Generic OpenAI wire (POST /chat/completions) for any OpenAI-API-compatible server without a preset above — a gateway, an aggregator, or your own proxy. Endpoints outside lynox\'s vetted sub-processor list route through the disclosure gate (see endpoint-allowlist.ts). Tool-calling reliability varies sharply by model and endpoint.',
  },
  {
    provider: 'vertex',
    display_name: 'Google Vertex AI (Claude)',
    models: VERTEX_MODELS,
    requires_base_url: false,
    requires_region: true,
    default_residency: 'GCP region (configurable)',
    verification: 'experimental',
    notes: 'Same Claude family routed through Vertex. Requires GCP project + region.',
  },
];

/**
 * Catalog entries whose behaviour on the wire is actually proven — `native`
 * providers plus any preset a real tool-calling round-trip has verified. The
 * complement (`experimental`) connects, but its tool-calling is unproven, so it
 * carries a caveat in the UI and should not be recommended as a default.
 */
export function verifiedProviderKeys(catalog: LLMCatalog = LLM_CATALOG): string[] {
  return catalog
    .filter((entry) => entry.verification !== 'experimental')
    .map(catalogEntryKey);
}

/**
 * Stable UI key per catalog entry. Multiple entries can share a `provider`
 * (Mistral + generic OpenAI-compatible both serialise to `'openai'`), so
 * `preset_id` is the disambiguator. Falls back to `provider` when omitted.
 */
export function catalogEntryKey(entry: CatalogProviderEntry): string {
  return entry.preset_id ?? entry.provider;
}

/**
 * Loopback hosts. Several local-runtime presets share these hostnames and are
 * distinguished only by port, so `resolveCatalogKey` switches to an exact
 * host:port comparison for them.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '[::1]'
    || hostname === '::1';
}

/** Look up a single provider entry. Returns undefined when the provider isn't catalogued. */
export function getCatalogForProvider(provider: LLMProvider): CatalogProviderEntry | undefined {
  return LLM_CATALOG.find((entry) => entry.provider === provider);
}

/** Look up a catalog entry by its UI key (preset_id or provider). */
export function getCatalogEntryByKey(key: string): CatalogProviderEntry | undefined {
  return LLM_CATALOG.find((entry) => catalogEntryKey(entry) === key);
}

/**
 * Disambiguate which catalog preset matches a persisted (provider,
 * api_base_url) pair. UI uses this on load so a returning user lands on
 * the same picker tile they previously saved.
 *
 * Matching is hostname-based (URL parser, NOT substring), mirroring
 * `getOpenAIModelMap` in `types/models.ts`. A hostile/misconfigured
 * api_base_url like `https://attacker.example.com/?proxy=mistral.ai`
 * therefore CANNOT accidentally activate the Mistral preset.
 *
 * Fallback order when no preset matches:
 *   1. Single-entry provider → that entry
 *   2. Multi-preset provider, no baseUrl supplied → the preset that
 *      `requires_base_url=true` (generic/free-text), so the user sees
 *      the input they need to fill in
 *   3. Otherwise → the first candidate (defensive — shouldn't happen
 *      in a well-formed catalog)
 *
 * `catalog` defaults to the live `LLM_CATALOG` but accepts an override
 * for unit testing. Pure function.
 */
export function resolveCatalogKey(
  provider: LLMProvider,
  baseUrl: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): string {
  const candidates = catalog.filter((p) => p.provider === provider);
  if (candidates.length === 0) return provider;
  if (candidates.length === 1) return catalogEntryKey(candidates[0]!);

  if (baseUrl) {
    let host = '';       // hostname only        — 'localhost', 'api.mistral.ai'
    let hostPort = '';   // hostname:port if any — 'localhost:11434'
    try {
      const u = new URL(baseUrl);
      host = u.hostname.toLowerCase();
      hostPort = u.host.toLowerCase();
    } catch { /* leave empty — falls through to the generic tile */ }

    if (host) {
      const matched = candidates.find((c) => {
        if (!c.base_url_default) return false;
        let defHost: string;
        let defHostPort: string;
        try {
          const d = new URL(c.base_url_default);
          defHost = d.hostname.toLowerCase();
          defHostPort = d.host.toLowerCase();
        } catch { return false; }

        // Loopback presets (Ollama :11434, LM Studio :1234, vLLM :8000,
        // LocalAI :8080) ALL share the hostname `localhost` — only the port
        // tells them apart. Matching on hostname alone would resolve every one
        // of them to whichever sits first in the catalog, so a user who saved
        // LM Studio would come back to the Ollama tile. Require the exact
        // host:port here. A non-default port simply falls through to the
        // generic tile, which is the safe direction to fail.
        if (isLoopbackHost(defHost)) return hostPort === defHostPort;

        // Remote presets: apex + `api.*` + subdomain variants all match —
        //   defHost='api.mistral.ai' matches 'api.mistral.ai',
        //   'mistral.ai' (apex) and 'eu.mistral.ai' (subdomain).
        // Crucially does NOT match 'api.mistral.ai.attacker.com', because the
        // suffix check requires a leading `.`.
        if (host === defHost) return true;
        const apex = defHost.replace(/^api\./, '');
        return host === apex || host.endsWith(`.${apex}`);
      });
      if (matched) return catalogEntryKey(matched);
    }
  }
  const generic = candidates.find((c) => c.requires_base_url);
  return catalogEntryKey(generic ?? candidates[0]!);
}

/**
 * Canonical tier→model map for a catalogued provider entry, or `null` for
 * free-text providers (openai-compat / custom) whose model is user-typed.
 * These are the same maps the engine's tier router resolves through, so the
 * derived picker options can never drift from what a `default_tier` write
 * actually reaches on the wire.
 */
function tierMapForEntry(entry: CatalogProviderEntry): Record<ModelTier, string> | null {
  if (entry.models.length === 0) return null;
  if (entry.provider === 'anthropic') return MODEL_MAP;
  if (entry.provider === 'vertex') return VERTEX_MODEL_MAP;
  if (entry.provider === 'openai' && entry.preset_id === 'mistral') return MISTRAL_MODEL_MAP;
  return null;
}

/**
 * Build the standard-mode "main chat model" options for a provider entry: one
 * per reachable band (fast / balanced / deep), the Anthropic balanced band split
 * into its served-Sonnet variants (4.6 / 5) since that provider resolves balanced
 * via `resolveBalancedModel(config.balanced_model)`. A band is only offered if the
 * catalog actually lists the model its tier resolves to — so Ministral 3B (a fast
 * extra that `fast`→8B never reaches) is correctly excluded, and no option can
 * point at a label the catalog doesn't carry.
 */
function buildMainChatModels(entry: CatalogProviderEntry): MainChatModel[] | undefined {
  const map = tierMapForEntry(entry);
  if (!map) return undefined;
  const has = (id: string): boolean => entry.models.some((m) => m.id === id);
  const out: MainChatModel[] = [];
  if (has(map.fast)) out.push({ id: map.fast, tier: 'fast' });
  if (entry.provider === 'anthropic') {
    // Every served-Sonnet the catalog lists is a reachable balanced pick via the
    // `balanced_model` override; carry it so the picker round-trips the choice.
    for (const m of entry.models) {
      if (m.tier === 'balanced' && SERVED_BALANCED_SONNET_IDS.has(m.id)) {
        out.push({ id: m.id, tier: 'balanced', balanced_model: m.id });
      }
    }
  } else if (has(map.balanced)) {
    out.push({ id: map.balanced, tier: 'balanced' });
  }
  if (has(map.deep)) out.push({ id: map.deep, tier: 'deep' });
  return out.length > 0 ? out : undefined;
}

// Deep-freeze at module load: protects the singleton against accidental
// mutation when consumers hand `LLM_CATALOG` straight to `jsonResponse`
// (the response body shares the reference until serialization).
for (const entry of LLM_CATALOG) {
  const mainChat = buildMainChatModels(entry);
  if (mainChat) {
    for (const opt of mainChat) Object.freeze(opt);
    entry.main_chat_models = Object.freeze(mainChat);
  }
  Object.freeze(entry.models);
  for (const m of entry.models) {
    Object.freeze(m);
    if (m.capabilities) Object.freeze(m.capabilities);
    if (m.pricing) Object.freeze(m.pricing);
  }
  Object.freeze(entry);
}
Object.freeze(LLM_CATALOG);
