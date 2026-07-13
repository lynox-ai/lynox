// Canonical provider → vault-slot map. Mirrors LLMSettings.svelte's VAULT_SLOTS.
//
// This map is the FALLBACK, used only when the caller cannot tell us which
// endpoint the key is destined for. The authoritative answer is per-endpoint and
// lives on the catalog entry (`vault_slot`), because several distinct vendors
// share `provider: 'openai'` — see `vaultSlotForEndpoint`.

import type { LLMProvider } from '../../types/models.js';
import type { TierSet } from '../../types/config.js';
import { LLM_CATALOG, vaultSlotForEndpoint } from './catalog.js';

export const VAULT_SLOT_BY_PROVIDER: Readonly<Record<LLMProvider, string | null>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  vertex: null,
  openai: 'MISTRAL_API_KEY',
  custom: 'CUSTOM_API_KEY',
});

/**
 * Secondary slots that resolveProviderApiKey checks after the primary
 * vault slot. Mirrors official SDK env-var conventions so a user who
 * sets the canonical env name (OPENAI_API_KEY for OpenAI SDK callers)
 * gets picked up without having to know about the Mistral alias.
 */
const SECONDARY_SLOTS: Readonly<Record<LLMProvider, ReadonlyArray<string>>> = Object.freeze({
  anthropic: [],
  vertex: [],
  openai: ['OPENAI_API_KEY'],
  custom: [],
});

/**
 * Every vault slot that holds an LLM provider credential — the provider-default
 * map, the SDK aliases, AND every per-endpoint slot declared by a catalog preset
 * (GROQ_API_KEY, …). Derived from the catalog rather than hand-listed, so adding
 * a preset with a new slot cannot silently leave that slot unrecognised by the
 * callers that gate on this set (e.g. the settings API's key-write path).
 */
export const PROVIDER_KEY_SLOTS: ReadonlySet<string> = new Set([
  ...Object.values(VAULT_SLOT_BY_PROVIDER).filter((s): s is string => s !== null),
  ...Object.values(SECONDARY_SLOTS).flat(),
  ...LLM_CATALOG
    .map((e) => e.vault_slot)
    .filter((s): s is string => typeof s === 'string'),
]);

export function vaultSlotForProvider(provider: LLMProvider | undefined | null): string | null {
  if (!provider) return null;
  return VAULT_SLOT_BY_PROVIDER[provider] ?? null;
}

interface SecretStoreReader {
  // Matches the canonical SecretStore.resolve() signature in
  // core/secret-store.ts — `string | null`, no `undefined`.
  resolve(name: string): string | null;
}

export interface ResolveProviderApiKeyInput {
  provider: LLMProvider | undefined;
  secretStore: SecretStoreReader | null | undefined;
  /**
   * The endpoint the key would actually be SENT to. Optional, but pass it
   * wherever it is in scope — it is what stops a cross-provider credential leak.
   *
   * `provider` alone is not enough to pick a vault slot: Mistral, Groq, Together,
   * Fireworks and a local Ollama all serialise to `provider: 'openai'`. Keying
   * only on the provider therefore lends whatever key sits in the openai slot to
   * whatever endpoint happens to be configured — a user with a Mistral key who
   * selects Groq would send that Mistral key, as a bearer token, to Groq.
   *
   * With this set, the slot comes from the catalog entry that pins the endpoint,
   * and a loopback runtime (which needs no credential) correctly resolves to NO
   * key rather than borrowing someone else's. Omitting it preserves the historic
   * provider-keyed behaviour for callers that genuinely have no endpoint in hand.
   */
  apiBaseURL?: string | undefined;
  /**
   * Used only for the Anthropic legacy `userConfig.api_key` fallback. Carries
   * the tenant's BASE `provider` so the fallback can confirm `api_key` really
   * is an Anthropic key before lending it (undefined = legacy anthropic default).
   */
  userConfig?: { api_key?: string | undefined; provider?: LLMProvider | undefined } | undefined;
}

/**
 * Resolve the API key for the active LLM endpoint with priority
 * env > vault > config.api_key (legacy Anthropic-only fallback).
 *
 * Returns `undefined` if nothing is configured, if the provider has no slot
 * (Vertex — GCP OAuth, not a key), or if the endpoint needs no credential at all
 * (a loopback runtime). The last case is deliberate: returning a provider-default
 * key there is exactly the leak this function guards against.
 */
