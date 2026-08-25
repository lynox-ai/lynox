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
 * the mixed pair reaches Google. The mixing needs BOTH an env pair and a vault
 * pair, and both are reachable TODAY: a deployment can supply the pair in the
 * environment, and a customer can write the vault pair through Settings since
 * core#1272. Any deployment that hands a tenant the env pair while that tenant
 * also holds a vault pair reaches this — which is why the function exists,
 * rather than a note claiming it cannot happen yet.
 *
 * ## The rules, and why each is written the way it is
 *
 * - **The vault is read DIRECTLY, not through `SecretStore`.** The store cannot
 *   answer "does the vault have this?" once an environment value occupies the
 *   slot — the vault value is not out-ranked there, it is absent.
 * - **A source must supply BOTH halves or it is skipped.** Never mixed.
 * - **Empty strings do not count**, and the reason is not the one it looks like.
 *   The old readers never handed `''` to Google either — the `if (id && secret)`
 *   guard below them rejected it. What `??` did was let `''` SHADOW the tiers behind
 *   it: any deployment that interpolates an unset variable into the environment
 *   (`NAME=${NAME:-}`) hands the process an empty string rather than nothing, and
 *   that empty string outranked a perfectly good `config.json`, so Google was
 *   silently not built at all. Skipping it is the fix.
 * - **`userConfig` is last, and it is now a REAL source rather than a mirror.**
 *   It used to be neither: `config.ts` copied the environment pair into it and
 *   `engine-init.ts` copied the vault secret into it, so an env-id and a vault-secret
 *   re-assembled there as a mixed pair one tier down — reported as `'config'`, a
 *   source that had never held a pair. Both copies are gone, and the config→vault
 *   migration now carries the id as well as the secret, so this tier holds only what
 *   the operator literally wrote in `config.json`. Naming the hazard in a comment and
 *   keeping the tier anyway, as the first version of this file did, is not a fix.
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

/**
 * The two member names, BRANDED so they cannot be exchanged for one another.
 *
 * The previous signature took `(idName: string, secretName: string)`. Two
 * arguments of the same type are swappable, and a swapped call ships the client
 * SECRET as the client id — the mixed pair this whole module exists to prevent,
 * assembled by the caller instead of by the precedence chain. A contract test
 * could only ever DETECT that at sites it knew about; this makes it
 * unrepresentable instead.
 *
 * The brands deliberately do NOT live in `src/contract/`: the registry already
 * declares the same pair as data, and a contract change obliges every vendored
 * copy to re-sync. The drift test in `tests/contract-env.test.ts` welds this
 * constant to that declaration, so the two cannot diverge without a red test.
 *
 * What the brands do and do not buy, stated exactly, because the difference is
 * the whole point: a descriptor cannot be built ACCIDENTALLY — not from loose
 * strings, not by swapping two members, not by pairing one provider's id with
 * another's secret. A deliberate `as ClientPairNames` still mints one anywhere,
 * and no type can stop that. The claim is "unrepresentable by accident", never
 * "unforgeable".
 */
declare const CLIENT_ID_BRAND: unique symbol;
declare const CLIENT_SECRET_BRAND: unique symbol;
declare const CLIENT_PAIR_BRAND: unique symbol;
export type ClientIdName = string & { readonly [CLIENT_ID_BRAND]: true };
export type ClientSecretName = string & { readonly [CLIENT_SECRET_BRAND]: true };

/**
 * A credential pair's member names, in the only order they may be read.
 *
 * The brand on the PAIR is separate from the brands on its members, and it
 * carries the half the member brands cannot. The member brands make `id` and
 * `secret` non-interchangeable — that is the swap. They say nothing about
 * whether the two halves belong to the SAME credential: once a second provider
 * exists, `{ id: googlePair.id, secret: msPair.secret }` has a correctly
 * branded member in each slot and satisfies a member-branded interface. That is
 * the "foreign partner" mix core#1269 was built against, re-assembled by the
 * caller. Branding the pair itself makes the re-assembly unrepresentable:
 * a fresh object literal cannot carry the brand, so the only descriptors that
 * exist are the ones minted whole.
 */
export interface ClientPairNames {
  readonly id: ClientIdName;
  readonly secret: ClientSecretName;
  readonly [CLIENT_PAIR_BRAND]: true;
}

/**
 * The Google OAuth app credential pair.
 *
 * The `as` is the mint. It is deliberate and it is the only kind of statement
 * that can produce a `ClientPairNames`; a second provider's pair is added the
 * same way, next to this one.
 */
export const GOOGLE_CLIENT_PAIR = {
  id: 'GOOGLE_CLIENT_ID' as ClientIdName,
  secret: 'GOOGLE_CLIENT_SECRET' as ClientSecretName,
} as ClientPairNames;

/** Non-empty after trimming. An all-whitespace secret is a misconfiguration, not a credential. */
function usable(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function resolveClientPair(
  pair: ClientPairNames,
  sources: ClientPairSources,
): ResolvedClientPair | null {
  const idName: string = pair.id;
  const secretName: string = pair.secret;
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
