// Canonical provider → vault-slot map. Mirrors LLMSettings.svelte's VAULT_SLOTS.
//
// This map is the FALLBACK, used only when the caller cannot tell us which
// endpoint the key is destined for. The authoritative answer is per-endpoint and
// lives on the catalog entry (`vault_slot`), because several distinct vendors
// share `provider: 'openai'` — see `vaultSlotForEndpoint`.

import type { LLMProvider } from '../../types/models.js';
import type { TierSet } from '../../types/config.js';
import { LLM_CATALOG, vaultSlotForEndpoint, pinnedVaultSlotForEndpoint } from './catalog.js';
import { isGuardedBaselineHost } from './endpoint-allowlist.js';

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
 * May a VAULT-STORED key be used as the fallback for `apiBaseURL` when the caller
 * supplied no key of its own?
 *
 * This exists for exactly one caller: the `/api/llm/test` probe, where `base_url`
 * is UNTRUSTED request input — unlike every other `resolveProviderApiKey` caller,
 * which passes the stored `userConfig.api_base_url`. `resolveProviderApiKey` falls
 * through to the generic tile's SHARED slot (the managed pool key) for any host it
 * does not recognise, so probing an arbitrary `base_url` with no typed key would
 * bearer-token the pool key straight to that host — a credential-exfil door the
 * per-endpoint key-binding work otherwise closed.
 *
 * A vault fallback is safe only for an endpoint the stored key actually belongs to:
 *   - the provider default (no `base_url` → Anthropic/Vertex tile),
 *   - a host that MATCHES A PRESET (`pinnedVaultSlotForEndpoint` — a real pin, not a
 *     generic fall-through; the fall-through is precisely the leak), or
 *   - an EXACT vetted provider host (`isGuardedBaselineHost`).
 * Anything else (a free-text or attacker-supplied host) must fall back to nothing,
 * so the probe 400s "API key required" and the caller supplies the key explicitly.
 * A body-supplied key is the caller's own credential and is never gated by this.
 *
 * Deliberately `isGuardedBaselineHost` (exact `ALLOWLISTED_HOSTS` only), NOT
 * `isAllowlistedEndpoint`: the latter also vouches for `*.openai.azure.com` — an
 * attacker-registerable namespace — plus `.local`/`.lan` wildcards. That breadth
 * is right for the BYOK sub-processor-vetting gate it was built for, but this is a
 * CREDENTIALED egress of the SHARED pool key, where a wildcard the caller can
 * register a match for is exactly the door to keep shut (purpose-scoped: the
 * vetting allowlist is not the egress baseline).
 */
export function mayFallBackToStoredKey(provider: LLMProvider, apiBaseURL: string): boolean {
  return !apiBaseURL
    || pinnedVaultSlotForEndpoint(provider, apiBaseURL) !== undefined
    || isGuardedBaselineHost(apiBaseURL);
}

/**
 * Marker recording that the one-shot legacy-key carry-forward has run. Lives in
 * the vault rather than config.json so the migration needs no schema change and
 * cannot be lost by a config rewrite.
 */
// `LYNOX_` prefix on purpose: it makes the marker an infra secret
// (INFRA_SECRET_PATTERNS in secret-store.ts), so this bookkeeping timestamp stays
// out of the agent-visible secret briefing and the non-admin settings API. Not
// sensitive in itself — just noise that does not belong in the model's context.
const SLOT_MIGRATION_MARKER = 'LYNOX_LLM_ENDPOINT_SLOT_MIGRATION';

/** Slots that held an OpenAI-compatible key before endpoints had their own. */
const LEGACY_OPENAI_SLOTS = ['MISTRAL_API_KEY', 'OPENAI_API_KEY'] as const;

interface SecretStoreReadWrite extends SecretStoreReader {
  set(name: string, value: string): void;
  /** Optional: false ⇒ a vault-less store where `set()` would throw. */
  canPersist?(): boolean;
}