export function resolveProviderApiKey(input: ResolveProviderApiKeyInput): string | undefined {
  const { provider, secretStore, userConfig, apiBaseURL } = input;

  // Endpoint-bound slot wins when we know the endpoint. `null` = this endpoint
  // takes no credential (loopback) — honour that and send nothing, rather than
  // falling through to the provider default and leaking another vendor's key.
  const byEndpoint = apiBaseURL !== undefined
    ? vaultSlotForEndpoint(provider, apiBaseURL)
    : undefined;
  if (byEndpoint === null) return undefined;

  const providerSlot = vaultSlotForProvider(provider);
  const slot = byEndpoint ?? providerSlot;
  if (!slot) return undefined;

  // Primary slot: env > vault.
  const primaryEnv = process.env[slot];
  if (primaryEnv && primaryEnv.length > 0) return primaryEnv;
  const primaryVault = secretStore?.resolve(slot);
  if (primaryVault && primaryVault.length > 0) return primaryVault;

  // Secondary slots: official SDK env-var aliases (OPENAI_API_KEY for
  // openai-compat callers). Same env > vault order.
  //
  // ONLY on the provider-default slot. An endpoint with its own slot (Groq,
  // Together, Fireworks) must never fall back to the shared openai aliases —
  // that is the same cross-vendor leak by another door: an `OPENAI_API_KEY` in
  // the environment would otherwise be bearer-tokened straight to Groq.
  const allowSecondary = slot === providerSlot;
  const secondary = allowSecondary && provider ? SECONDARY_SLOTS[provider] : undefined;
  if (secondary) {
    for (const altSlot of secondary) {
      const altEnv = process.env[altSlot];
      if (altEnv && altEnv.length > 0) return altEnv;
      const altVault = secretStore?.resolve(altSlot);
      if (altVault && altVault.length > 0) return altVault;
    }
  }

  // Legacy fallback: only Anthropic historically stored its key in
  // config.json. Honour it for back-compat but never for openai/custom —
  // those need a fresh vault entry, not a stale Anthropic value.
  //
  // Gate on the tenant's BASE provider, not just the requested `provider`:
  // `config.api_key` is a legacy field with no schema guarantee it holds an
  // Anthropic key. On a Mistral/openai/custom-base tenant it may hold THAT
  // provider's key. A keyless cross-Anthropic hybrid slot requesting the
  // anthropic key must NOT be handed that non-Anthropic value (it would be
  // sent to the Anthropic wire endpoint = cross-provider credential leak).
  // So only lend it when the base is anthropic — undefined = legacy default.
  if (
    provider === 'anthropic' &&
    (userConfig?.provider === undefined || userConfig?.provider === 'anthropic') &&
    userConfig?.api_key
  ) {
    return userConfig.api_key;
  }

  return undefined;
}

/**
 * Resolve per-slot credentials for a hybrid Tier-Set, in-memory only — the pure
 * core of the engine's config-load enrichment. The UI persists a slot as
 * `{provider, model_id, api_base_url?}` with NO api_key (keys belong in the
 * vault, never in config.json); this injects each cross-provider slot's key so
 * `clientForTierSnapshot` can authenticate it.
 *
 * Rules, per tier slot:
 *  - an explicit `api_key` (set by a power-user / managed transform) is kept;
 *  - a SAME-provider slot is left untouched so `clientForTierSnapshot` keeps
 *    reusing the ambient client + its key (byte-parity, no extra client);
 *  - a CROSS-provider slot gets `resolveKey(slot.provider)` injected — or is
 *    left key-less if nothing resolves. The UI always pairs a cross-provider
 *    slot with its provider's `api_base_url`, so a missing key surfaces a clean
 *    401 at request time (the correct place) rather than us inventing a wrong
 *    one. (A hand-edited slot naming a provider with no vault-slot mapping AND
 *    no base_url is unsupported — it would yield a malformed request, not a 401.)
 *
 * Pure + deterministic: the caller passes a `resolveKey` closure (the engine
 * binds it to `resolveProviderApiKey` over its secret store), so this is
 * table-testable without a SecretStore.
 */
export function enrichTierSetCreds(
  tierSet: TierSet,
  baseProvider: LLMProvider,
  resolveKey: (provider: LLMProvider, apiBaseURL?: string) => string | undefined,
): TierSet {
  const out: TierSet = {};
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const slot = tierSet[tier];
    if (!slot) continue;
    if (slot.api_key || slot.provider === baseProvider) {
      out[tier] = slot;
      continue;
    }
    // A hybrid slot names a catalogued provider AND (for openai-compat ones) its
    // own endpoint. Both are needed: 'openai' alone cannot distinguish Mistral
    // from Groq from a local Ollama, and resolving on the provider would inject
    // whichever key sits in the shared slot into a slot pointing elsewhere.
    const key = resolveKey(slot.provider as LLMProvider, slot.api_base_url);
    out[tier] = key ? { ...slot, api_key: key } : slot;
  }
  return out;
}
