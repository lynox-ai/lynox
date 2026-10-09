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
 * Past those, a name such a profile reads is the owner's (a mandate stores no value), and it
 * reads it only once the owner released it to exactly this profile, for the grant that asked and
 * for where the value goes then (`secret-releases.ts`, {@link releaseBinding}).
 *
 * A profile without a mandate author gets the store itself, unchanged.
 */
import type { SecretStoreLike } from '../types/index.js';
import { accessTokenKey, collectVaultKeys, grantTokenNames, hasTokenSlotShape, isMandateAuthored, isMandateConnection, refreshTokenKey } from './api-store.js';
import type { ApiAuth, ApiProfile, ApiStore } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import { derivePresetEndpoints, OAUTH_PRESETS } from './oauth-presets.js';
import type { RequestPrincipal } from './request-principal.js';
import type { SecretReleases } from './secret-releases.js';
import { shapedForLog, VAULT_NAME_SHAPE } from './profile-value-shape.js';
import { isProtectedSecretWrite } from './secret-store.js';
import { VAULT_SCOPE_ALL, vaultScopeOf } from './secret-scope.js';

/**
 * Who reads, and what a release is checked against. Required at every read decision: without
 * it no release applies.
 */
export interface ReadCtx {
  /** The principal of the run that reads: a mandate's turn reads only its own grant's releases. */
  readonly principal: RequestPrincipal;
  /** When each mandate ends; null means none is live. */
  readonly ends: Pick<MandateEnds, 'isLive'> | null;
  /** The owner's releases; null means there are none. */
  readonly releases: Pick<SecretReleases, 'releaseOf'> | null;
}

/**
 * Every host a profile sends a credential to: its `base_url`, and the token endpoint, where the
 * refresh token and the client secret go — for a preset this engine knows, the endpoint derived
 * from the profile's `preset_params`; otherwise its `token_url`. The attach picks a profile by
 * hostname (`getByHostname`), so the hostname is what decides where a value goes. In order, base
 * first; a `base_url` that does not parse names nothing.
 */
export function credentialHosts(profile: ApiProfile): string[] {
  const hosts = new Set<string>();
  for (const u of credentialUrls(profile)) if (u !== undefined) hosts.add(u.hostname.toLowerCase());
  return [...hosts];
}

/**
 * Where exactly a released value goes, as {@link releaseBinding} records it: the origin of
 * `base_url` — scheme, host and port; a path on the same origin is not another destination,
 * since the attach picks the profile by hostname whatever the path — and the whole token
 * endpoint, which the client pair is posted to. A move to plain http or to another port ends a
 * release as a move to another host does.
 */
export function credentialEndpoints(profile: ApiProfile): string[] {
  const [base, token] = credentialUrls(profile);
  return [...new Set([base && destinationOf(base), token?.href].filter((e): e is string => e !== undefined))];
}

/**
 * Scheme, host and port of `u` — its origin, spelled out because `URL.origin` is the string
 * `"null"` for a scheme the URL standard does not know, which would make every such base alike.
 */
