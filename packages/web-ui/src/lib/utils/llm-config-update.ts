// === Pure helper: build the PUT /api/config body from LLMSettings state ===
//
// Extracted from `LLMSettings.svelte:saveConfig` so the provider-binding
// staging logic can be unit-tested without a Svelte runtime or jsdom.
//
// This is the function that decides which fields land on /api/config when
// the user clicks Save. F1 from the 2026-05-17 staging QA (provider-switch
// back to Anthropic left stale `api_base_url`/`openai_model_id`) was a bug
// in this logic; the unit tests below pin the contract so a future refactor
// can't re-introduce the leak.

export type LLMProvider = 'anthropic' | 'vertex' | 'openai' | 'custom';

export interface CatalogModel {
  id: string;
  tier?: string;
  label: string;
  context_window: number;
  pricing?: { input: number; output: number };
  residency: string;
  notes?: string;
}

export interface CatalogProvider {
  provider: LLMProvider;
  preset_id?: string;
  display_name: string;
  models: CatalogModel[];
  requires_base_url: boolean;
  requires_region: boolean;
  default_residency: string;
  base_url_default?: string;
  notes?: string;
}

export interface CustomEndpoint {
  id: string;
  name: string;
  base_url: string;
}

export interface LLMConfigUpdateInput {
  /** `false` = user can change provider; `true` = legacy hard-lock (operator pinned a provider via config.json). */
  providerLocked: boolean;
  /** Currently-selected provider in the UI. Null = not yet picked. */
  activeProvider: LLMProvider | null;
  /** Catalog entry matching `activeProvider` + active preset_id. Used for requires_base_url / base_url_default / requires_region. */
  activeProviderEntry: CatalogProvider | null;
  /** Local form state — fields the user can edit. */
  config: {
    api_base_url?: string;
    gcp_project_id?: string;
    gcp_region?: string;
    default_tier?: string;
    openai_model_id?: string;
    custom_endpoints?: CustomEndpoint[];
  };
}

export interface LLMConfigUpdate {
  provider?: LLMProvider;
  api_base_url?: string;
  gcp_project_id?: string;
  gcp_region?: string;
  default_tier?: string;
  openai_model_id?: string;
  custom_endpoints?: CustomEndpoint[];
}

/**
 * Build the PUT /api/config body from the current LLMSettings form state.
 *
 * Invariants:
 *  - If `providerLocked`, NO provider-bound fields stage (operator owns
 *    the value via config.json; UI must not stomp it).
 *  - Otherwise `provider` always stages.
 *  - `api_base_url` ALWAYS stages — explicit empty string when the active
 *    provider uses neither a free-text nor a pinned base_url. This prevents
 *    F1 (stale Mistral URL after switching back to Anthropic).
 *  - `openai_model_id` ALWAYS stages — explicit empty string when
 *    activeProvider ∉ {openai, custom}. Same F1 prevention rationale.
 *  - Vertex (`requires_region`) attaches gcp_project_id + gcp_region.
 *  - `custom_endpoints` only stages when provider === 'custom'.
 *
 * Anything Advanced/Memory/Context-Window related belongs to LLMAdvancedView /
 * LLMMemoryView — they own those PUTs to the same endpoint (PRD-IA-V2 P3-PR-C).
 */
export function buildLLMConfigUpdate(input: LLMConfigUpdateInput): LLMConfigUpdate {
  const update: LLMConfigUpdate = {};
  if (input.providerLocked || !input.activeProvider) return update;

  const entry = input.activeProviderEntry;
  update.provider = input.activeProvider;

  // api_base_url: free-text → user value, pinned preset → preset default,
  // anything else → empty string (clear stale value).
  if (entry?.requires_base_url && input.config.api_base_url) {
    update.api_base_url = input.config.api_base_url;
  } else if (entry?.base_url_default) {
    update.api_base_url = entry.base_url_default;
  } else {
    update.api_base_url = '';
  }

  if (entry?.requires_region) {
    if (input.config.gcp_project_id !== undefined) update.gcp_project_id = input.config.gcp_project_id;
    if (input.config.gcp_region !== undefined) update.gcp_region = input.config.gcp_region;
  }

  if (input.config.default_tier) update.default_tier = input.config.default_tier;

  // openai_model_id covers openai (Mistral / generic) + custom (Anthropic-compat).
  // Always stage so a stale value (e.g. mistral-large-2512 after switch to
  // Anthropic) can't leak through — empty string clears it.
  if ((input.activeProvider === 'openai' || input.activeProvider === 'custom') && input.config.openai_model_id) {
    update.openai_model_id = input.config.openai_model_id;
  } else {
    update.openai_model_id = '';
  }

  if (input.activeProvider === 'custom') {
    update.custom_endpoints = input.config.custom_endpoints ?? [];
  }

  return update;
}
