// Canonical provider → vault-slot map. Mirrors LLMSettings.svelte's VAULT_SLOTS.

import type { LLMProvider } from '../../types/models.js';
import type { TierSet } from '../../types/config.js';

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

export const PROVIDER_KEY_SLOTS: ReadonlySet<string> = new Set([
  ...Object.values(VAULT_SLOT_BY_PROVIDER).filter((s): s is string => s !== null),
  ...Object.values(SECONDARY_SLOTS).flat(),
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
   * Used only for the Anthropic legacy `userConfig.api_key` fallback. Carries
   * the tenant's BASE `provider` so the fallback can confirm `api_key` really
   * is an Anthropic key before lending it (undefined = legacy anthropic default).
   */
  userConfig?: { api_key?: string | undefined; provider?: LLMProvider | undefined } | undefined;
}

/**
 * Resolve the API key for the active LLM provider with priority
 * env > vault > config.api_key (legacy Anthropic-only fallback).
 *
 * Returns `undefined` if nothing is configured for the provider's slot.
 * Vertex returns `undefined` — its credentials are GCP OAuth, not a key.
 */
export function resolveProviderApiKey(input: ResolveProviderApiKeyInput): string | undefined {
  const { provider, secretStore, userConfig } = input;
  const slot = vaultSlotForProvider(provider);
  if (!slot) return undefined;

  // Primary slot: env > vault.
  const primaryEnv = process.env[slot];
  if (primaryEnv && primaryEnv.length > 0) return primaryEnv;
  const primaryVault = secretStore?.resolve(slot);
  if (primaryVault && primaryVault.length > 0) return primaryVault;

  // Secondary slots: official SDK env-var aliases (e.g. OPENAI_API_KEY for
  // openai-compat providers). Same env > vault order.
  const secondary = provider ? SECONDARY_SLOTS[provider] : undefined;
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
  resolveKey: (provider: LLMProvider) => string | undefined,
): TierSet {
  const out: TierSet = {};
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const slot = tierSet[tier];
    if (!slot) continue;
    if (slot.api_key || slot.provider === baseProvider) {
      out[tier] = slot;
      continue;
    }
    // Hybrid slots store a catalogued LLMProvider ('anthropic' | 'openai' for
    // the Mistral preset); the vault-slot map keys off exactly that.
    const key = resolveKey(slot.provider as LLMProvider);
    out[tier] = key ? { ...slot, api_key: key } : slot;
  }
  return out;
}
