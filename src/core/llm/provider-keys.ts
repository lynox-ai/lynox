// Canonical provider → vault-slot map. Mirrors LLMSettings.svelte's VAULT_SLOTS.

import type { LLMProvider } from '../../types/models.js';

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
  /** Used only for the Anthropic legacy `userConfig.api_key` fallback. */
  userConfig?: { api_key?: string | undefined } | undefined;
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
  if (provider === 'anthropic' && userConfig?.api_key) return userConfig.api_key;

  return undefined;
}