function destinationOf(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

/**
 * Whether a request to `url` goes where the profile's `base_url` says: same scheme, host and
 * port. The attach picks a profile by hostname alone, so a request to another port of the host
 * reaches the same profile (plain http it refuses for any stored credential); a release, given
 * for the base the owner was shown, does not travel with it.
 */
export function requestMatchesBase(profile: ApiProfile, url: string): boolean {
  const [base] = credentialUrls(profile);
  if (base === undefined) return false;
  try { return destinationOf(new URL(url)) === destinationOf(base); } catch { return false; }
}

/** The parsed `base_url` and token endpoint, `undefined` for one missing or not a URL. */
function credentialUrls(profile: ApiProfile): [URL | undefined, URL | undefined] {
  const oauth = profile.auth?.type === 'oauth2' ? profile.auth.oauth : undefined;
  const preset = oauth?.preset_id ? OAUTH_PRESETS.get(oauth.preset_id) : undefined;
  let tokenUrl: string | undefined;
  if (preset) {
    const derived = derivePresetEndpoints(preset.id, oauth?.preset_params);
    if (!('kind' in derived)) tokenUrl = derived.tokenUrl;
  } else if (oauth?.token_url) {
    tokenUrl = oauth.token_url;
  }
  const parse = (u: string | undefined): URL | undefined => {
    if (u === undefined) return undefined;
    try { return new URL(u); } catch { return undefined; /* not a URL: nothing to name */ }
  };
  return [parse(profile.base_url), parse(tokenUrl)];
}

/**
 * How each field of a profile bears on a released value, so that a field added later cannot be
 * left out without a decision (the `satisfies` below fails to compile until it is placed):
 * - `host` — it decides where the value goes; it enters through {@link credentialEndpoints}.
 * - `role` — it names which vault name fills which slot; it enters through {@link sendRole}.
 * - `bound` — it changes how the value is sent or what the token it mints may do.
 * - `nested` — an object whose own fields are placed in the next table.
 * - `inert` — it changes neither. A field the engine rewrites by itself belongs here, or every
 *   renewal would lapse the owner's release: `grant_type`, `token_expires_at`, `oauth_grant`,
 *   and `custom_endpoint_ack`, which every save stamps anew.
 */
type FieldBearing = 'host' | 'role' | 'bound' | 'nested' | 'inert';
type OAuthBlock = NonNullable<ApiAuth['oauth']>;

const PROFILE_FIELDS = {
  id: 'inert', // a release is keyed by it
  name: 'inert',
  base_url: 'host',
  created_by: 'inert', // a release is keyed by it
  auth: 'nested',
  rate_limit: 'inert',
  description: 'inert',
  endpoints: 'inert',
  guidelines: 'inert',
  avoid: 'inert',
  notes: 'inert',
  response_shape: 'inert',
  concurrency: 'inert',
  output_volume: 'inert',
  cost: 'inert',
  provenance: 'inert',
  custom_endpoint_ack: 'inert',
  oauth_grant: 'inert',
} as const satisfies Record<keyof ApiProfile, FieldBearing>;

const AUTH_FIELDS = {
  type: 'bound',
  oauth: 'nested',
  basic_format: 'bound',
  username_key: 'role',
  password_key: 'role',
  header_name: 'bound',
  query_param: 'bound',
  instructions: 'inert',
  vault_keys: 'role',
} as const satisfies Record<keyof ApiAuth, FieldBearing>;

const OAUTH_FIELDS = {
  token_url: 'host',
  grant_type: 'inert',
  client_id_key: 'role',
  client_secret_key: 'role',
  refresh_token_key: 'role',
  scope: 'bound',
  audience: 'bound',
  preset_id: 'bound',
  preset_params: 'bound',
  body_format: 'bound',
  token_expires_at: 'inert',
} as const satisfies Record<keyof OAuthBlock, FieldBearing>;

function boundOf<T extends object>(table: Readonly<Record<string, FieldBearing>>, value: T | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, bearing] of Object.entries(table)) {
    if (bearing === 'bound') out[key] = (value as Record<string, unknown> | undefined)?.[key] ?? null;
  }
  return out;
}

/**
 * The slot in which the engine itself sends `name` for `profile`, or null when it sends it in
 * none. Only a shape the engine attaches has one: the client pair of an OAuth profile, the two
 * halves of a split Basic credential, and the first key of a bearer or header profile. A `query`
 * or pre-encoded Basic profile has the model put a `secret:` reference into the request itself,
 * and a mandate's turn resolves none (`agent.ts`), so a release could not reach it.
 */
export function sendRole(profile: ApiProfile, name: string): string | null {
  const auth = profile.auth;
  const roles: string[] = [];
  if (auth?.type === 'oauth2') {
    if (auth.oauth?.client_id_key === name) roles.push('oauth.client_id_key');
    if (auth.oauth?.client_secret_key === name) roles.push('oauth.client_secret_key');
  } else if (auth?.type === 'basic' && auth.basic_format === 'user_pass_split') {
    if ((auth.username_key ?? auth.vault_keys?.[0]) === name) roles.push('basic.username');
    if ((auth.password_key ?? auth.vault_keys?.[1]) === name) roles.push('basic.password');
  } else if (auth?.type === 'bearer' || auth?.type === 'header') {
    if (auth.vault_keys?.[0] === name) roles.push('vault_keys[0]');
  }
  return roles.length > 0 ? roles.join('+') : null;
}

