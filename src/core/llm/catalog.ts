/**
 * Static LLM model catalog. Pricing here is approximate "headline" USD
 * per 1M tokens — real cost accounting goes through `core/pricing.ts`
 * (cache discounts etc.). Catalog is frozen so consumers can pass it
 * by reference without risk of cross-request mutation.
 */

import type { LLMProvider, ModelTier } from '../../types/models.js';
import type { TierSet } from '../../types/config.js';
import type { ProviderKey } from '../../types/provider-registry.js';
import {
  MODEL_MAP,
  VERTEX_MODEL_MAP,
  MISTRAL_MODEL_MAP,
  SERVED_BALANCED_SONNET_IDS,
  getModelId,
  modelCapability,
} from '../../types/models.js';

/**
 * Human context-window shorthand for picker labels: 1_000_000 → "1M",
 * 262_144 → "256k", 200_000 → "200k". Binary-k models (2^n windows) render
 * their conventional size; everything else rounds to decimal k. Returns ''
 * for unknown/absent windows so callers can append conditionally.
 * Mirrored in web-ui `llm-main-model.ts` (`formatContextWindow`) — the file
 * architecture forbids direct core imports there; keep both in lockstep.
 */
export function formatContextWindow(n: number | undefined): string {
  if (!n || n <= 0) return '';
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  // Decimal thousands FIRST: 256_000 is divisible by 1024 too (1024×250), and
  // the binary branch rendered it "250k" — factually wrong for a model
  // advertised as 256k (pr-review #1165). Binary windows (262_144, 131_072)
  // are never divisible by 1000, so they still reach the 1024 branch.
  if (n % 1000 === 0) return `${n / 1000}k`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return `${Math.round(n / 1000)}k`;
}

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
   * Models the PER-TIER picker (hybrid routing's manual editor) may offer for an
   * entry whose `models` is deliberately empty. `models: []` is the TILE's
   * free-text contract — the user (or their runtime) picks the model, and we do
   * not pretend to a tier map we have not measured — and it stays empty. A tier
   * SLOT is a different promise: it pins exactly one model per band, so the
   * picker needs a short, vetted list instead of a free-text field per tier.
   *
   * These are therefore only the entry's vetted, currently-served models —
   * either replay-MEASURED preset-slot models or explicitly-marked CANDIDATES
   * (unmeasured, picker-selectable for canary testing; no preset pins them) —
   * each id registered in MODEL_CAPABILITIES, pricing/context mirrored from
   * there (same drift-guard test as `models`). Entries that ship a `models`
   * catalog never need this: the picker uses `models` directly.
   *
   * Deliberately WITHOUT `tier`: these are preset-slot models (`tier: null` in
   * the registry — no tier map exists for the endpoint), so tagging a band here
   * would fake a mapping. The picker defaults to the first entry.
   */
  tier_models?: ReadonlyArray<CatalogModel>;
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
  /**
   * Vault slot this entry's API key lives in. `null` = the entry needs no
   * credential at all (loopback runtimes; Vertex, which uses GCP OAuth).
   *
   * This exists because the slot CANNOT be derived from `provider` alone. Every
   * preset here serialises to `provider: 'openai'` on the wire — Mistral, Groq,
   * Together, Fireworks and a local Ollama are all "openai" — so a provider-keyed
   * lookup hands whichever key sits in the openai slot to whatever endpoint is
   * configured. That is a cross-provider credential leak: pick the Groq tile with
   * a Mistral key stored and the Mistral key is sent, as a bearer token, to Groq.
   * (`resolveProviderApiKey` already reasons about exactly this hazard for the
   * Anthropic legacy fallback; it just had no way to see the endpoint.)
   *
   * So the slot is a property of the ENDPOINT, not of the wire format, and it
   * belongs on the catalog entry that pins that endpoint.
   *
   * Back-compat: `mistral` and the generic `openai-compat` tile keep the historic
   * `MISTRAL_API_KEY` slot — existing installs already store their key there, and
   * moving it would silently log them out.
   */
  vault_slot?: string | null;
  /**
   * The endpoint MAY take a key but does not require one.
   *
   * Local runtimes are the case: Ollama serves unauthenticated, but the same
   * loopback ports are routinely held by an authenticated gateway (vLLM or
   * LiteLLM started with `--api-key`, an SSH tunnel). Giving them a slot of their
   * OWN keeps the cross-vendor leak shut — a Mistral key can never reach them,
   * because it lives in a different slot — while still letting a user who needs a
   * key store one. Readiness checks must not demand it, or an unauthenticated
   * local install sits behind a setup banner it can never satisfy.
   *
   * (An earlier cut of this used `vault_slot: null` for loopback. That closed the
   * leak but silently broke every authenticated local gateway: no key sent, 401,
   * and the UI hid the field needed to fix it.)
   */
  credential_optional?: boolean;
  /**
   * Example model id for the free-text field a `models: []` entry renders. The
   * generic placeholder is a Claude id, which is actively misleading on an Ollama
   * or Groq tile — the user would copy a model that endpoint has never heard of.
   */
  model_placeholder?: string;
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
    notes: 'Strong deep reasoning at ~1.7× the cost of Sonnet; the standard-mode deep default. Superseded by Opus 5 for new work.',
  },
  {
    id: 'claude-opus-5',
    tier: 'deep',
    label: 'Opus 5',
    context_window: 1_000_000,
    pricing: { input: 5, output: 25 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Newest flagship deep model (GA 2026-07) — for complex agentic and enterprise work, same $5/$25 as Opus 4.6, adaptive thinking on by default. Offered alongside Fable 5 as a deep option.',
  },
  {
    id: 'claude-fable-5',
    tier: 'deep',
    label: 'Fable 5',
    context_window: 1_000_000,
    pricing: { input: 10, output: 50 },
    capabilities: ['vision', 'tool_use', 'extended_thinking'],
    residency: 'US (Anthropic; DPA + GDPR)',
    notes: 'Flagship — most capable model for demanding reasoning + long-horizon agentic work (1M context, up to 128k output). Priciest tier at $10/$50 per M. NOT in any preset since 2026-08-10 (max-quality deep is opus-5 at $5/$25) — a preset is what someone lands on, and an escalation can enter that slot without a deliberate choice. Selectable here for anyone who wants it explicitly.',
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
    id: 'mistral-medium-2604',
    tier: 'deep',
    label: 'Mistral Medium 3.5',
    context_window: 262_144,
    pricing: { input: 1.50, output: 7.50 },
    capabilities: ['tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'The Mistral deep tier — a newer, stronger generation than Large 3 for deep reasoning and analysis (Large is being deprecated to legacy). 262k context, native prompt-cache. Text-only (no vision). Note Mistral has no 1M-context deep.',
  },
  {
    id: 'mistral-large-2512',
    tier: 'deep',
    label: 'Mistral Large 3',
    context_window: 256_000,
    pricing: { input: 0.50, output: 1.50 },
    capabilities: ['vision', 'tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Being deprecated to legacy — Medium 3.5 is the stronger deep now. Cheaper ($0.50/$1.50) and multimodal (vision), but weaker on deep analysis. 256k context, native prompt-cache.',
  },
  {
    id: 'ministral-14b-2512',
    tier: 'balanced',
    label: 'Ministral 14B',
    context_window: 262_144,
    pricing: { input: 0.20, output: 0.20 },
    capabilities: ['vision', 'tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Gen-3 mid model, text+vision. Strong tool-ROUTER (100% Set-Bench) but below the R1/R3 orchestration floor as a main — the balanced tier now resolves to Medium 3.5 (WS2); 14B stays a catalog extra.',
  },
  {
    id: 'ministral-3b-2512',
    tier: 'fast',
    label: 'Ministral 3B',
    context_window: 262_144,
    pricing: { input: 0.10, output: 0.10 },
    capabilities: ['vision', 'tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Cheapest Mistral model. Orchestration, classification, routing. Gen-3 multimodal (text+vision).',
  },
  {
    id: 'ministral-8b-2512',
    tier: 'fast',
    label: 'Ministral 8B',
    context_window: 262_144,
    pricing: { input: 0.15, output: 0.15 },
    capabilities: ['vision', 'tool_use'],
    residency: 'EU-Paris (Mistral SAS)',
    notes: 'Recommended fast-tier default. Gen-3 multimodal (text+vision). 100% pass on all 8 bench axes at $0.00006–$0.00038 warm per loop.',
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
    model_placeholder: 'qwen2.5',
    vault_slot: 'OLLAMA_API_KEY',
    credential_optional: true,
    display_name: 'Ollama (local)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:11434/v1',
    default_residency: 'Your machine — the model call stays on the host',
    // Promoted 2026-07-13: `tests/online/provider-preset-reachability.test.ts`
    // drove a full tool_use → tool_result → answer round-trip through Ollama on
    // qwen2.5:7b, and a mutation run confirmed the assertion can actually fail.
    // The WIRE is proven; the model is still the user's choice, hence the note.
    verification: 'verified',
    notes: 'Local models via Ollama — the model call stays on your machine. Pick a tool-capable model (qwen2.5, llama3.1, mistral-nemo): lynox is an agent, and a model without tool support cannot drive it.',
  },
  {
    provider: 'openai',
    preset_id: 'lmstudio',
    model_placeholder: 'qwen2.5-7b-instruct',
    vault_slot: 'LMSTUDIO_API_KEY',
    credential_optional: true,
    display_name: 'LM Studio (local)',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'http://localhost:1234/v1',
    default_residency: 'Your machine — the model call stays on the host',
    verification: 'experimental',
    notes: 'Local models via LM Studio\'s OpenAI-compatible server. Requires a tool-capable model.',
  },
  {
    provider: 'openai',
    preset_id: 'vllm',
    model_placeholder: 'Qwen/Qwen2.5-7B-Instruct',
    vault_slot: 'VLLM_API_KEY',
    credential_optional: true,
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
    model_placeholder: 'qwen2.5-7b-instruct',
    vault_slot: 'LOCALAI_API_KEY',
    credential_optional: true,
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
    model_placeholder: 'llama-3.3-70b-versatile',
    vault_slot: 'GROQ_API_KEY',
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
    model_placeholder: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    vault_slot: 'TOGETHER_API_KEY',
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
    model_placeholder: 'accounts/fireworks/models/gpt-oss-120b',
    vault_slot: 'FIREWORKS_API_KEY',
    display_name: 'Fireworks AI',
    models: [],
    requires_base_url: false,
    requires_region: false,
    base_url_default: 'https://api.fireworks.ai/inference/v1',
    default_residency: 'US (Fireworks AI) — on lynox\'s vetted sub-processor list',
    // Promoted 2026-07-14: the reachability suite drove a full tool_use →
    // tool_result → answer round-trip through Fireworks on gpt-oss-120b. The wire
    // is proven; the model stays the user's choice. The old placeholder pinned
    // llama-v3p3-70b-instruct, which Fireworks no longer serves (a copy 404s), so
    // it moved to a currently-served tool-capable model.
    verification: 'verified',
    notes: 'Model is free-text — pick a tool-capable one.',
    // Per-tier picker options only (`tier_models`, see the interface doc): the
    // currently-served preset-slot/candidate models. GLM + DeepSeek are replay
    // -measured; Kimi K3 is a CANDIDATE (added 2026-08-09 for the rafael canary,
    // replay measurement owed via the #1112 harness before any preset pins it).
    // The TILE stays free-text (`models: []` above is untouched). No `tier`
    // field — all are `tier: null` in MODEL_CAPABILITIES (no measured tier map).
    tier_models: [
      {
        id: 'accounts/fireworks/models/glm-5p2',
        label: 'GLM 5.2',
        context_window: 1_000_000,
        pricing: { input: 1.40, output: 4.40 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '1M context; the MAIN slot of the balanced preset since 2026-08-10 (it previously served efficient\'s deep slot). Text-only (no vision).',
      },
      {
        id: 'accounts/fireworks/models/deepseek-v4-pro',
        label: 'DeepSeek v4 Pro',
        context_window: 1_000_000,
        pricing: { input: 1.74, output: 3.48 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '1M context; alternative deep/big-context model. Text-only (no vision).',
      },
      {
        id: 'accounts/fireworks/models/kimi-k3',
        label: 'Kimi K3',
        context_window: 1_000_000,
        pricing: { input: 3.00, output: 15.00 },
        capabilities: ['vision', 'tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '1M context; deep slot of the efficient + balanced presets — operator decision on the chat sweep, no deep bench exists. Vision validated on the openai wire 2026-08-14 (fireworks-vision online test).',
      },
      {
        id: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        label: 'DeepSeek v4 Flash',
        context_window: 1_000_000,
        pricing: { input: 0.14, output: 0.28 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '1M context; FAST slot only — benched there (89.1% recall, best judge of the field), never as a main. Text-only (no vision). Dated id: Fireworks retired the unsuffixed alias on 2026-08-14.',
      },
      {
        id: 'accounts/fireworks/models/qwen3p7-plus',
        label: 'Qwen3.7 Plus',
        context_window: 262_144,
        pricing: { input: 0.40, output: 1.60 },
        capabilities: ['vision', 'tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '262k context; fast-slot bench HOLD (87.9% recall / judge 6.96) and the quickest of the sweep. Pinned by no preset — lost the efficient main to minimax-m3 on quality. Vision validated on the openai wire 2026-08-14 (fireworks-vision online test).',
      },
      {
        id: 'accounts/fireworks/models/gpt-oss-120b',
        label: 'GPT-OSS 120B',
        context_window: 131_072,
        pricing: { input: 0.15, output: 0.60 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance US (OpenAI open weights)',
        // Measured 2026-08-09/10, kept selectable but no longer recommended: on an
        // open-ended chat turn it plans a reply in `reasoning_content` and then emits
        // an EMPTY `content` with only the tool call, so the user sees no answer — and
        // it sometimes prints the tool JSON into the visible text as well. Both are
        // model behaviour, not our wire handling: the same adapter serves eight other
        // openai-wire models cleanly. Its compaction recall also came in at 66% against
        // a 90% reference. Fine for a scripted tool round-trip, poor as a chat model.
        notes: '131k context; tool_use wire proven by the reachability suite. Text-only. NOT recommended as a chat model: measured empty-text turns and tool-JSON leaking into the visible answer (model behaviour), plus weak recall when summarizing.',
      },
      {
        id: 'accounts/fireworks/models/kimi-k2p6',
        label: 'Kimi K2.6',
        context_window: 262_144,
        pricing: { input: 0.95, output: 4.00 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '262k context; generalist main-chat candidate (unmeasured). Text-only for now (Fireworks serves vision, not yet validated on the openai wire).',
      },
      {
        id: 'accounts/fireworks/models/kimi-k2p7-code',
        label: 'Kimi K2.7 Code',
        context_window: 262_144,
        pricing: { input: 0.95, output: 4.00 },
        capabilities: ['tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '262k context; agentic/coding candidate (unmeasured); reasons on every turn (no non-thinking mode). Text-only for now.',
      },
      {
        id: 'accounts/fireworks/models/minimax-m3',
        label: 'MiniMax M3',
        context_window: 524_288,
        pricing: { input: 0.30, output: 1.20 },
        capabilities: ['vision', 'tool_use'],
        residency: 'US (Fireworks AI) — model provenance CN',
        notes: '512k context; main slot of the efficient preset — chat sweep, no main-slot bench. Vision validated on the openai wire 2026-08-14 (fireworks-vision online test).',
      },
    ],
  },
];

export const LLM_CATALOG: LLMCatalog = [
  {
    provider: 'anthropic',
    display_name: 'Anthropic',
    vault_slot: 'ANTHROPIC_API_KEY',
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
    vault_slot: 'MISTRAL_API_KEY',
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
    vault_slot: 'CUSTOM_API_KEY',
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
    vault_slot: 'MISTRAL_API_KEY',   // historic slot — moving it would log existing installs out
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
    vault_slot: null,   // GCP OAuth, not an API key
    models: VERTEX_MODELS,
    requires_base_url: false,
    requires_region: true,
    default_residency: 'GCP region (configurable)',
    verification: 'experimental',
    notes: 'Same Claude family routed through Vertex. Requires GCP project + region.',
  },
];

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
 *
 * `[::1]` is the bracketed form `URL.hostname` actually returns for IPv6; the
 * bare `::1` never appears there, so it is not listed.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '[::1]';
}

/** Port of a `host[:port]` pair; '' when the URL carried none. */
function portOf(hostPort: string): string {
  const i = hostPort.lastIndexOf(':');
  return i === -1 ? '' : hostPort.slice(i + 1);
}

/**
 * The vault slot the key for a given (provider, endpoint) pair lives in.
 *
 * This is the fix for a cross-provider credential leak: the slot cannot be
 * derived from `provider` alone, because Mistral, Groq, Together, Fireworks and
 * a local Ollama all serialise to `provider: 'openai'`. Resolving by provider
 * hands whatever key sits in the openai slot to whatever endpoint is configured
 * — so a user with a Mistral key who selects Groq would send that Mistral key,
 * as a bearer token, to Groq. Resolve by ENDPOINT instead.
 *
 * Returns `null` when the endpoint needs no credential at all (loopback
 * runtimes, Vertex) — callers must then send no key rather than fall back to a
 * provider default, which would reintroduce the leak.
 *
 * Returns `undefined` when the pair matches no catalog entry, leaving the caller
 * to apply its own default (see `resolveProviderApiKey`).
 */
export function vaultSlotForEndpoint(
  provider: LLMProvider | undefined | null,
  apiBaseURL: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): string | null | undefined {
  if (!provider) return undefined;
  const key = resolveCatalogKey(provider, apiBaseURL, catalog);
  const entry = catalog.find((e) => catalogEntryKey(e) === key);
  return entry?.vault_slot;
}

/**
 * The vault slot for an endpoint lynox actually PINS — one that matched a preset
 * by host.
 *
 * Returns `undefined` for anything that fell through to the generic tile. That
 * distinction is a security boundary, not a nicety: the generic tile's slot is the
 * SHARED one, so treating a fall-through as a match would promote the shared key
 * onto an arbitrary host — which is exactly how `api.mistral.ai.evil.com` would
 * come to be handed the Mistral key, and how a user's own configured key would be
 * overwritten by a vendor key that has nothing to do with their endpoint.
 *
 * Use this wherever a key is being ASSIGNED to an endpoint. Use
 * `vaultSlotForEndpoint` (which does fall through) only where a key is being READ
 * back for an endpoint the user already chose.
 */
export function pinnedVaultSlotForEndpoint(
  provider: LLMProvider | undefined | null,
  apiBaseURL: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): string | null | undefined {
  if (!provider || !apiBaseURL) return undefined;
  const key = resolveCatalogKey(provider, apiBaseURL, catalog);
  const entry = catalog.find((e) => catalogEntryKey(e) === key);
  if (!entry?.base_url_default) return undefined;   // generic / free-text tile
  return entry.vault_slot;
}

/** Who a (provider, endpoint) pair IS, and what to call it. */
export interface ProviderIdentity {
  /**
   * Stable dedup key. Distinct from the label on purpose: two different
   * unpinned proxies both DISPLAY as "OpenAI-compatible", so comparing display
   * strings would silently drop one of two genuinely different providers.
   */
  key: string;
  /** Human brand name — what the status bar prints. */
  label: string;
}

/**
 * The first-class registry key `'mistral'` (provider-registry.ts) IS the pinned
 * Mistral endpoint — it carries the host in its identity and arrives without a
 * base URL. It must therefore share a key with `openai` + `api.mistral.ai`, or
 * one provider would be listed twice under two spellings.
 */
// A Map, not an object literal: the lookup key comes from LYNOX_TIER_SET_JSON,
// and `{}['constructor']` is a truthy Object.prototype member. An object here
// would answer `'constructor'` / `'__proto__'` / `'toString'` with a garbage
// identity — `{key: undefined, label: undefined}` — which both blanks the
// provider name in the response and collapses two different providers onto one
// dedup key. `resolveCatalogKey` documents the same class of bug (it uses
// `Object.hasOwn` for it); a Map has no prototype chain to walk at all.
const NATIVE_IDENTITIES: ReadonlyMap<string, ProviderIdentity> = new Map([
  ['anthropic', { key: 'preset:anthropic', label: 'Anthropic' }],
  ['vertex', { key: 'preset:vertex', label: 'Google Vertex AI' }],
  ['mistral', { key: 'preset:mistral', label: 'Mistral' }],
]);

/** Reduce a name to the plain label characters that may reach the UI. */
function sanitizeLabel(s: string): string {
  return s.replace(/[^\w .+-]/g, '').trim();
}

/**
 * Host of a base URL, or a bounded form of the raw string when it will not parse.
 * A trailing root dot is normalised away — `api.example.com.` and
 * `api.example.com` are the same host, and keeping both would list one provider
 * twice. The scheme is deliberately NOT part of the key: http and https to the
 * same host are one provider.
 */
function endpointHost(apiBaseURL: string | undefined): string {
  if (!apiBaseURL) return '';
  const strip = (h: string): string => h.replace(/\.(?=$|:)/, '');
  try {
    return strip(new URL(apiBaseURL).host.toLowerCase());
  } catch {
    return strip(apiBaseURL.trim().toLowerCase().slice(0, 64));
  }
}

/**
 * Identify a (provider, endpoint) pair — for the status bar, which must both
 * NAME every provider an instance talks to and count each of them once.
 *
 * A brand may only come from a catalog entry lynox PINS by URL
 * (`base_url_default`), the same discipline as `pinnedVaultSlotForEndpoint`: the
 * generic openai-compat tile matches ANY host, so letting it lend a display name
 * would label `api.mistral.ai.attacker.com` as "Mistral". The hostname matching
 * itself is `resolveCatalogKey`'s, which already refuses that suffix trick.
 *
 * The provider key is compared CASE-FOLDED. It reaches here from
 * `LYNOX_TIER_SET_JSON`, an untrusted boundary, and an exact-case ladder let a
 * single capital letter (`'Mistral'`) skip every branch and fall through to the
 * raw-key path — which printed the brand "Mistral" for an arbitrary endpoint,
 * defeating the pinning above. For the same reason the raw-key fall-through
 * refuses any name that collides with a brand we DO verify.
 *
 * The wire labels ('OpenAI-compatible' / 'Custom') are what the status bar
 * printed before hybrid routing existed. They are honest rather than vague:
 * they state what we know — the wire — and claim no brand we cannot verify.
 */
export function providerIdentity(
  provider: ProviderKey,
  apiBaseURL?: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): ProviderIdentity {
  const folded = provider.trim().toLowerCase();
  const native = NATIVE_IDENTITIES.get(folded);
  if (native) return native;

  // Re-stated as literals rather than narrowed in place: `ProviderKey` is an
  // OPEN union (`string & {}`), so an `=== 'openai'` comparison does not narrow.
  const wire: LLMProvider | undefined =
    folded === 'openai' ? 'openai' : folded === 'custom' ? 'custom' : undefined;
  if (wire) {
    const catKey = resolveCatalogKey(wire, apiBaseURL, catalog);
    const entry = catalog.find((e) => catalogEntryKey(e) === catKey);
    if (entry?.base_url_default) return { key: `preset:${catKey}`, label: entry.display_name };
    // Generic tile. The label cannot tell two proxies apart, so the KEY carries
    // the host — otherwise a second, differently-configured endpoint would be
    // deduped away and its outage would never reach the status bar.
    return {
      key: `endpoint:${wire}:${endpointHost(apiBaseURL)}`,
      label: wire === 'openai' ? 'OpenAI-compatible' : 'Custom',
    };
  }

  // An unregistered provider key. Print what is configured — bounded and
  // stripped to plain label characters, because this string reaches the UI —
  // unless it impersonates a brand this function otherwise only grants to a
  // verified endpoint.
  const cleaned = sanitizeLabel(provider).slice(0, 24);
  // Compare the SANITISED form on both sides. Comparing against the raw
  // display_name let every brand containing a stripped character through:
  // 'Ollama (local)' sanitises to 'Ollama local', which matched nothing and was
  // printed verbatim — a borrowed brand wearing one less bracket.
  const folded_clean = cleaned.toLowerCase();
  const impersonates = catalog.some((e) => sanitizeLabel(e.display_name).toLowerCase() === folded_clean)
    || [...NATIVE_IDENTITIES.values()].some((n) => sanitizeLabel(n.label).toLowerCase() === folded_clean);
  return {
    key: `provider:${folded}`,
    label: cleaned && !impersonates ? cleaned : 'Unknown provider',
  };
}

/**
 * Does this endpoint require an API key at all?
 *
 * A loopback runtime does not — Ollama and friends serve unauthenticated on the
 * user's own machine. Readiness checks must not demand a key there, or a working
 * local install would sit behind a setup banner it can never satisfy.
 *
 * Conservative by default: an endpoint we do not recognise is assumed to need
 * one, so an unknown host never silently skips its credential check.
 */
export function endpointNeedsCredential(
  provider: LLMProvider | undefined | null,
  apiBaseURL: string | undefined,
  catalog: LLMCatalog = LLM_CATALOG,
): boolean {
  if (!provider) return true;
  const key = resolveCatalogKey(provider, apiBaseURL, catalog);
  const entry = catalog.find((e) => catalogEntryKey(e) === key);
  if (!entry) return true;                       // unknown host — assume it needs one
  if (entry.vault_slot === null) return false;   // no credential concept (Vertex → GCP OAuth)
  if (entry.credential_optional) return false;   // may take one, does not require it
  return true;
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
        // The user may write any loopback spelling — `localhost`, `127.0.0.1`,
        // `0.0.0.0`. Comparing the literal string would send
        // `http://127.0.0.1:11434/v1` to the GENERIC tile instead of Ollama's, and
        // the generic tile's slot is the shared one: the Mistral key, in plaintext,
        // to a local port. So accept any loopback host on either side and let the
        // PORT do the distinguishing. A non-loopback host can never satisfy this,
        // so it cannot borrow a local runtime's credential-optional status.
        if (isLoopbackHost(defHost)) {
          return isLoopbackHost(host) && portOf(hostPort) === portOf(defHostPort);
        }

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
  // Deliberately NOT deduped when balanced == deep (Mistral: both are Medium 3.5
  // since the 14B main fell below the orchestration floor and Mistral has nothing
  // stronger): the composer's per-TIER labels read this same array, so dropping
  // the deep row would strip the deep band's model name. Two rows sharing one id
  // is honest — the bands differ (default_tier semantics), the model does not.
  if (has(map.deep)) out.push({ id: map.deep, tier: 'deep' });
  return out.length > 0 ? out : undefined;
}

/**
 * Per-tier model LABEL for a catalog entry's main-chat models, keyed by tier —
 * the composer picker's name-enrichment source ("Tief (Opus 4.6)"). Returns
 * `undefined` when the entry exposes fewer than two DISTINCT tier models (a
 * single-model custom / OpenAI-compat provider whose tiers all resolve to one
 * model); the picker reads that absence as "hide, don't offer fake choices".
 * `resolvedBalanced` disambiguates the Anthropic balanced band's served-Sonnet
 * variants (4.6 vs 5) to the tenant's configured one so the label matches what
 * actually routes. Pure view over `main_chat_models`, so it can't drift from the
 * tier→model maps.
 */
export function mainChatTierLabels(
  entry: CatalogProviderEntry,
  resolvedBalanced: string,
): Partial<Record<ModelTier, string>> | undefined {
  const models = entry.main_chat_models;
  if (!models || models.length === 0) return undefined;
  // Context window rides the label ("Haiku 4.5 · 200k") — rafael 2026-08-09:
  // every model picker states the window. Registry-sourced (not the catalog
  // row) so the number matches what the engine actually trims against.
  const labelForId = (id: string): string => {
    const base = entry.models.find((m) => m.id === id)?.label ?? id;
    const ctx = formatContextWindow(modelCapability(id)?.contextWindow);
    return ctx ? `${base} · ${ctx}` : base;
  };
  const out: Partial<Record<ModelTier, string>> = {};
  const pickedIds: string[] = [];
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const forTier = models.filter((mc) => mc.tier === tier);
    if (forTier.length === 0) continue;
    // The balanced band may carry two served-Sonnet variants; prefer the
    // tenant's configured one so the label matches what runs.
    const pick =
      tier === 'balanced'
        ? forTier.find((mc) => mc.balanced_model === resolvedBalanced) ?? forTier[0]!
        : forTier[0]!;
    pickedIds.push(pick.id);
    out[tier] = labelForId(pick.id);
  }
  // Only a REAL picker (≥2 distinct MODELS) is worth surfacing; one model across
  // all tiers ⇒ undefined ⇒ hidden. Dedup on the model id (not the label) so the
  // threshold tracks the requirement — "does the provider route to >1 model" —
  // and can't be fooled by two models that happen to share a display label.
  return new Set(pickedIds).size >= 2 ? out : undefined;
}

/**
 * Hybrid-routing counterpart to {@link mainChatTierLabels}. In `routing_mode:
 * 'hybrid'` each tier may run a DIFFERENT provider+model via the `tier_set`, so
 * the single-provider `main_chat_models` map is the wrong source — it shows the
 * base provider's default (e.g. "Ausgewogen (Sonnet 5)") while the tier actually
 * runs the slot's model (e.g. Mistral Large). This resolves each tier the same
 * way `resolveTierModel` does at runtime — the configured slot's model_id, else
 * the base provider's tier model — and looks the LABEL up catalog-wide (a slot's
 * model can belong to any provider's entry), so the picker label matches what
 * routes. Same ≥2-distinct-models hide rule as the standard path.
 */
export function mainChatTierLabelsFromTierSet(
  tierSet: TierSet,
  baseProvider: LLMProvider,
  catalog: LLMCatalog = LLM_CATALOG,
): Partial<Record<ModelTier, string>> | undefined {
  const out: Partial<Record<ModelTier, string>> = {};
  const pickedIds: string[] = [];
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const slot = tierSet[tier];
    // Mirror resolveTierModel: the slot names its own model; otherwise the base
    // provider's tier model (getModelId resolves the served balanced variant).
    // The slot's provider is not needed here — the label is looked up catalog-WIDE
    // by model id, since a slot's model can belong to any provider's entry
    // (Mistral runs on the openai-wire entry). `tier_models` is part of the
    // lookup: a Fireworks slot's model lives ONLY there (the tile is free-text,
    // `models: []`), and without it the picker would label the tier with the raw
    // `accounts/fireworks/models/…` path. Fall back to the raw id.
    const modelId = slot?.model_id ?? getModelId(tier, baseProvider);
    const base = catalog
      .flatMap((e) => [...e.models, ...(e.tier_models ?? [])])
      .find((m) => m.id === modelId)?.label ?? modelId;
    // Same window suffix as mainChatTierLabels — registry-sourced.
    const ctx = formatContextWindow(modelCapability(modelId)?.contextWindow);
    pickedIds.push(modelId);
    out[tier] = ctx ? `${base} · ${ctx}` : base;
  }
  return new Set(pickedIds).size >= 2 ? out : undefined;
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
  for (const m of [...entry.models, ...(entry.tier_models ?? [])]) {
    Object.freeze(m);
    if (m.capabilities) Object.freeze(m.capabilities);
    if (m.pricing) Object.freeze(m.pricing);
  }
  if (entry.tier_models) Object.freeze(entry.tier_models);
  Object.freeze(entry);
}
Object.freeze(LLM_CATALOG);
