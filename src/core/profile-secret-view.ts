/**
 * The vault as the engine reads it for one API profile (PRD customer-granted-operator-access
 * §3.13).
 *
 * The engine resolves a profile's credentials itself: the attach on every `http_request` to
 * its host, the token renewal, `api_setup fetch_token`. The names come from the profile, so
 * whoever wrote the profile chose them. For a profile a mandate wrote, that choice is not
 * enough: a value the engine took from its environment, a name another author's profile reads,
 * and the tokens of a connection somebody else consented to are not the mandate's to send
 * anywhere. This view hides them from those reads. It applies to the profile, not to the turn,
 * because the owner's own runs reach a mandate's profile as well.
 *
 * A profile without a mandate author gets the store itself, unchanged.
 */
import type { SecretStoreLike } from '../types/index.js';
import { accessTokenKey, collectVaultKeys, grantTokenNames, hasTokenSlotShape, isMandateAuthored, isMandateConnection, refreshTokenKey } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import { isProtectedSecretWrite } from './secret-store.js';
import { VAULT_SCOPE_ALL, vaultScopeOf } from './secret-scope.js';
import type { ApiProfile, ApiStore } from './api-store.js';

/**
 * Whether the mandate `tag` may have the value under `name` — through its own profile `via`,
 * or, without one, through a `secret:` reference in its turn. Read at each call, not once: the
 * owner can connect an account or name a secret after the mandate's profile already names it.
 *
 * No, for:
 * - a value from the environment (a store that cannot say counts as one);
 * - a name a profile of another author reads: that profile's author holds it;
 * - a name a provider preset profile reads, other than `via`: a preset connection's
 *   credentials go to its provider through that profile, and a second profile, or a bare
 *   reference, would send them elsewhere — the mandate's own preset profiles included;
 * - a token of a profile of this mandate that somebody else connected;
 * - a name shaped like a profile's token slot that no profile of this mandate connected: the
 *   profile it belonged to may be gone, and a name alone says nothing about whose it was.
 *
 * `writing`: the question is whether `via`'s own exchange may store its token under `name`.
 * The one difference is a token slot of `via` that no consent is recorded for yet: the first
 * exchange is what records this mandate's, so it may write there. Every other rule stands, so
 * a slot somebody else's consent filled, or another profile names, stays closed.
 */
export function mandateMayRead(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'getAll'>,
  tag: string,
  name: string,
  via?: ApiProfile | undefined,
  writing = false,
): boolean {
  if (store.isEnvironmentSecret?.(name) ?? true) return false;
  let ownToken = false;
  for (const p of apiStore.getAll()) {
    if (p.created_by !== tag) {
      if (collectVaultKeys(p).includes(name)) return false;
      continue;
    }
    if (p.auth?.oauth?.preset_id !== undefined && p.id !== via?.id && collectVaultKeys(p).includes(name)) return false;
    if (grantTokenNames(p).has(name)) {
      const by = p.oauth_grant?.connected_by;
      const firstConsent = writing && by === undefined && p.id === via?.id;
      if (by !== tag && !firstConsent) return false;
      ownToken = true;
    }
  }
  return ownToken || !hasTokenSlotShape(name);
}

/** The names a profile reads as a credential: everything but the client id, which is public. */
function credentialNames(p: ApiProfile): Set<string> {
  const names = new Set(grantTokenNames(p));
  const auth = p.auth;
  for (const k of [auth?.username_key, auth?.password_key, auth?.oauth?.client_secret_key, auth?.oauth?.refresh_token_key]) {
    if (k) names.add(k);
  }
  // An OAuth profile lists its client id among `vault_keys` too; its secret is named above.
  if (auth?.type !== 'oauth2') for (const k of collectVaultKeys(p)) names.add(k);
  return names;
}

/**
 * Whether the value under `name` may be put into a sign-in link as a client id. The link goes to
 * the browser of whoever opens it, and from there to the provider: a name any profile reads as a
 * credential, or a key the engine guards, would put a secret there.
 */
export function mayServeAsClientId(apiStore: Pick<ApiStore, 'getAll'>, name: string): boolean {
  if (isProtectedSecretWrite(name)) return false;
  return !apiStore.getAll().some((p) => credentialNames(p).has(name));
}

