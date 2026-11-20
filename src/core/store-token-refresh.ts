/**
 * The refresh of a store connection whose token expires (Shopify's expiring offline tokens: an
 * access token for an hour, a refresh token for 90 days, both rotated on every refresh).
 *
 * In the engine and nowhere else. No tool and no route asks for a refresh: it runs as a side
 * effect of a request to the store, before the attach when the token is due and once after a
 * 401 ({@link refreshStoreToken}). The refresh token, the client secret and the provider's answer
 * reach no model, no tool input, no log line and no stream; a refresh that fails says so in a
 * fixed text, never with the answer's body.
 *
 * What holds it:
 *  - the pass: a request to a store's token endpoint goes out only under an exchange pass
 *    (`store-pass.ts`). {@link storeRefreshPassFor} mints one only for a connection whose binding
 *    still holds over the access token now in the vault, and over a body it builds itself, from
 *    the vault: the refresh grant, the preset's client and the stored refresh token.
 *  - one at a time: one refresh per profile in flight, none while a connect of the same profile
 *    is between its pass and its save, and a connect refused while a refresh runs.
 *  - at most one refresh per profile in {@link STORE_REFRESH_WINDOW_MS}, whatever started it.
 *  - compare-and-swap: the new tokens are stored only if the vault still holds the two the refresh
 *    presented. Otherwise the connection is dead: the old refresh token was spent at the store.
 *  - the scope: an answer whose scope is not the one granted is not stored.
 *  - the binding: computed again, over the new token, only by a refresh that began with the
 *    bound one. A refresh that ends the connection takes the binding away, so every request to
 *    the store refuses and says to connect again.
 */

import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { ApiProfile, OAuthGrantRecord, WrittenSecret } from './api-store.js';
import { accessTokenKey, recordedWrites, refreshTokenKey } from './api-store.js';
import { controlPlaneFromEnv } from './exact-clearance.js';
import { derivePresetEndpoints, OAUTH_PRESETS, presetClientKeys, presetStoreHost, presetTokenBodyFormat, scopesOfAnswer } from './oauth-presets.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { exchangeToken, isTokenEndpointRefused, serializeTokenBody, tokenExpiryFrom, vetTokenEndpoint, type VettedTokenEndpoint } from './oauth-token-exchange.js';
import { isOwnerPrincipal, type RequestPrincipal } from './request-principal.js';
import { newCorrelationId, type AuditEntry } from './audit-log.js';
import { mintStoreRefreshPass, STORE_EXCHANGE_PATH, storeOriginOf, type StorePass } from './store-pass.js';
import type { ToolContext } from './tool-context.js';
import type { IAgent } from '../types/index.js';
import { shopifyExchangeSwitchOn } from '../tools/builtin/http.js';

/** At most one refresh per profile in this span, whether the token was due or a 401 came back. */
export const STORE_REFRESH_WINDOW_MS = 60 * 1000;

/** What the refresh needs of its caller: the stores the attach holds, and who is asking. */
export interface StoreRefreshContext {
  readonly toolContext: Pick<ToolContext, 'apiStore' | 'exactClearance' | 'storeBindingDigest' | 'shellIsolation'> & Partial<Pick<ToolContext, 'auditLog'>>;
  readonly secretStore: NonNullable<IAgent['secretStore']>;
  readonly principal: RequestPrincipal | undefined;
  readonly runId?: string | undefined;
}

/**
 * `renewed`: new tokens are stored and bound. `not-run`: nothing was sent, or nothing came back
 * that changes the connection; the stored token stays as it was. `dead`: the store refused the
 * refresh or its answer could not be kept, and the connection has to be made again.
 */
export type StoreRefreshOutcome = 'renewed' | 'not-run' | 'dead' | 'client-misnamed';

/**
 * The refusal for a store connection whose client is not under the preset's own vault names: its
 * token cannot be renewed, and nothing is sent. Fixed text, for the model and the log.
 */