/**
 * What a release of `name` to `profile` is given for: where the value goes, the slot it
 * fills, and every `bound` field. The owner is shown this, it is stored with the release, and a
 * read compares it with the profile as it is then — any difference and the release no longer
 * applies. Null when the engine does not send `name` for this profile at all.
 */
export function releaseBinding(profile: ApiProfile, name: string): string | null {
  const role = sendRole(profile, name);
  if (role === null) return null;
  return JSON.stringify({
    endpoints: [...credentialEndpoints(profile)].sort(),
    role,
    profile: boundOf(PROFILE_FIELDS, profile),
    auth: boundOf(AUTH_FIELDS, profile.auth),
    oauth: boundOf(OAUTH_FIELDS, profile.auth?.oauth),
  });
}

/** Why `name` cannot be released to `profile`, or null when it can. */
export type ReleaseObstacle = 'environment' | 'protected' | 'token' | 'not-sent' | 'preset' | 'other-mandate';

function isPresetProfile(p: ApiProfile): boolean {
  return p.auth?.oauth?.preset_id !== undefined;
}

/**
 * Whether the owner may release `name` to the mandate's profile `via` at all. Checked when the
 * request is made, when the owner answers, and again at every read: a profile saved later can
 * make a released name one that may not be released any more.
 * - `environment` — the value is the engine's, not the owner's (on a managed instance, the
 *   platform's); a store that cannot say counts as one.
 * - `protected` — a provider key or infrastructure secret.
 * - `token` — a token slot: a connection's tokens are read only by the profile that holds the
 *   grant, through its own consent.
 * - `not-sent` — the engine does not send it for `via` ({@link sendRole}).
 * - `preset` — a preset profile other than `via` reads it: a preset connection's credentials go
 *   to its provider through that profile, the owner's own preset profiles included.
 * - `other-mandate` — a profile another mandate wrote reads it.
 */
export function releaseObstacle(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'getAll'>,
  via: ApiProfile,
  name: string,
): ReleaseObstacle | null {
  if (store.isEnvironmentSecret?.(name) ?? true) return 'environment';
  if (isProtectedSecretWrite(name)) return 'protected';
  if (hasTokenSlotShape(name)) return 'token';
  if (sendRole(via, name) === null) return 'not-sent';
  for (const p of apiStore.getAll()) {
    if (grantTokenNames(p).has(name)) return 'token';
    if (p.id === via.id || !collectVaultKeys(p).includes(name)) continue;
    if (isPresetProfile(p)) return 'preset';
    if (isMandateAuthored(p) && p.created_by !== via.created_by) return 'other-mandate';
  }
  return null;
}

/**
 * Where a release of `name` to the mandate's profile `via` stands for the reader `ctx`:
 * - `released` — the owner released it for this profile, author and grant, the binding is the
 *   one the owner was shown, the grant is live, and a mandate's turn reading it is that grant's.
 * - `lapsed` — a release exists, and one of those no longer holds.
 * - `not-released` — no release, and one may be given.
 * - `not-releasable` — {@link releaseObstacle} names a reason.
 */
export type ReleaseState = 'released' | 'lapsed' | 'not-released' | 'not-releasable';

export function releaseState(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'getAll'>,
  via: ApiProfile,
  name: string,
  ctx: ReadCtx,
): ReleaseState {
  if (!isMandateAuthored(via) || releaseObstacle(store, apiStore, via, name) !== null) return 'not-releasable';
  const given = ctx.releases?.releaseOf(via.id, via.created_by!, name);
  if (given === undefined) return 'not-released';
  if (given.binding !== releaseBinding(via, name)) return 'lapsed';
  if (ctx.ends === null || !ctx.ends.isLive(given.mandateId)) return 'lapsed';
  if (ctx.principal.kind === 'mandate' && ctx.principal.mandateId !== given.mandateId) return 'lapsed';
  return 'released';
}