/**
 * Whether a connection the mandate `tag` starts on `profile` may store its tokens: both slots
 * an exchange writes, asked as a write. A slot another author's profile reads would otherwise
 * be overwritten with this mandate's token, and that profile would send it.
 */
export function mandateMayConnect(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'getAll'>,
  tag: string,
  profile: ApiProfile,
): boolean {
  return [accessTokenKey(profile.id), refreshTokenKey(profile.id)]
    .every((name) => mandateMayRead(store, apiStore, tag, name, profile, true));
}

/**
 * The token slots an oauth2 profile `id` would write — the derived access and refresh pair —
 * that already hold a value, or `null` when `store` cannot say. Asked when a mandate sets up an
 * oauth2 profile under an id: the id is its choice, so the pair it derives can be a name the
 * owner stored a value under, and the first exchange would write over it.
 *
 * Read from the store itself, never through a profile's view: the view hides a slot no consent
 * is recorded for yet, which would read as empty. A scoped store lists only its scope, so it
 * cannot tell either, and answers `null`.
 *
 * Asked at setup rather than at the exchange: the callback writes the tokens before it saves
 * the profile, and a retry under the same id is how a failed save heals.
 */
export function occupiedTokenSlots(store: SecretStoreLike, id: string): string[] | null {
  if (vaultScopeOf(store) !== VAULT_SCOPE_ALL) return null;
  const held = new Set(store.listNames());
  return [accessTokenKey(id), refreshTokenKey(id)].filter((name) => held.has(name));
}

/**
 * Whether a token may be handed out at all (PRD §3.13 B9): no, while it belongs to a connection
 * a mandate consented to and that mandate is not live — ended, revoked, or never seen by this
 * engine. Asked by the store on every `resolve`, whoever calls it: the owner's turn, a run the
 * mandate stamped, the bulk path. Keyed by the vault name, because a `secret:` reference reaches
 * a token without going through its profile. Without a record of mandate ends (no engine.db)
 * no mandate counts as live. What lifts it is the owner's consent: connecting the account again,
 * or adopting the connection (`api_setup` action `adopt_connection`, which asks the person).
 * Saving over the profile alone keeps the mandate's grant.
 */
export function connectionTokenAllowed(
  apiStore: Pick<ApiStore, 'getAll'> | null,
  ends: Pick<MandateEnds, 'isLive'> | null,
  name: string,
): boolean {
  if (apiStore === null) return true;
  return !apiStore.getAll().some((p) => connectionWaits(p, ends) && grantTokenNames(p).has(name));
}

/**
 * Whether `profile` holds a connection whose tokens {@link connectionTokenAllowed} refuses: a
 * mandate consented to it, and that mandate is not live. Such a connection waits for the owner,
 * who can adopt it or connect again; until then it is of no use to anyone.
 */
export function connectionWaits(profile: ApiProfile, ends: Pick<MandateEnds, 'isLive'> | null): boolean {
  if (!isMandateConnection(profile)) return false;
  const mandateId = profile.oauth_grant?.connected_mandate_id;
  return mandateId === undefined || ends === null || !ends.isLive(mandateId);
}

/** Whether the view below hides `name` from `profile`: always false for a profile the owner wrote. */
export function hiddenFromProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'getAll'>,
  name: string,
  writing = false,
): boolean {
  if (!isMandateAuthored(profile)) return false;
  return !mandateMayRead(store, apiStore, profile.created_by!, name, profile, writing);
}

export function secretsForProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'getAll'>,
): SecretStoreLike {
  if (!isMandateAuthored(profile)) return store;
  const hidden = (name: string): boolean => hiddenFromProfile(store, profile, apiStore, name);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'resolve') {
        return (name: string): string | null => (hidden(name) ? null : target.resolve(name));
      }
      if (prop === 'resolveSecretRefs') {
        // Nothing is resolved when any name is hidden: the callers probe one name at a time,
        // and a partly resolved input is not one any of them expects.
        return (input: unknown): unknown =>
          target.extractSecretNames(input).some(hidden) ? input : target.resolveSecretRefs(input);
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