export function storeClientMisnamedText(profileId: string): string {
  return `the Shopify store connection of api_profile "${profileId}" does not keep its app's client ID and secret under the names this provider uses (SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET), so its expiring token cannot be renewed and nothing was sent to the store. Connect it again with api_setup action "connect".`;
}

const refreshesInFlight = new Map<string, Promise<StoreRefreshOutcome>>();
const connectsInFlight = new Map<string, number>();
const lastAttempt = new Map<string, number>();
/** Profiles whose last refresh found the client under other names: inside the window they stay refused, not sent with a stale token. */
const lastMisnamed = new Set<string>();

/**
 * A connect of `profileId` is about to mint its exchange pass. `false` when a refresh of the same
 * profile runs: the connect is then refused, not queued (the store says not to do both at once).
 * Every `true` is followed by one {@link endStoreConnect}.
 */
export function beginStoreConnect(profileId: string): boolean {
  if (refreshesInFlight.has(profileId)) return false;
  connectsInFlight.set(profileId, (connectsInFlight.get(profileId) ?? 0) + 1);
  return true;
}

/** The connect begun with {@link beginStoreConnect} has saved, or given up. */
export function endStoreConnect(profileId: string): void {
  const n = (connectsInFlight.get(profileId) ?? 1) - 1;
  if (n <= 0) connectsInFlight.delete(profileId);
  else connectsInFlight.set(profileId, n);
}

/** Forget every refresh window, connect and refresh in flight. Module state: tests must not share it. */
export function resetStoreRefreshForTests(): void {
  refreshesInFlight.clear();
  connectsInFlight.clear();
  lastAttempt.clear();
  lastMisnamed.clear();
}

/** Hold `profileId` as if a refresh of it ran, until the returned function is called. For tests. */
export function holdStoreRefreshForTests(profileId: string): () => void {
  let release!: () => void;
  const held = new Promise<StoreRefreshOutcome>((r) => { release = () => { refreshesInFlight.delete(profileId); r('not-run'); }; });
  refreshesInFlight.set(profileId, held);
  return release;
}

/** How many profiles a connect holds against a refresh right now. For tests. */
export function storeConnectsHeldForTests(): number {
  return connectsInFlight.size;
}

/** How long before the refresh token runs out the owner is told, once. */
export const STORE_RECONNECT_HINT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The owner's hint that a store's refresh token runs out soon, or has: one message per store and
 * per expiry, claimed on the grant (`reconnect_hint_for`) before it is handed out, so two workers on
 * one file send it once. No timer and no refresh: the worker's tick asks this, and only a store
 * the engine still holds a binding for is told. The store is named by its host, which the engine
 * derives, never by the profile's name. A claim that cannot be saved hands out nothing.
 */
