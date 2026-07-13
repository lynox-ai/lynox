// === Pure helpers: the standard-mode "Main chat model" picker ===
//
// Extracted from `LLMSettings.svelte` so the tier-normalise + balanced-variant
// disambiguation + ceiling logic can be unit-tested without a Svelte runtime
// (same pattern as `llm-config-update.ts` / `llm-tile-lock.ts` /
// `context-window.ts`). The picker sets `default_tier` (+ the Anthropic
// `balanced_model` variant) from a server-computed catalog field
// (`main_chat_models`), so the UI never mirrors the tier→model map.

export type ModelTier = 'fast' | 'balanced' | 'deep';

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, deep: 2 };

// Mirrors `normalizeTier` / `LEGACY_TIER_ALIASES` in core `src/types/models.ts`
// — keep in lockstep. This is a tier-NAME normaliser only; the web-ui must NEVER
// mirror the tier→model MAP (arch-v2: options come from the catalog so new
// providers get them for free). The legacy alias set is frozen history.
export function normalizeTier(t: string | undefined): ModelTier | undefined {
  switch (t) {
    case 'fast': case 'haiku': return 'fast';
    case 'balanced': case 'sonnet': return 'balanced';
    case 'deep': case 'opus': return 'deep';
    default: return undefined;
  }
}

/**
 * A model is "expensive" (⚡) when its output price is in Opus territory
 * ($20+/M out). The catalog's deep Claude (Opus, $25/M) trips this; Sonnet
 * ($15), Haiku ($5) and every Mistral model ($≤1.50) do not — so the cue lands
 * exactly on the budget-heavy choices (D8: no gating, cost-transparency).
 */
export function isExpensiveModel(pricing: { output: number } | undefined): boolean {
  return typeof pricing?.output === 'number' && pricing.output >= 20;
}

/** One server-computed main-chat option (mirrors catalog.ts `MainChatModel`). */
export interface MainChatOption {
  id: string;
  tier: ModelTier;
  balanced_model?: string;
}

/** The subset of a catalog provider entry this module needs (structural). */
export interface ProviderLike {
  main_chat_models?: MainChatOption[];
  models: Array<{ id: string; label: string; pricing?: { input: number; output: number } }>;
}

/** A picker option ready to render: option + resolved label/pricing + UI flags. */
export interface MainModelOption {
  id: string;
  tier: ModelTier;
  balanced_model?: string;
  label: string;
  pricing?: { input: number; output: number };
  expensive: boolean;
  /** Above the tenant's `max_tier` ceiling → rendered disabled with a tooltip. */
  overCeiling: boolean;
  /** `fast` as a main chat model — offered, but flagged "not recommended". */
  notRecommended: boolean;
}

/**
 * Build the picker's options for a provider entry: the server-computed
 * `main_chat_models` joined with catalog `models` for label/pricing, plus the
 * per-option UI flags. Empty for free-text providers (no `main_chat_models`).
 */
export function buildMainModelOptions(
  entry: ProviderLike | undefined,
  maxTier: string | undefined,
): MainModelOption[] {
  if (!entry?.main_chat_models || entry.main_chat_models.length === 0) return [];
  const ceiling = normalizeTier(maxTier);
  const ceilingRank = ceiling ? TIER_RANK[ceiling] : null;
  return entry.main_chat_models.map((opt) => {
    const m = entry.models.find((mm) => mm.id === opt.id);
    return {
      id: opt.id,
      tier: opt.tier,
      ...(opt.balanced_model ? { balanced_model: opt.balanced_model } : {}),
      label: m?.label ?? opt.id,
      ...(m?.pricing ? { pricing: m.pricing } : {}),
      expensive: isExpensiveModel(m?.pricing),
      overCeiling: ceilingRank !== null && TIER_RANK[opt.tier] > ceilingRank,
      notRecommended: opt.tier === 'fast',
    };
  });
}

/**
 * The option id currently selected — matched from `default_tier` (normalised,
 * legacy aliases accepted) plus `balanced_model` to disambiguate the two
 * Anthropic balanced variants (Sonnet 4.6 vs 5). An unset/legacy `default_tier`
 * resolves to the balanced band (the engine default). If a provider has no
 * option for the resolved tier (a future catalogued provider missing that band),
 * fall back to the first option rather than `''` — an empty value would leave
 * the `<select>` silently showing its first option while the engine routes to a
 * different default.
 */
export function selectMainModelId(
  options: MainModelOption[],
  defaultTier: string | undefined,
  balancedModel: string | undefined,
): string {
  if (options.length === 0) return '';
  const tier = normalizeTier(defaultTier) ?? 'balanced';
  if (tier === 'balanced') {
    const match = options.find((o) => o.tier === 'balanced' && o.balanced_model === balancedModel)
      ?? options.find((o) => o.tier === 'balanced' && o.balanced_model === undefined)
      ?? options.find((o) => o.tier === 'balanced');
    return match?.id ?? options[0]?.id ?? '';
  }
  return options.find((o) => o.tier === tier)?.id ?? options[0]?.id ?? '';
}

/**
 * The capability tiers a NEW-chat composer picker may offer, gated by the
 * tenant's `max_tier` cost ceiling. **Cost-ASCENDING order (fast → balanced →
 * deep)** — deliberately NOT deep-first: putting deep at the top suggests "deep
 * is the best choice", which lures a non-technical user into always picking
 * Opus and burning money (on managed, WE pay the difference). Cheapest-first
 * with deep LAST reframes deep as the specialised/pricier option, not the
 * default-best. An unset ceiling (self-host default) offers all three. The
 * engine still clamps server-side (the ctor delegates to resolveRunModel), so
 * this is a UX filter, not the security boundary.
 */
export function availableComposerTiers(maxTier: string | undefined): ModelTier[] {
  const ordered: ModelTier[] = ['fast', 'balanced', 'deep'];
  const ceiling = normalizeTier(maxTier);
  if (!ceiling) return ordered;
  const ceilingRank = TIER_RANK[ceiling];
  return ordered.filter((t) => TIER_RANK[t] <= ceilingRank);
}
