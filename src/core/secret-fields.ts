import type { LynoxUserConfig } from '../types/config.js';

/**
 * Canonical enumeration of the config fields that carry a SECRET (an API key,
 * OAuth secret, or telemetry DSN) and must never leak to a lower-trust context
 * — a 3rd-party plugin, a `GET /api/config` response, or the GDPR export.
 *
 * Enumerating them in ONE place — reused by the redaction, the plugin-ctx
 * strip, and the export — is the structural fix for the "each consumer
 * hand-lists a subset that drifts from the real config secret surface" root
 * cause: a new secret field is registered here once, and `secret-fields.test.ts`
 * fails closed if a field with a recognised secret suffix (`_key` / `_secret` /
 * `_dsn` / `_token` / `password`) is added to the config type without being
 * covered here. (A secret hidden in an unconventionally-named field — e.g. a
 * token in a `*_id` — still needs a manual add; the tripwire is a heuristic.)
 *
 * NOTE: `api_base_url` is NOT a secret (it's the user's own endpoint, which they
 * legitimately see in Settings). It is stripped from the plugin ctx as
 * defense-in-depth (a bookmark URL could embed inline credentials), but left
 * visible in `GET /api/config` / export.
 */

/** Top-level secret keys on {@link LynoxUserConfig}. */
export const SECRET_CONFIG_KEYS = [
  'api_key',
  'search_api_key',
  'google_client_id',
  'google_client_secret',
  'bugsink_dsn',
] as const;

/**
 * Record-valued config fields whose every entry carries a per-slot `api_key`
 * (and optional `api_base_url`) — the nested secret surface the top-level key
 * list structurally cannot reach.
 */
export const SECRET_NESTED_COLLECTIONS = ['tier_set', 'model_profiles'] as const;

/**
 * Scrub the per-slot `api_key` (and, when `stripBaseUrls`, `api_base_url`) out
 * of every nested secret collection, cloning the collection + each touched slot
 * so the caller's object is never mutated in place.
 */
function scrubNestedSecrets(obj: Record<string, unknown>, opts: { stripBaseUrls?: boolean } = {}): void {
  for (const coll of SECRET_NESTED_COLLECTIONS) {
    const value = obj[coll];
    if (!value || typeof value !== 'object') continue;
    const cloned: Record<string, unknown> = {};
    for (const [slotKey, slot] of Object.entries(value as Record<string, unknown>)) {
      if (slot && typeof slot === 'object') {
        const clonedSlot: Record<string, unknown> = { ...(slot as Record<string, unknown>) };
        delete clonedSlot['api_key'];
        if (opts.stripBaseUrls) delete clonedSlot['api_base_url'];
        cloned[slotKey] = clonedSlot;
      } else {
        cloned[slotKey] = slot;
      }
    }
    obj[coll] = cloned;
  }
}

/**
 * Redact a config for a `GET /api/config` response or the GDPR export: remove
 * every top-level secret (leaving a `${key}_configured: true` marker so the UI
 * still knows a value is set) and scrub nested per-slot api keys. Returns a NEW
 * object; the input is never mutated. Non-secret fields (incl. `api_base_url`)
 * are preserved so the user sees their own configuration.
 */
export function redactConfigForResponse(config: LynoxUserConfig): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of SECRET_CONFIG_KEYS) {
    if (key in redacted && redacted[key]) {
      delete redacted[key];
      redacted[`${key}_configured`] = true;
    }
  }
  scrubNestedSecrets(redacted);
  return redacted;
}

/**
 * Deep-clone `config` with every secret removed for handing to a 3rd-party
 * plugin: all top-level secret keys, the nested per-slot api keys, AND the
 * endpoint URLs (`api_base_url` top + nested) — a plugin has no need for either.
 * Returns a NEW object; the input is never mutated.
 */
export function stripSecretsForPlugin(config: LynoxUserConfig): LynoxUserConfig {
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of SECRET_CONFIG_KEYS) delete out[key];
  delete out['api_base_url'];
  scrubNestedSecrets(out, { stripBaseUrls: true });
  return out as LynoxUserConfig;
}