export function claimStoreReconnectHints(
  apiStore: { getAll(): ApiProfile[]; save: (p: ApiProfile, dir?: string) => { ok: boolean } },
  apisDir: string,
  lang: 'de' | 'en',
  now: number = Date.now(),
): { title: string; body: string; priority: 'normal' }[] {
  const out: { title: string; body: string; priority: 'normal' }[] = [];
  for (const profile of apiStore.getAll()) {
    if (!storeRefreshApplies(profile)) continue;
    const grant = profile.oauth_grant;
    const until = grant?.refresh_expires_at;
    const host = presetStoreHost(profile);
    if (grant === undefined || typeof until !== 'number' || host === null) continue;
    if (typeof grant.store_binding !== 'string' || grant.state === 'revoked') continue;
    if (until - now > STORE_RECONNECT_HINT_MS || grant.reconnect_hint_for === until) continue;
    let claimed = false;
    try {
      claimed = apiStore.save({ ...profile, oauth_grant: { ...grant, reconnect_hint_for: until } }, apisDir).ok;
    } catch {
      claimed = false;
    }
    if (!claimed) continue;
    out.push(storeReconnectHint(host, until, now, lang));
  }
  return out;
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function storeReconnectHint(host: string, until: number, now: number, lang: 'de' | 'en'): { title: string; body: string; priority: 'normal' } {
  const d = new Date(until);
  const day = String(d.getUTCDate());
  const year = String(d.getUTCFullYear());
  if (lang === 'de') {
    const date = `${day}. ${MONTHS_DE[d.getUTCMonth()] ?? ''} ${year}`;
    return until <= now
      ? { title: 'Shop neu verbinden', body: `Der Zugang von lynox zum Shop ${host} ist abgelaufen. Verbinde den Shop unter Einstellungen → APIs neu, damit Läufe und Abfragen wieder laufen.`, priority: 'normal' }
      : { title: 'Shop bald neu verbinden', body: `Der Zugang von lynox zum Shop ${host} läuft am ${date} ab. Verbinde den Shop vorher unter Einstellungen → APIs neu, damit Läufe und Abfragen weiterlaufen.`, priority: 'normal' };
  }
  const date = `${MONTHS_EN[d.getUTCMonth()] ?? ''} ${day}, ${year}`;
  return until <= now
    ? { title: 'Connect the store again', body: `lynox's access to the store ${host} has run out. Connect the store again under Settings → APIs so runs and requests work again.`, priority: 'normal' }
    : { title: 'Connect the store again soon', body: `lynox's access to the store ${host} runs out on ${date}. Connect the store again under Settings → APIs before then, so runs and requests keep going.`, priority: 'normal' };
}

/** Whether a profile is of a store preset whose tokens may expire, so that a refresh applies. */
export function storeRefreshApplies(profile: ApiProfile): boolean {
  const preset = OAUTH_PRESETS.get(profile.auth?.oauth?.preset_id ?? '');
  return preset?.apiOnDerivedHost === true && preset.expiringParam !== undefined;
}

function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What a refresh pass was minted for: the request it covers and the vault it was built from. */
export interface StoreRefreshPlan {
  readonly pass: StorePass;
  readonly endpoint: VettedTokenEndpoint;
  readonly params: Readonly<Record<string, string>>;
  readonly bodyFormat: 'form' | 'json';
  readonly origin: string;
  /** The values the body was built from, for the compare-and-swap before the save. */
  readonly presented: { readonly access: string; readonly refresh: string; readonly binding: string; readonly clientId: string };
}

/**
 * The pass for one refresh of `profileId`, with the request it covers; `undefined` when any
 * condition fails, and nothing is then sent. It takes no body: it builds one, from the vault, and
 * mints over exactly that. In this order:
 *  0. the switch of the store exchange is on (`shopifyExchangeSwitchOn`);
 *  1. a provisioned managed instance, with the clearance and the store binding;
 *  2. the shell-exec sidecar;
 *  3. the profile is of a store preset that asks for expiring tokens, on its own store's host,
 *     whose token endpoint is that store's and passes the endpoint vetting;
 *  4. the profile's client is the preset's own pair of vault names (`client-misnamed` otherwise,
 *     which the attach names), and its refresh token is in the profile's own derived slot;
 *  5. the binding the callback recorded holds over the access token now in the vault, for this
 *     profile and the store's origin;
 *  6. client id, client secret and refresh token are in the vault;
 *  7. the control plane's clearance, as for the connect's exchange.
 */
export async function storeRefreshPassFor(profileId: string, ctx: StoreRefreshContext): Promise<StoreRefreshPlan | 'client-misnamed' | undefined> {
  const { toolContext, secretStore } = ctx;
  if (!shopifyExchangeSwitchOn()) return undefined;
  if (controlPlaneFromEnv() === null || !toolContext.exactClearance || !toolContext.storeBindingDigest) return undefined;
  if (toolContext.shellIsolation.kind !== 'sidecar') return undefined;
  const profile = toolContext.apiStore?.get(profileId);
  if (profile === undefined || profile.auth?.type !== 'oauth2' || !storeRefreshApplies(profile)) return undefined;
  const oauth = profile.auth.oauth;
  const presetId = oauth?.preset_id;
  if (oauth === undefined || presetId === undefined) return undefined;
  const preset = OAUTH_PRESETS.get(presetId);
  const host = presetStoreHost(profile);
  if (preset === undefined || host === null) return undefined;
  const endpoints = derivePresetEndpoints(presetId, oauth.preset_params);
  if ('kind' in endpoints) return undefined;
  let tokenUrl: URL;
  try { tokenUrl = new URL(endpoints.tokenUrl); } catch { return undefined; }
  const origin = storeOriginOf(tokenUrl);
  if (origin === null || origin !== `https://${host}` || tokenUrl.pathname !== STORE_EXCHANGE_PATH || tokenUrl.href.includes('?')) return undefined;
  const endpoint = vetTokenEndpoint(endpoints.tokenUrl, profile.custom_endpoint_ack);
  if (isTokenEndpointRefused(endpoint)) return undefined;
  const client = presetClientKeys(preset.id);
  if (oauth.client_id_key !== client.id || oauth.client_secret_key !== client.secret) return 'client-misnamed';
  const refreshSlot = refreshTokenKey(profile.id);
  if (oauth.refresh_token_key !== undefined && oauth.refresh_token_key !== refreshSlot) return undefined;
  const bound = profile.oauth_grant?.store_binding;
  const access = secretStore.resolve(accessTokenKey(profile.id));
  if (typeof bound !== 'string' || !access) return undefined;
  const digest = toolContext.storeBindingDigest(profile.id, origin, access);
  if (digest === null || !sameDigest(digest, bound)) return undefined;
  const refresh = secretStore.resolve(refreshSlot);
  const clientId = secretStore.resolve(client.id);
  const clientSecret = secretStore.resolve(client.secret);
  if (!refresh || !clientId || !clientSecret) return undefined;
  const clearance = await toolContext.exactClearance.ensure();
  if (!clearance.ok) return undefined;
  const params = { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refresh };
  const bodyFormat = presetTokenBodyFormat(preset, oauth.body_format);
  return {
    pass: mintStoreRefreshPass(origin, serializeTokenBody(params, bodyFormat)),
    endpoint,
    params,
    bodyFormat,
    origin,
    presented: { access, refresh, binding: bound, clientId },
  };
}

/**
 * Refresh the token of a store connection, once, if nothing holds it back. Never throws.
 *
 * `trigger` says what asked: `due` before the attach, inside the refresh buffer; `unauthorized`
 * after the store answered 401 with the stored token. Either way at most one refresh per profile
 * runs in {@link STORE_REFRESH_WINDOW_MS}; a caller that finds the window used gets `not-run`, and
 * a request that got a 401 then halts on it.
 */
export function refreshStoreToken(profileId: string, trigger: 'due' | 'unauthorized', ctx: StoreRefreshContext): Promise<StoreRefreshOutcome> {
  const running = refreshesInFlight.get(profileId);
  if (running !== undefined) return running;
  if ((connectsInFlight.get(profileId) ?? 0) > 0) {
    logLine(profileId, 'not started: a connect of this store is completing');
    return Promise.resolve('not-run');
  }
  const last = lastAttempt.get(profileId);
  if (last !== undefined && Date.now() - last < STORE_REFRESH_WINDOW_MS) {
    if (lastMisnamed.has(profileId)) {
      logLine(profileId, 'not started: the last refresh found the client under other names, and nothing has changed since');
      return Promise.resolve('client-misnamed');
    }
    logLine(profileId, `not started: one refresh per ${String(STORE_REFRESH_WINDOW_MS / 1000)} s, the last at ${new Date(last).toISOString()}`);
    return Promise.resolve('not-run');
  }
  lastAttempt.set(profileId, Date.now());
  const run = runRefresh(profileId, trigger, ctx)
    .catch(() => {
      outcomeLine(profileId, 'not-run', trigger, 'an unexpected error; the stored token is unchanged');
      return 'not-run' as const;
    })
    .then((outcome) => {
      if (outcome === 'client-misnamed') lastMisnamed.add(profileId);
      else lastMisnamed.delete(profileId);
      return outcome;
    })
    .finally(() => { refreshesInFlight.delete(profileId); });
  refreshesInFlight.set(profileId, run);
  return run;
}

function logLine(profileId: string, what: string): void {
  process.stderr.write(`[lynox:store] token refresh for api_profile "${profileId}" ${what}\n`);
}

/**
 * The one line every refresh that ran ends with, for the owner and a bulk run as for a mandate:
 * profile, outcome and a fixed reason. Never a token, a body or the store's answer.
 */
function outcomeLine(profileId: string, outcome: 'ok' | 'not-run' | 'dead' | 'scope-mismatch' | 'cas-lost' | 'client-misnamed', trigger: 'due' | 'unauthorized', why: string): void {
  logLine(profileId, `outcome=${outcome} (${trigger}): ${why}`);
}

/** The `attempt` row of a mandate's refresh, `null` for the owner, `'refused'` when it cannot be written. */
function beginTrail(profileId: string, trigger: 'due' | 'unauthorized', ctx: StoreRefreshContext): AuditEntry | null | 'refused' {
  const principal = ctx.principal;
  if (principal === undefined || isOwnerPrincipal(principal)) return null;
  const log = ctx.toolContext.auditLog ?? null;
  if (log === null) return 'refused';
  const entry: AuditEntry = {
    principal,
    action: 'store:token_refresh',
    target: `store token refresh ${profileId} (${trigger})`,
    phase: 'attempt',
    correlationId: newCorrelationId(),
    runId: ctx.runId,
  };
  try { log.record(entry); } catch { return 'refused'; }
  return entry;
}

async function runRefresh(profileId: string, trigger: 'due' | 'unauthorized', ctx: StoreRefreshContext): Promise<StoreRefreshOutcome> {
  const apiStore = ctx.toolContext.apiStore;
  // A vault this caller cannot write to gets no refresh: the store would spend the refresh token
  // and the new one would be lost.
  const vault = ctx.secretStore;
  if (!apiStore || vault.set === undefined) {
    logLine(profileId, 'not started: this caller cannot write the vault');
    return 'not-run';
  }
  const setSecret = (name: string, value: string): void => { vault.set!(name, value); };
  const trail = beginTrail(profileId, trigger, ctx);
  if (trail === 'refused') {
    logLine(profileId, 'not started: it could not be recorded in the instance log');
    return 'not-run';
  }
  const endTrail = (phase: 'returned' | 'failed'): void => {
    if (trail === null) return;
    try { ctx.toolContext.auditLog?.record({ ...trail, phase }); } catch { /* the attempt row stands alone */ }
  };
  const plan = await storeRefreshPassFor(profileId, ctx);
  if (plan === 'client-misnamed') {
    endTrail('failed');
    outcomeLine(profileId, 'client-misnamed', trigger, 'the client is not under the preset\'s vault names');
    return 'client-misnamed';
  }
  if (plan === undefined) {
    endTrail('failed');
    outcomeLine(profileId, 'not-run', trigger, 'the connection does not qualify for a refresh (binding, refresh token or clearance)');
    return 'not-run';
  }
  const exchanged = await exchangeToken({ endpoint: plan.endpoint, params: plan.params, bodyFormat: plan.bodyFormat }, ctx.toolContext as ToolContext, undefined, plan.pass);
  endTrail(exchanged.ok ? 'returned' : 'failed');
  if (!exchanged.ok) {
    // Nothing came back: whether the store spent the refresh token is unknown, and the next attempt
    // after the window finds out. The stored token is left as it is.
    outcomeLine(profileId, 'not-run', trigger, 'the store did not answer; the stored token is unchanged');
    return 'not-run';
  }
  if (!exchanged.responseOk) {
    // 400 and 401 are the store refusing the refresh token: expired, revoked or already spent. Only
    // a new connect helps, and only an explicit `invalid_grant` records the grant as revoked. Any
    // other status (429, 5xx, a proxy's 408) says nothing about the token: it stays as it was.
    if (exchanged.status !== 400 && exchanged.status !== 401) {
      outcomeLine(profileId, 'not-run', trigger, `the store answered HTTP ${String(exchanged.status)}; the stored token is unchanged`);
      return 'not-run';
    }
    return endConnection(profileId, ctx, plan, 'dead', trigger, `the store refused the refresh with HTTP ${String(exchanged.status)}`, invalidGrant(exchanged.text));
  }
  let parsed: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown; scope?: unknown };
  try {
    parsed = JSON.parse(exchanged.text) as typeof parsed;
  } catch {
    return endConnection(profileId, ctx, plan, 'dead', trigger, 'the store\'s answer was not readable');
  }
  const access = parsed.access_token;
  if (typeof access !== 'string' || access === '') return endConnection(profileId, ctx, plan, 'dead', trigger, 'the store\'s answer carried no access token');
  const rotated = typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '' ? parsed.refresh_token : null;
  const { getLynoxDir } = await importConfig();

  // From here to the save nothing yields: what the compare reads is what the writes replace.
  const profile = apiStore.get(profileId);
  if (profile === undefined) {
    outcomeLine(profileId, 'not-run', trigger, 'the profile was removed while the refresh was out; nothing was stored');
    return 'not-run';
  }
  // An answer that names a scope must name the one granted; one that names none leaves the
  // granted scope as it was (a refresh cannot widen what the app was granted).
  const granted = profile.oauth_grant?.granted_scope;
  const answered = scopesOfAnswer(parsed.scope);
  if (granted === undefined || (answered !== undefined && !sameScopes(granted, answered))) {
    return endConnection(profileId, ctx, plan, 'scope-mismatch', trigger, 'the store\'s answer named another scope than the one granted; nothing was stored');
  }
  const accessKey = accessTokenKey(profileId);
  const refreshKey = refreshTokenKey(profileId);
  if (ctx.secretStore.resolve(accessKey) !== plan.presented.access
    || ctx.secretStore.resolve(refreshKey) !== plan.presented.refresh
    || profile.oauth_grant?.store_binding !== plan.presented.binding) {
    return endConnection(profileId, ctx, plan, 'cas-lost', trigger, 'the vault changed while the refresh ran; nothing was stored');
  }
  const binding = ctx.toolContext.storeBindingDigest?.(profileId, plan.origin, access) ?? null;
  if (binding === null) return endConnection(profileId, ctx, plan, 'dead', trigger, 'the new token could not be bound to the store; nothing was stored');

  const replacedAccessFp = apiStore.currentFingerprint(accessKey);
  try {
    setSecret(accessKey, access);
    if (rotated !== null) setSecret(refreshKey, rotated);
  } catch {
    // The vault may hold the new access token beside the old binding, and the refresh token the
    // store spent: every request to the store refuses on the binding, and says to connect again.
    outcomeLine(profileId, 'dead', trigger, 'writing the new tokens to the vault failed; connect the store again');
    return 'dead';
  }
  const liveRefresh = rotated ?? plan.presented.refresh;
  const writes: WrittenSecret[] = [{ name: accessKey, fp: tokenFingerprint(access) }];
  if (rotated !== null) writes.push({ name: refreshKey, fp: tokenFingerprint(rotated) });
  const expiry = tokenExpiryFrom(parsed.expires_in);
  const refreshExpiry = tokenExpiryFrom(parsed.refresh_token_expires_in);
  const oauthNext = { ...profile.auth?.oauth };
  if (expiry === 'unknown') delete oauthNext.token_expires_at;
  else oauthNext.token_expires_at = expiry;
  const kept = recordedWrites(profile).filter((w) => !writes.some((x) => x.name === w.name));
  const grantNext: OAuthGrantRecord = {
    ...profile.oauth_grant,
    store_binding: binding,
    minted_by: tokenFingerprint(plan.presented.clientId),
    minted_for: tokenFingerprint(liveRefresh),
    written: [...kept, ...writes],
  };
  if (refreshExpiry === 'unknown') delete grantNext.refresh_expires_at;
  else grantNext.refresh_expires_at = refreshExpiry;
  let saved = false;
  try {
    saved = apiStore.save(
      { ...profile, auth: { ...profile.auth, oauth: oauthNext }, oauth_grant: grantNext } as ApiProfile,
      join(getLynoxDir(), 'apis'),
      {
        // The refresh token presented and the access value replaced are this grant's own, so the
        // save keeps the grant's epoch: a bulk run's targets stay on one grant across a refresh.
        exchange: {
          presentedRefreshFp: apiStore.valueFingerprint(plan.presented.refresh) ?? null,
          presentedRefreshTokenFp: apiStore.tokenFingerprint(plan.presented.refresh) ?? null,
          replacedAccessFp,
          wrote: writes.map((w) => w.name),
        },
        actor: ctx.principal,
      },
    ).ok;
  } catch {
    saved = false;
  }
  if (!saved) {
    // The vault holds the new tokens, the profile the old binding: every request to the store now
    // refuses on the binding and says to connect again, the safe direction.
    outcomeLine(profileId, 'dead', trigger, 'the new tokens are in the vault but the profile could not be saved; connect the store again');
    return 'dead';
  }
  outcomeLine(profileId, 'ok', trigger, 'new tokens stored and bound');
  return 'renewed';
}