/**
 * Whether the mandate `tag` may have the value under `name` through its own profile `via`. Read
 * at each call, not once: the owner can connect an account, name a secret or release one after
 * the mandate's profile already names it.
 *
 * No, for:
 * - a value from the environment (a store that cannot say counts as one);
 * - a name a profile of another author reads: that profile's author holds it — unless that
 *   author is the owner and the owner released the name to `via` ({@link releaseState}), the
 *   case a release exists for;
 * - a name a provider preset profile reads, other than `via`: a preset connection's
 *   credentials go to its provider through that profile, and a second profile would send them
 *   elsewhere — the mandate's own preset profiles included;
 * - a token of a connection, unless `via` itself holds the grant and this mandate consented to
 *   it: another profile of the same mandate, on a host of its choosing, would send it there;
 * - any other name, unless the owner released it to `via`.
 *
 * Without `via` (a bare `secret:` reference) no name is readable: there is no profile a release
 * could be for, and no profile that holds a grant. `agent.ts` refuses a mandate's references
 * before this would be asked.
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
  via: ApiProfile | undefined,
  ctx: ReadCtx,
  writing = false,
): boolean {
  if (store.isEnvironmentSecret?.(name) ?? true) return false;
  let ownToken = false;
  let released: boolean | undefined;
  const isReleased = (): boolean => (released ??= via !== undefined && releaseState(store, apiStore, via, name, ctx) === 'released');
  for (const p of apiStore.getAll()) {
    if (p.created_by !== tag) {
      if (!collectVaultKeys(p).includes(name)) continue;
      if (!isMandateAuthored(p) && isReleased()) continue;
      return false;
    }
    if (p.auth?.oauth?.preset_id !== undefined && p.id !== via?.id && collectVaultKeys(p).includes(name)) return false;
    if (grantTokenNames(p).has(name)) {
      if (p.id !== via?.id) return false;
      const by = p.oauth_grant?.connected_by;
      const firstConsent = writing && by === undefined;
      if (by !== tag && !firstConsent) return false;
      ownToken = true;
    }
  }
  return ownToken || isReleased();
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
  ctx: ReadCtx,
): boolean {
  return [accessTokenKey(profile.id), refreshTokenKey(profile.id)]
    .every((name) => mandateMayRead(store, apiStore, tag, name, profile, ctx, true));
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
 * The profile a mandate wrote whose tokens go under `name`, if any: its derived pair, or a name
 * one of its exchanges recorded writing.
 */
export function mandateSlotHolder(apiStore: Pick<ApiStore, 'getAll'>, name: string): ApiProfile | undefined {
  return apiStore.getAll().find((p) => isMandateAuthored(p) && grantTokenNames(p).has(name));
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
  ctx: ReadCtx,
  writing = false,
): boolean {
  if (!isMandateAuthored(profile)) return false;
  return !mandateMayRead(store, apiStore, profile.created_by!, name, profile, ctx, writing);
}

/** The names among `names` the view hides from `profile` for `ctx`; none for a profile the owner wrote. */
export function withheldFrom(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'getAll'>,
  names: readonly string[],
  ctx: ReadCtx,
): string[] {
  return names.filter((name) => hiddenFromProfile(store, profile, apiStore, name, ctx));
}

/**
 * What a read says when the view withheld a name, in place of "the vault has no value": asking
 * for the value again would not change it, and a mandate cannot store one anyway.
 */
export function withheldText(names: readonly string[]): string {
  const shown = names.map((n) => `"${shapedForLog(n, VAULT_NAME_SHAPE, 64)}"`).join(' and ');
  const one = names.length === 1;
  return `${shown} ${one ? 'is' : 'are'} not available to this profile. A profile set up in a mandate's session reads a vault name of the owner's only once the owner releases it to that profile, and the owner is asked when the profile is saved. Asking for the value with ask_secret does not change this.`;
}

export function secretsForProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'getAll'>,
  ctx: ReadCtx,
): SecretStoreLike {
  if (!isMandateAuthored(profile)) return store;
  const hidden = (name: string): boolean => hiddenFromProfile(store, profile, apiStore, name, ctx);
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
