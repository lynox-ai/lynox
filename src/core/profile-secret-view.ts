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
import { accessTokenKey, collectVaultKeys, grantTokenNames, hasTokenSlotShape, isMandateAuthored, isMandateConnection, readersRefreshSlot, refreshTokenKey, tokenSlotNames, vaultSlotBase, writtenNames } from './api-store.js';
import type { ApiAuth, ApiProfile, ApiStore } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import { currentPlanOf } from './plan-run-context.js';
import { derivePresetEndpoints, OAUTH_PRESETS, presetStoreHost, type OAuthPreset } from './oauth-presets.js';
import { MANDATE_TAG_PREFIX, principalTag, type RequestPrincipal } from './request-principal.js';
import { singleLine } from './prompt-value.js';
import type { SecretReleases } from './secret-releases.js';
import type { VaultNameBindings } from './vault-name-bindings.js';
import { DERIVED_NAME_SHAPE, shapedForLog, VAULT_NAME_SHAPE } from './profile-value-shape.js';
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
 * What a check of a vault name's destinations reads ({@link boundCtx}). A missing part binds
 * nothing: without `bindings` no name is bound, and without `store` or `read` no release counts.
 */
export interface BindingCtx {
  /** The stored bindings; null when this instance keeps none (no engine.db). */
  readonly bindings: Pick<VaultNameBindings, 'boundOf'> | null;
  /** The vault, for whether a release still stands; null: no release counts. */
  readonly store: SecretStoreLike | null;
  /** Who reads, for the releases; null: no release counts. */
  readonly read: ReadCtx | null;
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
 * In which role a token slot's value would leave the process:
 * - `request` — as the credential of an HTTP request to `target` (the engine's attach, or a
 *   `secret:` reference in `http_request`);
 * - `exchange` — as the refresh token posted to the token endpoint `target`;
 * - `client` — as an OAuth client id or client secret;
 * - `other` — in the input of any tool other than `http_request`, whose destination the engine
 *   cannot read.
 */
export type SlotRole = 'request' | 'exchange' | 'client' | 'other';

/**
 * Whose grant a vault name belongs to, read over every stored profile:
 * - `free` — no profile holds it: not a token slot.
 * - `contested` — more than one profile holds it.
 * - `owned` — `owner` holds it; `members` are the owner and, only for the owner's own refresh
 *   slot, the profiles that read that slot and share the grant through a built-in provider
 *   ({@link sharedGrant}).
 */
type SlotGrant =
  | { readonly kind: 'free' }
  | { readonly kind: 'contested' }
  | { readonly kind: 'owned'; readonly owner: ApiProfile; readonly members: readonly ApiProfile[]; readonly preset: OAuthPreset | undefined };

/**
 * The built-in provider two oauth2 profiles share a grant through, or undefined when they do
 * not: the same `preset_id` in {@link OAUTH_PRESETS}, both bases on one of its `apiHosts` over
 * https with no port of their own (for a provider on the host it derives, each on its own
 * store host, `presetStoreHost`), and the same token endpoint as the preset derives it from
 * each profile's parameters. A profile whose `base_url` does not parse shares nothing.
 */
function sharedGrant(a: ApiProfile, b: ApiProfile): OAuthPreset | undefined {
  const presetId = a.auth?.type === 'oauth2' ? a.auth.oauth?.preset_id : undefined;
  if (presetId === undefined || b.auth?.type !== 'oauth2' || b.auth.oauth?.preset_id !== presetId) return undefined;
  const preset = OAUTH_PRESETS.get(presetId);
  if (preset === undefined) return undefined;
  const onApiHost = (p: ApiProfile): boolean => {
    // A provider on the host it derives: each profile on its own store's host, which the equal
    // token endpoints below make the same store.
    if (preset.apiOnDerivedHost === true) return presetStoreHost(p) !== null;
    let base: URL;
    try {
      base = new URL(p.base_url);
    } catch {
      return false;
    }
    return base.protocol === 'https:' && base.port === '' && preset.apiHosts.includes(base.hostname);
  };
  if (!onApiHost(a) || !onApiHost(b)) return undefined;
  const ea = derivePresetEndpoints(presetId, a.auth?.oauth?.preset_params);
  const eb = derivePresetEndpoints(presetId, b.auth.oauth?.preset_params);
  if ('kind' in ea || 'kind' in eb || ea.tokenUrl !== eb.tokenUrl) return undefined;
  return preset;
}

/**
 * The grant `name` belongs to among `profiles`. A profile holds a name its grant writes to
 * ({@link grantTokenNames}: the pair an oauth2 profile's id derives, and the names its exchanges
 * wrote). One holder owns the name; more than one, and the name is contested and belongs to no
 * one, whichever of them was stored or loaded first. A refresh slot a profile only configures
 * (`refresh_token_key`) is no claim on a name a grant holds: such a profile is a member of the
 * owner's grant only when it reads the owner's refresh slot and the two share the grant through a
 * built-in provider. A configured name no grant holds, and no other stored profile names in any
 * way, is the configurer's own refresh slot: it goes only to that profile's own exchange, and to
 * nothing else. Named by another profile as well (a state admission does not let two registered
 * profiles reach), it stays free, so a configured name never takes another profile's credential.
 */
function slotGrant(profiles: readonly ApiProfile[], name: string): SlotGrant {
  const holders = profiles.filter((p) => grantTokenNames(p).has(name));
  const [owner] = holders;
  if (owner === undefined) {
    const namers = profiles.filter((p) => slotNames(p).includes(name));
    const [only] = namers;
    if (namers.length !== 1 || only!.auth?.type !== 'oauth2' || readersRefreshSlot(only!) !== name) return { kind: 'free' };
    return { kind: 'owned', owner: only!, members: [only!], preset: undefined };
  }
  if (holders.length > 1) return { kind: 'contested' };
  let preset: OAuthPreset | undefined;
  const members: ApiProfile[] = [owner];
  // Only the owner's own refresh slot is shared; any other name of its grant has one member.
  if (owner.auth?.type !== 'oauth2' || readersRefreshSlot(owner) !== name) return { kind: 'owned', owner, members, preset };
  for (const p of profiles) {
    if (p.id === owner.id || p.auth?.type !== 'oauth2' || readersRefreshSlot(p) !== name) continue;
    const shared = sharedGrant(owner, p);
    if (shared === undefined) continue;
    preset = shared;
    members.push(p);
  }
  return { kind: 'owned', owner, members, preset };
}

/**
 * What a profile does with a vault name, as admission weighs it:
 * - `derives` — an oauth2 profile's id derives it (the access or refresh half of its pair);
 * - `wrote` — an exchange of the profile wrote a token there (`oauth_grant.written`);
 * - `configures` — an oauth2 profile reads its refresh token from it (`refresh_token_key`)
 *   without deriving it;
 * - `signs-in` — the profile sends what it holds as a credential of its own: any `vault_keys`
 *   position, the Basic pair, the OAuth client pair, and a `refresh_token_key` a profile that is
 *   not oauth2 carries.
 */
type SlotPart = 'derives' | 'wrote' | 'configures' | 'signs-in';

function slotParts(p: ApiProfile): Map<string, Set<SlotPart>> {
  const parts = new Map<string, Set<SlotPart>>();
  const add = (name: unknown, part: SlotPart): void => {
    if (typeof name !== 'string' || name === '') return;
    let set = parts.get(name);
    if (set === undefined) parts.set(name, set = new Set());
    set.add(part);
  };
  const auth = p.auth;
  const oauth2 = auth?.type === 'oauth2';
  if (oauth2) {
    add(accessTokenKey(p.id), 'derives');
    add(refreshTokenKey(p.id), 'derives');
  }
  for (const name of writtenNames(p)) add(name, 'wrote');
  const refresh: unknown = auth?.oauth?.refresh_token_key;
  if (!oauth2) add(refresh, 'signs-in');
  else if (typeof refresh === 'string' && !parts.get(refresh)?.has('derives')) add(refresh, 'configures');
  // Every position, read as the attach and `collectVaultKeys` read it: an array, or the first two
  // indices of anything else.
  const vaultKeys: unknown = auth?.vault_keys;
  if (Array.isArray(vaultKeys)) for (const k of vaultKeys) add(k, 'signs-in');
  else if (vaultKeys !== undefined && vaultKeys !== null) for (const i of [0, 1]) add((vaultKeys as Record<number, unknown>)[i], 'signs-in');
  for (const k of [auth?.username_key, auth?.password_key, auth?.oauth?.client_id_key, auth?.oauth?.client_secret_key]) add(k, 'signs-in');
  return parts;
}

/** Every vault name a profile derives, wrote, configures or signs in with: the names `slotConflicts` weighs. */
export function slotNames(p: ApiProfile): string[] {
  return [...slotParts(p).keys()];
}

/**
 * Where two stored profiles meet on one vault name in a way that cannot stand, and which of them
 * may not be registered for it: `x`, `y`, or `both`. `name` is null when the names could not be
 * read at all; that is a conflict too.
 */
export interface SlotConflict {
  readonly name: string | null;
  readonly loser: 'x' | 'y' | 'both';
  readonly why: string;
}

/**
 * Every vault name on which `x` and `y` cannot both be registered. A token slot belongs to one
 * grant:
 * - two profiles that derive or wrote one name hold it twice — neither is registered;
 * - a profile that configures a name another derives or wrote, or that two profiles configure,
 *   would exchange a token that is not its own — neither, unless the two share the grant through a
 *   built-in provider ({@link sharedGrant}) and the name is the holder's own refresh slot;
 * - a profile that signs in with a name another derives or wrote loses it to the next token, so
 *   only the profile signing in goes (core#1874: the working connection stays);
 * - a profile that signs in with a name another configures: neither, since the configurer would
 *   post the credential as a refresh token and only the user can say whose the name is.
 * Which one of a pair reached the store first does not decide. Two ids that collapse onto one vault
 * slot (`vaultSlotBase`) are decided where they always were, first come first served. A profile
 * whose names cannot be read loses; a comparison that throws is a conflict both lose.
 */
export function slotConflicts(x: ApiProfile, y: ApiProfile): SlotConflict[] {
  // A profile whose names cannot be read loses on its own account; its partner stays as it is,
  // since a profile that is not registered sends nothing.
  const read = (p: ApiProfile): Map<string, Set<SlotPart>> | null => {
    try {
      vaultSlotBase(p.id);
      return slotParts(p);
    } catch {
      return null;
    }
  };
  const px = read(x);
  const py = read(y);
  if (px === null || py === null) {
    const loser = px === null && py === null ? 'both' : px === null ? 'x' : 'y';
    const unread = [px === null ? x : undefined, py === null ? y : undefined].filter((p) => p !== undefined).map((p) => `api_profile "${String(p.id)}"`);
    return [{ name: null, loser, why: `the vault names of ${unread.join(' and ')} could not be read.` }];
  }
  try {
    if (x.id === y.id || vaultSlotBase(x.id) === vaultSlotBase(y.id)) return [];
    const out: SlotConflict[] = [];
    for (const [name, xs] of px) {
      const ys = py.get(name);
      if (ys === undefined) continue;
      // One verdict per name: `x` and `y` losing on two parts of it is `both`.
      let found: { loser: SlotConflict['loser']; why: string } | null = null;
      for (const a of xs) {
        for (const b of ys) {
          const v = partConflict(name, x, a, y, b);
          if (v === null) continue;
          if (found === null) found = v;
          else if (found.loser !== v.loser) found = { loser: 'both', why: found.why };
        }
      }
      if (found !== null) out.push({ name, ...found });
    }
    return out;
  } catch {
    return [{ name: null, loser: 'both', why: `the vault names of api_profile "${String(x.id)}" and api_profile "${String(y.id)}" could not be compared.` }];
  }
}

const holds = (part: SlotPart): boolean => part === 'derives' || part === 'wrote';

function partText(id: string, part: SlotPart, name: string): string {
  if (part === 'derives') return `api_profile "${id}" is oauth2 and writes its tokens to ${name}`;
  if (part === 'wrote') return `api_profile "${id}" has a token an exchange of its own wrote to ${name}`;
  if (part === 'configures') return `api_profile "${id}" reads its refresh token from ${name}`;
  return `api_profile "${id}" signs in with ${name}`;
}

/** One pair of parts on `name`: who of `x` and `y` may not be registered for it, or null. */
function partConflict(name: string, x: ApiProfile, a: SlotPart, y: ApiProfile, b: SlotPart): { loser: 'x' | 'y' | 'both'; why: string } | null {
  if (a === 'signs-in' && b === 'signs-in') return null;
  if (a === 'signs-in' || b === 'signs-in') {
    const xSigns = a === 'signs-in';
    const user = xSigns ? x : y;
    const other = xSigns ? y : x;
    const otherPart = xSigns ? b : a;
    if (holds(otherPart)) return { loser: xSigns ? 'x' : 'y', why: `${partText(other.id, otherPart, name)}, which api_profile "${user.id}" signs in with — the next token would replace it.` };
    return { loser: 'both', why: `${partText(other.id, otherPart, name)}, which api_profile "${user.id}" signs in with — the one would post the other's credential as a refresh token.` };
  }
  if (a === 'configures' || b === 'configures') {
    // A configured refresh slot is shared only as the holder's own refresh slot, or between two
    // configurers, and only through a built-in provider.
    const xReads = a === 'configures';
    const reader = xReads ? x : y;
    const other = xReads ? y : x;
    const otherPart = xReads ? b : a;
    const sharedSlot = otherPart === 'configures' || readersRefreshSlot(other) === name;
    if (sharedSlot && sharedGrant(other, reader) !== undefined) return null;
    return { loser: 'both', why: `${partText(other.id, otherPart, name)}, and ${partText(reader.id, 'configures', name)} without sharing that connection through a built-in provider.` };
  }
  return { loser: 'both', why: `${partText(x.id, a, name)}, and ${partText(y.id, b, name)} as well: a token slot belongs to one connection.` };
}

/**
 * Whether `p` reads its refresh token from a token slot of another stored profile: one another
 * profile derives, wrote, or configures as its own refresh slot.
 */
function readsForeignRefreshSlot(p: ApiProfile, known: readonly ApiProfile[]): boolean {
  if (p.auth?.type !== 'oauth2') return false;
  const slot: unknown = p.auth.oauth?.refresh_token_key;
  if (typeof slot !== 'string' || slot === '' || slot === refreshTokenKey(p.id)) return false;
  return known.some((o) => o.id !== p.id && tokenSlotNames(o).has(slot));
}

/**
 * The vault names a save of `next` has to empty before it may be stored: every token slot `stored`
 * holds ({@link grantTokenNames}: the derived pair and what its exchanges wrote), when
 * - the save changes where the profile's credentials go ({@link credentialEndpoints}, compared as
 *   sets): a token minted for the old destinations would go to the new ones; or
 * - the stored version reads another profile's refresh slot and the save ends that or changes
 *   `base_url`, `preset_id`, `preset_params` or `refresh_token_key`. What such a reader exchanged
 *   is a token of the other profile's account; left in its slots it would go wherever the saved
 *   version points. Judged by the stored version: a save that drops the shared slot is exactly
 *   the one that must empty it.
 * Empty when nothing has to go.
 */
export function slotsToClearBeforeSave(stored: ApiProfile | undefined, next: ApiProfile, known: readonly ApiProfile[]): string[] {
  if (stored === undefined) return [];
  // A save that moves where the credentials go empties the tokens they minted: a token from before
  // the move would otherwise go to the new destinations without ever passing the exchange there.
  if (!sameEndpoints(stored, next)) return [...grantTokenNames(stored)];
  if (!readsForeignRefreshSlot(stored, known)) return [];
  const where = (p: ApiProfile): string => {
    const oauth = p.auth?.type === 'oauth2' ? p.auth.oauth : undefined;
    return stableJson([p.base_url, oauth?.preset_id ?? null, oauth?.preset_params ?? null, oauth?.refresh_token_key ?? null]);
  };
  // The same `refresh_token_key` on an oauth2 profile of the same id reads the same slot: an
  // unchanged tuple is a save that keeps reading it.
  if (where(next) === where(stored)) return [];
  return [...grantTokenNames(stored)];
}

/** Whether `a` and `b` send their credentials to the same {@link credentialEndpoints}, as sets. */
function sameEndpoints(a: ApiProfile, b: ApiProfile): boolean {
  const x = new Set(credentialEndpoints(a));
  const y = new Set(credentialEndpoints(b));
  return x.size === y.size && [...x].every((e) => y.has(e));
}

/** Whether `name` is a refresh slot of `p`: the one its id derives, or the one it configures. */
function isRefreshSlotOf(p: ApiProfile, name: string): boolean {
  return p.auth?.type === 'oauth2' && (refreshTokenKey(p.id) === name || p.auth.oauth?.refresh_token_key === name);
}

/**
 * Whether the value under `name` may leave the process in `role` to `target`, asked by the
 * profile `asker` (none for a `secret:` reference). A name no stored profile claims is not a
 * token slot and may go anywhere this predicate is concerned with. A token slot goes only to a
 * target of the grant it belongs to:
 * - `request`: an access token, never a refresh token, of an owner that is registered, to the
 *   origin (scheme, host and port) of the owner's `base_url` — or, when the owner shares its
 *   grant through a built-in provider, to `https://<host>` for a host of that provider's
 *   `apiHosts`. An owner of a provider on the host it derives, shared or not, reaches its own
 *   store host only, and there only paths under the provider's `apiPathPrefix`;
 * - `exchange`: a refresh token, asked by the owner or by a profile sharing the grant, to the
 *   owner's token endpoint (the preset's, else `token_url`), compared whole;
 * - `client` and `other`: never.
 * An access token minted with a client secret goes, besides, only while every destination of its
 * owner is one that secret is bound to ({@link boundCtx}); asked without `bind`, it goes nowhere.
 * A contested name goes nowhere, and so does a name a stored entry the boot could not read or
 * register names ({@link ApiStore.unreadableHolds}): whose it is cannot be told. The stored
 * profiles are read ({@link ApiStore.knownProfiles}), so a profile the boot held back still counts
 * as a claimant. Anything that throws while this
 * is decided answers no. The owner's `base_url` not being a URL makes a request answer no;
 * another profile's unparsable `base_url` only keeps that profile out of a shared grant.
 */
export function slotMayReach(
  apiStore: Pick<ApiStore, 'knownProfiles' | 'get' | 'unreadableHolds'>,
  name: string,
  role: SlotRole,
  target: string | undefined,
  asker?: ApiProfile,
  bind?: BindingCtx,
): boolean {
  try {
    if (apiStore.unreadableHolds(name)) return false;
    const profiles = apiStore.knownProfiles();
    const grant = slotGrant(profiles, name);
    if (grant.kind === 'free') return true;
    if (grant.kind === 'contested' || target === undefined) return false;
    const { owner, members } = grant;
    const refresh = members.some((m) => isRefreshSlotOf(m, name));
    if (role === 'request') {
      if (refresh) return false;
      // A held-back owner's access token goes nowhere: it is stored, not in use.
      if (apiStore.get(owner.id) === undefined) return false;
      // A token minted with the owner's client secret goes only where that secret may go: a base
      // moved without the owner's answer (a file edited by hand, a save the binding question
      // refused) takes no token along, the ones minted before the move included. Without a
      // binding context, none.
      const clientSecret: unknown = owner.auth?.type === 'oauth2' ? owner.auth.oauth?.client_secret_key : undefined;
      if (typeof clientSecret === 'string' && clientSecret !== '') {
        if (bind === undefined) return false;
        const bound = boundCtx(apiStore, clientSecret, bind);
        if (!credentialEndpoints(owner).every((e) => bound.has(e))) return false;
      }
      const destination = destinationOf(new URL(target));
      // A store profile's token, shared or not, reaches its store's host only, never a base
      // re-pointed elsewhere, and there only the provider's API path. An encoded slash or backslash
      // is refused there: the URL parser leaves it alone, a server may decode it and route out of
      // that path. (Encoded dot segments the parser resolves itself.)
      const ownPreset = owner.auth?.type === 'oauth2' && owner.auth.oauth?.preset_id !== undefined ? OAUTH_PRESETS.get(owner.auth.oauth.preset_id) : undefined;
      // A token the callback bound to a store stays a store token after the profile was re-pointed
      // away from the store preset (a human may accept the new host): it reaches nothing then.
      // `oauth_grant` is the engine's; an update cannot clear the binding.
      if (ownPreset?.apiOnDerivedHost !== true && typeof owner.oauth_grant?.store_binding === 'string') return false;
      if (ownPreset?.apiOnDerivedHost === true) {
        const store = presetStoreHost(owner);
        const path = new URL(target).pathname;
        return store !== null && destination === `https://${store}`
          && (ownPreset.apiPathPrefix === undefined || (path.startsWith(ownPreset.apiPathPrefix) && !/%(2f|5c)/i.test(path)));
      }
      // The owner's own refresh slot says whether it shares its grant, and through which provider;
      // only when the owner is one of that grant's members.
      const ownGrant = owner.auth?.type === 'oauth2' ? slotGrant(profiles, readersRefreshSlot(owner)) : undefined;
      if (ownGrant?.kind === 'owned' && ownGrant.members.length > 1 && ownGrant.preset !== undefined && ownGrant.members.some((m) => m.id === owner.id)) {
        return ownGrant.preset.apiHosts.some((h) => destination === `https://${h}`);
      }
      const [base] = credentialUrls(owner);
      return base !== undefined && destination === destinationOf(base);
    }
    if (role === 'exchange') {
      if (!refresh || asker === undefined || !members.some((m) => m.id === asker.id)) return false;
      const [, endpoint] = credentialUrls(owner);
      return endpoint !== undefined && new URL(target).href === endpoint.href;
    }
    return false;
  } catch {
    return false;
  }
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
 * The `bound` fields of `profile` that are set, by their path, as the owner is shown them when
 * asked for a release. Read from the tables above, as {@link releaseBinding} is, so a field
 * placed there later is shown without a second edit: the question names every field whose
 * change ends the release.
 */
export function releaseBoundFields(profile: ApiProfile): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const add = (prefix: string, fields: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(fields)) if (value !== null) out.push([`${prefix}${key}`, value]);
  };
  add('', boundOf(PROFILE_FIELDS, profile));
  add('auth.', boundOf(AUTH_FIELDS, profile.auth));
  add('auth.oauth.', boundOf(OAUTH_FIELDS, profile.auth?.oauth));
  return out;
}