/** The config module, imported when first needed: it reads the environment at load. */
async function importConfig(): Promise<typeof import('./config.js')> {
  return import('./config.js');
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((s) => y.has(s));
}

/**
 * The connection cannot go on: the binding is taken away, if it is still the one the refresh began
 * with, so every request to the store refuses and says to connect again. The tokens in the vault
 * stay where they are; a new connect replaces them.
 */
async function endConnection(
  profileId: string,
  ctx: StoreRefreshContext,
  plan: StoreRefreshPlan,
  outcome: 'dead' | 'scope-mismatch' | 'cas-lost',
  trigger: 'due' | 'unauthorized',
  why: string,
  /** The store said `invalid_grant`: the grant is recorded as revoked, for the refusal that names it. */
  revoked = false,
): Promise<StoreRefreshOutcome> {
  const apiStore = ctx.toolContext.apiStore;
  if (apiStore) {
    try {
      const { getLynoxDir } = await importConfig();
      // Read after the import, with nothing between this and the save: a connect that saved
      // meanwhile carries its own binding, which stays.
      const now = apiStore.get(profileId);
      if (now?.oauth_grant !== undefined && now.oauth_grant.store_binding === plan.presented.binding) {
        const { store_binding: _gone, ...rest } = now.oauth_grant;
        const grant: OAuthGrantRecord = revoked
          ? { ...rest, state: 'revoked', revoked_fp: tokenFingerprint(plan.presented.refresh), revoked_at: new Date().toISOString() }
          : rest;
        apiStore.save({ ...now, oauth_grant: grant } as ApiProfile, join(getLynoxDir(), 'apis'), { actor: ctx.principal });
      }
    } catch {
      // The binding stays; the store refuses the spent token itself, and the next refresh ends here again.
    }
  }
  outcomeLine(profileId, outcome, trigger, revoked ? `${why} (invalid_grant: recorded as revoked)` : why);
  return 'dead';
}

/** Whether a refused refresh's answer is the store's `invalid_grant`. Reads the one field, nothing else. */
function invalidGrant(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed.error === 'invalid_grant';
  } catch {
    return false;
  }
}