/**
 * One-shot carry-forward of a key that predates per-endpoint slots.
 *
 * Before presets existed, EVERY OpenAI-compatible endpoint shared the
 * `MISTRAL_API_KEY` slot. A user who pointed the generic tile at their own vLLM
 * on `:8000`, or at Groq, therefore stored THAT vendor's key there. Now that such
 * an endpoint has a slot of its own, the key would simply not be found — and for
 * a loopback endpoint that failure is SILENT, because those do not require a key:
 * readiness stays green and every request 401s with nothing to explain why.
 *
 * On the first boot after the upgrade, `api_base_url` still describes where the
 * user already WAS — they cannot have clicked a preset tile that did not exist
 * yet. Copying the legacy key into that endpoint's own slot is therefore
 * byte-identical to what was already going over the wire, and adds no new
 * recipient.
 *
 * The marker is what makes this safe, and it is not optional: a LATER switch from
 * Mistral to Ollama must NOT carry the Mistral key across. That is precisely the
 * leak this whole change exists to close, and at resolve time the two situations
 * are indistinguishable — same endpoint, same empty slot, same legacy key. Only
 * "was this the first boot after the upgrade?" separates them, so it has to be
 * recorded rather than inferred.
 *
 * Returns the slot written, or null when nothing needed doing.
 */
export function migrateLegacyEndpointKey(input: {
  provider: LLMProvider | undefined;
  apiBaseURL: string | undefined;
  secretStore: SecretStoreReadWrite | null | undefined;
}): string | null {
  const { provider, apiBaseURL, secretStore } = input;
  if (!secretStore) return null;

  // A vault-less store cannot persist anything — and it has nothing to migrate,
  // because the legacy keys it would carry forward live in that same vault. Bail
  // BEFORE any `set()`, or the throw ("Cannot set secrets without a vault")
  // propagates out of engine-init's secret try/catch and nulls the ENTIRE secret
  // store on an otherwise-fine vault-less boot (read-only `~/.lynox`, k8s
  // readOnlyRootFilesystem, a lost LYNOX_VAULT_KEY beside an existing vault.db).
  if (secretStore.canPersist && !secretStore.canPersist()) return null;

  // Already run once — never again, or the leak walks back in through the door
  // this migration opened.
  if (secretStore.resolve(SLOT_MIGRATION_MARKER)) return null;

  // Stamp the marker BEFORE looking at the config, and unconditionally. "The
  // first boot after the upgrade" is a property of the INSTALL, not of what
  // happens to be configured on it.
  //
  // Returning early on a missing `api_base_url` and stamping afterwards would
  // leave an Anthropic-only user unmarked forever — and then, the first time they
  // switched to Ollama, this migration would fire and carry their old Mistral key
  // into the Ollama slot. That is precisely the leak the marker exists to prevent.
  secretStore.set(SLOT_MIGRATION_MARKER, new Date().toISOString());

  // Only the OpenAI-wire family ever shared MISTRAL_API_KEY. `custom`
  // (Anthropic-wire proxy) stores its key in CUSTOM_API_KEY, `anthropic` in
  // ANTHROPIC_API_KEY — neither has anything to carry forward from the shared
  // openai slot, and touching them would only risk moving the wrong key.
  if (!provider || provider !== 'openai' || !apiBaseURL) return null;

  const slot = vaultSlotForEndpoint(provider, apiBaseURL);
  // Only endpoints that gained a slot of their own are affected. `null` (no
  // credential concept), the legacy slot itself, or an unrecognised host all mean
  // nothing moved.
  if (!slot || (LEGACY_OPENAI_SLOTS as readonly string[]).includes(slot)) return null;
  if (secretStore.resolve(slot)) return null;   // already has its own key

  for (const legacy of LEGACY_OPENAI_SLOTS) {
    // `??` would be wrong here: an env var set to the empty string is neither
    // null nor undefined, so it would shadow a perfectly good vault entry and the
    // carry-forward would silently do nothing.
    const fromEnv = process.env[legacy];
    const value = (fromEnv && fromEnv.length > 0) ? fromEnv : secretStore.resolve(legacy);
    if (value && value.length > 0) {
      secretStore.set(slot, value);
      return slot;
    }
  }
  return null;
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
 *  - a CROSS-provider slot gets `resolveKey(slot.provider, slot.api_base_url)` injected — or is
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