/** `value` as JSON with every object's keys sorted, so the same configuration always spells the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

/**
 * Where a profile's credentials go and how they are sent or scoped: every `host` field, as
 * {@link credentialEndpoints} resolves it, and every `bound` field. These are the changes that
 * end a release, and `credentialTuple` folds them in for the same reason: a save that moves a
 * credential to another destination or changes what its token may do starts a new grant. Read
 * from the tables above, so a field placed there later is counted here without a second edit.
 */
export function credentialBearing(profile: ApiProfile): string {
  return stableJson({
    endpoints: [...credentialEndpoints(profile)].sort(),
    profile: boundOf(PROFILE_FIELDS, profile),
    auth: boundOf(AUTH_FIELDS, profile.auth),
    oauth: boundOf(OAUTH_FIELDS, profile.auth?.oauth),
  });
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
export type ReleaseObstacle = 'environment' | 'protected' | 'token' | 'not-sent' | 'not-https' | 'preset' | 'other-mandate';

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
 * - `not-https` — one of {@link credentialEndpoints} is not https: the base, where the value or
 *   the access token an OAuth client pair mints is sent, or the token endpoint the pair is
 *   posted to.
 * - `preset` — a preset profile other than `via` reads it: a preset connection's credentials go
 *   to its provider through that profile, the owner's own preset profiles included.
 * - `other-mandate` — a profile another mandate wrote reads it.
 */
export function releaseObstacle(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  via: ApiProfile,
  name: string,
): ReleaseObstacle | null {
  if (store.isEnvironmentSecret?.(name) ?? true) return 'environment';
  if (isProtectedSecretWrite(name)) return 'protected';
  if (hasTokenSlotShape(name)) return 'token';
  if (sendRole(via, name) === null) return 'not-sent';
  if (credentialEndpoints(via).some((e) => new URL(e).protocol !== 'https:')) return 'not-https';
  for (const p of apiStore.knownProfiles()) {
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
  apiStore: Pick<ApiStore, 'knownProfiles'>,
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
 * - a token of a connection the mandate made itself, unless the run that reads is that mandate
 *   ({@link memberConnectionReader}): the owner's run reaches this profile too, by its host, and
 *   the account is the mandate's, not the owner's;
 * - a token of a connection the mandate made itself, in a plan's run (`currentPlanOf`): the
 *   owner's stamp lets the plan run, and it does not list the mandate's own connections, so the
 *   plan does not use them; in the mandate's own session they work as before;
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
  apiStore: Pick<ApiStore, 'knownProfiles'>,
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
  for (const p of apiStore.knownProfiles()) {
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
      // And only for the person who connected it: the view asks with the profile's author, the
      // reader is the run's principal (an owner's run reads this profile too). A first consent
      // has no connection yet that is someone's: whoever's exchange it is records theirs.
      if (by !== undefined && !memberConnectionReader(p, ctx.principal, writing ? 'write' : 'read', ctx.ends)) return false;
      ownToken = true;
    }
  }
  return (ownToken && currentPlanOf() === undefined) || isReleased();
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
 * The vault names `p` sends as a secret of its own: every name it reads as a credential
 * ({@link credentialNames} — the client id is public and not among them) but the token slots its
 * own grant holds, which go where that grant points ({@link slotMayReach}). These are the names a
 * binding governs ({@link nameMayGo}).
 */
export function secretBearingNames(p: ApiProfile): string[] {
  const held = grantTokenNames(p);
  return [...credentialNames(p)].filter((n) => !held.has(n));
}

/**
 * Every destination `name` may go to for the reader of `bind`: the destinations it is bound to
 * (`vault-name-bindings.ts`), and the {@link credentialEndpoints} of each profile a mandate wrote
 * that the owner released it to and whose release stands for this reader ({@link releaseState}).
 * Computed at each read, never stored: a release that lapses takes its destinations with it.
 */
export function boundCtx(apiStore: Pick<ApiStore, 'knownProfiles'>, name: string, bind: BindingCtx): Set<string> {
  const out = new Set(bind.bindings?.boundOf(name) ?? []);
  const { store, read } = bind;
  if (store === null || read === null) return out;
  for (const via of apiStore.knownProfiles()) {
    if (!isMandateAuthored(via)) continue;
    if (releaseState(store, apiStore, via, name, read) === 'released') for (const e of credentialEndpoints(via)) out.add(e);
  }
  return out;
}

/**
 * Whether `profile` may send its secret-bearing vault name `name` ({@link secretBearingNames}) to
 * `target` in `role`: the target is one of the destinations `name` may go to ({@link boundCtx}) —
 * for a request its origin, for the token endpoint (`client`, `exchange`) its whole URL, each as
 * {@link credentialEndpoints} spells them — and so is every destination of `profile`, since a
 * secret that goes to a token endpoint mints a token for the profile's base. Nothing here widens a
 * binding. Anything that throws answers no.
 */
export function nameMayGo(
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  name: string,
  profile: ApiProfile,
  target: string,
  role: 'request' | 'client' | 'exchange',
  bind: BindingCtx,
): boolean {
  try {
    const bound = boundCtx(apiStore, name, bind);
    const url = new URL(target);
    const where = role === 'request' ? destinationOf(url) : url.href;
    return bound.has(where) && credentialEndpoints(profile).every((e) => bound.has(e));
  } catch {
    return false;
  }
}

/**
 * The first of `profile`'s secret-bearing names among `names` that may not go to `target` in
 * `role` ({@link nameMayGo}), or undefined when all may. Names `profile` does not send as a secret
 * of its own (a client id, a token slot of its grant) are not asked here.
 */
export function unboundName(
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  names: ReadonlyArray<string | undefined>,
  profile: ApiProfile,
  target: string,
  role: 'request' | 'client' | 'exchange',
  bind: BindingCtx,
): string | undefined {
  const bearing = new Set(secretBearingNames(profile));
  return names.find((n): n is string => typeof n === 'string' && bearing.has(n) && !nameMayGo(apiStore, n, profile, target, role, bind));
}

/**
 * What a send refused by {@link nameMayGo} says: the name, and the one way past it. Never
 * `ask_secret` or a new value: a new value is not a new destination.
 */
export function unboundNameText(name: string, profileId: string): string {
  return `"${shapedForLog(name, DERIVED_NAME_SHAPE, 80)}" is not allowed to go where the profile "${profileId}" would send it. Nothing was sent. To allow it, save the profile "${profileId}" again in the chat and answer the question. Storing the key again does not change where it may go.`;
}

/**
 * Whether the value under `name` may be put into a sign-in link as a client id. The link goes to
 * the browser of whoever opens it, and from there to the provider: a name any profile reads as a
 * credential, or a key the engine guards, would put a secret there.
 */
export function mayServeAsClientId(apiStore: Pick<ApiStore, 'knownProfiles'>, name: string): boolean {
  if (isProtectedSecretWrite(name)) return false;
  return !apiStore.knownProfiles().some((p) => credentialNames(p).has(name));
}

/**
 * Whether a connection the mandate `tag` starts on `profile` may store its tokens: both slots
 * an exchange writes, asked as a write. A slot another author's profile reads would otherwise
 * be overwritten with this mandate's token, and that profile would send it.
 */
export function mandateMayConnect(
  store: SecretStoreLike,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
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
  apiStore: Pick<ApiStore, 'knownProfiles'> | null,
  ends: Pick<MandateEnds, 'isLive'> | null,
  name: string,
): boolean {
  if (apiStore === null) return true;
  return !apiStore.knownProfiles().some((p) => connectionWaits(p, ends) && grantTokenNames(p).has(name));
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

/**
 * Whether `reader` is the person who made `profile`'s connection with their own login, and so the
 * one its tokens may reach. `read`: the same tag as the consent and the same grant, both known.
 * `write` (the first consent, or a later grant of the same address connecting its profile again):
 * the profile's author, under a grant that is live now; the consent it replaces may be another
 * grant's. A side that is not known never matches, so a mandate login without a grant reaches
 * nothing.
 */
export function memberConnectionReader(
  profile: ApiProfile,
  reader: RequestPrincipal,
  mode: 'read' | 'write',
  ends: Pick<MandateEnds, 'isLive'> | null,
): boolean {
  if (reader.kind !== 'mandate' || reader.mandateId === undefined) return false;
  const tag = principalTag(reader);
  if (mode === 'write') return profile.created_by === tag && ends !== null && ends.isLive(reader.mandateId);
  const consentId = profile.oauth_grant?.connected_mandate_id;
  return profile.oauth_grant?.connected_by === tag && consentId !== undefined && consentId === reader.mandateId;
}

/**
 * What a request through `profile` says when it would carry a token of a connection someone
 * else made with their own login, or null when that is not the case. Two shapes, because the way
 * out differs: while that person's access lasts, the connection is theirs and cannot be taken
 * over; once it has ended, the owner takes it over in the chat. Only the owner can do either, so
 * any other reader is told only that it is not used here.
 */
export function memberConnectionRefusal(
  profile: ApiProfile,
  reader: RequestPrincipal,
  ends: Pick<MandateEnds, 'isLive'> | null,
): string | null {
  if (!isMandateConnection(profile)) return null;
  const by = profile.oauth_grant!.connected_by!;
  if (reader.kind === 'mandate' && principalTag(reader) === by) return null;
  const person = singleLine(by.slice(MANDATE_TAG_PREFIX.length));
  const presetId = profile.auth?.oauth?.preset_id;
  const provider = singleLine((presetId !== undefined ? OAUTH_PRESETS.get(presetId)?.label : undefined) ?? hostLabel(profile.base_url));
  const shown = `${JSON.stringify(singleLine(profile.name))} (id ${profile.id})`;
  const lead = `${person} set up this connection (${provider}, profile ${shown}) with their own login`;
  if (reader.kind !== 'owner') return `${lead}, so it is not used in this session.`;
  if (!connectionWaits(profile, ends)) {
    return `${lead}, so lynox does not use it for you. Take it over in the chat once ${person}'s access has ended, or delete this profile under Settings → APIs and connect it yourself (that disconnects ${person}).`;
  }
  return `${lead}. To let lynox use it for you, take it over: in the chat, ask to take over the connection ${shown} and confirm with "Allow".`;
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'its provider';
  }
}

/**
 * Whether the view below hides `name` from `profile`. A profile the owner wrote hides nothing,
 * except the tokens of a connection a mandate made on it with its own login: those reach only
 * that mandate ({@link memberConnectionReader}), whoever wrote the profile.
 */
export function hiddenFromProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  name: string,
  ctx: ReadCtx,
  writing = false,
): boolean {
  if (!isMandateAuthored(profile)) {
    return isMandateConnection(profile) && grantTokenNames(profile).has(name)
      && !memberConnectionReader(profile, ctx.principal, writing ? 'write' : 'read', ctx.ends);
  }
  return !mandateMayRead(store, apiStore, profile.created_by!, name, profile, ctx, writing);
}

/** The names among `names` the view hides from `profile` for `ctx`; none for a profile the owner wrote. */
export function withheldFrom(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  names: readonly string[],
  ctx: ReadCtx,
): string[] {
  return names.filter((name) => hiddenFromProfile(store, profile, apiStore, name, ctx));
}

/**
 * What a read says when the view withheld a name, in place of "the vault has no value": asking
 * for the value again would not change it, and a mandate cannot store one anyway.
 */
export function withheldText(names: readonly string[], offBase = false): string {
  const shown = names.map((n) => `"${shapedForLog(n, VAULT_NAME_SHAPE, 64)}"`).join(' and ');
  const one = names.length === 1;
  // A request to another port or scheme of the base's host reaches the profile, but a release
  // covers only the base: say so, or a release that exists reads as one that does not.
  const where = offBase
    ? ' This request does not go to the profile\'s base_url (its scheme, host and port), and a release, where one is given, covers only requests to the base.'
    : '';
  return `${shown} ${one ? 'is' : 'are'} not available to this profile${offBase ? ' for this request' : ''}. A profile set up in a mandate's session reads a vault name of the owner's only once the owner releases it to that profile, and the owner is asked when the profile is saved.${where} Asking for the value with ask_secret does not change this.`;
}

/**
 * The vault as the engine reads it for `profile` in a run of `ctx.principal`. A profile the
 * owner wrote gets the store unchanged, in a mandate's run as well, unless a mandate connected it
 * with its own login ({@link hiddenFromProfile}). `GET
 * /api/bulk/runs/:id/targets` serves a mandate the before-images of a bulk run under `reads`,
 * and a test in `http-api.test.ts` couples that stance to this read.
 */
export function secretsForProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'knownProfiles'>,
  ctx: ReadCtx,
): SecretStoreLike {
  if (!isMandateAuthored(profile) && !isMandateConnection(profile)) return store;
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
