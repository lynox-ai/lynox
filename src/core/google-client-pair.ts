/**
 * Resolve the Google OAuth client pair as a PAIR, from one source.
 *
 * ## Why this exists
 *
 * The two readers this replaces resolved each half independently:
 *
 * ```ts
 * const id     = secretStore?.resolve('GOOGLE_CLIENT_ID')     ?? env[...] ?? userConfig[...];
 * const secret = secretStore?.resolve('GOOGLE_CLIENT_SECRET') ?? env[...] ?? userConfig[...];
 * ```
 *
 * Independently is the defect. `SecretStore._loadFromEnv` preloads
 * `GOOGLE_CLIENT_SECRET` from the environment and does NOT mark it consented,
 * `_loadFromVault` skips any name already present, and `resolve()` returns null
 * without consent. `GOOGLE_CLIENT_ID` is not in that preload list at all. So on
 * an instance that has both an environment pair and a vault pair:
 *
 * - `GOOGLE_CLIENT_ID` resolves from the **vault** (auto-consented on load), and
 * - `GOOGLE_CLIENT_SECRET` resolves from the **environment** (the vault value was
 *   never loaded, the env value is not consented, so it arrives via the `??` tail).
 *
 * The two halves of one credential therefore take **opposite** precedence, and
 * the mixed pair reaches Google. That is not a hypothetical: the control plane
 * emits an environment pair to every managed tenant, and a customer running
 * their own Google Cloud project has a vault pair.
 *
 * ## The rules, and why each is written the way it is
 *
 * - **The vault is read DIRECTLY, not through `SecretStore`.** The store cannot
 *   answer "does the vault have this?" once an environment value occupies the
 *   slot — the vault value is not out-ranked there, it is absent.
 * - **A source must supply BOTH halves or it is skipped.** Never mixed.
 * - **Empty strings do not count.** `??` only catches null/undefined, and the
 *   self-host compose file sets `GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}` — an
 *   empty string that a coalesce would happily pass on.
 * - **`userConfig` is last and is not an independent source.** `config.ts` copies
 *   the environment pair into it and `engine-init.ts` copies the vault secret
 *   into it, so an env-id + vault-secret combination re-appears there as a mixed
 *   pair one tier down. It is kept for self-host configs that predate the vault,
 *   and it is only consulted when neither of the real sources supplied a pair.
 */

/** Where a resolved pair came from. `'env'` on a provisioned instance is the managed broker. */
export type ClientPairSource = 'vault' | 'env' | 'config';

export interface ResolvedClientPair {
  clientId: string;
  clientSecret: string;
  source: ClientPairSource;
}

/** The vault surface this needs — narrowed so tests need not build a real vault. */
export interface ClientPairVault {
  get(name: string): string | null;
}

export interface ClientPairSources {
  vault?: ClientPairVault | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  userConfig?: { google_client_id?: string | undefined; google_client_secret?: string | undefined } | undefined;
}

/** Non-empty after trimming. An all-whitespace secret is a misconfiguration, not a credential. */
function usable(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function resolveClientPair(
  idName: string,
  secretName: string,
  sources: ClientPairSources,
): ResolvedClientPair | null {
  const { vault, env = process.env, userConfig } = sources;

  const vaultId = vault?.get(idName);
  const vaultSecret = vault?.get(secretName);
  if (usable(vaultId) && usable(vaultSecret)) {
    return { clientId: vaultId, clientSecret: vaultSecret, source: 'vault' };
  }

  const envId = env[idName];
  const envSecret = env[secretName];
  if (usable(envId) && usable(envSecret)) {
    return { clientId: envId, clientSecret: envSecret, source: 'env' };
  }

  const cfgId = userConfig?.google_client_id;
  const cfgSecret = userConfig?.google_client_secret;
  if (usable(cfgId) && usable(cfgSecret)) {
    return { clientId: cfgId, clientSecret: cfgSecret, source: 'config' };
  }

  return null;
}

/**
 * True when the pair came from the environment on a control-plane-provisioned
 * instance — i.e. it is lynox's shared broker client rather than the tenant's own.
 * The UI routes on this: a broker connection offers one button, a BYO one offers
 * the scope toggle.
 */
export function isManagedBrokerPair(
  source: ClientPairSource | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return source === 'env' && (env['LYNOX_MANAGED_INSTANCE_ID'] ?? '').length > 0;
}
