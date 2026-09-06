import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { OAuthRefreshRequest, OAuthRefreshResponse } from '../../contract/http.js';
import { createSign, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { SecretVault } from '../../core/secret-vault.js';
import { googleFetch, cpFetch } from '../../core/connector-egress.js';
import type { HostPolicyContext } from '../../core/network-guard.js';

// === Types ===

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scopes: string[];
  /**
   * Present when the control plane sealed the refresh token to this instance.
   *
   * With it AND a complete control-plane identity in env, the engine refreshes
   * THROUGH the control plane and this process never holds lynox's client
   * secret — which is the point: the alternative was emitting that secret into
   * every tenant container. Both conditions are required, and the handle alone
   * is not enough: a half-configured instance falls back to the direct path.
   * A self-host operator has their own client credentials and no control plane,
   * so this stays absent there and the direct path below is the only one.
   */
  refresh_handle?: string;
  /**
   * The Google account this grant belongs to, as the control plane read it
   * from the `openid email` scopes at consent.
   *
   * Absent means UNKNOWN, not "no account": grants made before Stage 1
   * requested those scopes carry nothing, and the card names the connection
   * without an address rather than showing an empty one. Nothing may key on
   * it — addresses change and differ in case and dots for one mailbox.
   */
  email?: string;
  /**
   * The OAuth client id this token was minted under — recorded ONLY where this
   * process performed the exchange itself and Google accepted that id.
   *
   * It exists to tell two things apart that Google reports identically. See
   * `reclassifyForeignGrant`: an `invalid_grant` means "the user revoked" and
   * also "you are presenting a token minted by a different client", and without
   * the minting id the second one is indistinguishable from the first — so it
   * deletes a living grant.
   *
   * Absent means UNKNOWN, and unknown is not a mismatch: tokens the control
   * plane minted (`setTokens`) and every blob written before this field existed
   * carry nothing, and must keep behaving exactly as they did.
   */
  client_id?: string;
}

/**
 * The three values a managed instance needs to reach its control plane, or null
 * when any is missing.
 *
 * All three or none, deliberately: a partially configured instance must take
 * the direct path rather than build a half-formed request. Two are checked for
 * presence; the URL is checked for usability, which subsumes presence. The same
 * env names `managed-hook.ts` uses — the engine has exactly one identity toward
 * the control plane.
 */
function readControlPlaneIdentity(): { url: string; instanceId: string; secret: string } | null {
  const rawUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';
  // No `!rawUrl` here: `controlPlaneBase` refuses the empty string already
  // (`new URL('')` throws), so a presence check would be a line no test could
  // distinguish from its absence.
  if (!instanceId || !secret) return null;
  const url = controlPlaneBase(rawUrl);
  if (url === null) return null;
  return { url, instanceId, secret };
}

/**
 * Normalise the CP base URL, or null if it cannot carry a secret safely.
 *
 * The value is operator-set, so this is not a trust boundary — it is a
 * concatenation guard. `${base}/internal/...` on a base that carries a query or
 * a fragment does not append a path, it extends the query, and the request
 * would go somewhere else with the instance secret attached. A path PREFIX is
 * kept, because a CP behind one is a legitimate deployment.
 */
function controlPlaneBase(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Refuse on the RAW string, not on `parsed.search`/`parsed.hash`: an empty
  // query parses to `search === ''` while `href` keeps the `?`, so reading the
  // parsed fields let exactly the value through that this guard exists for.
  // Refusing beats silently dropping — an operator's mistake should be loud.
  if (raw.includes('?') || raw.includes('#')) return null;
  // Credentials would authenticate the request somewhere the operator did not
  // mean. Refuse rather than strip: `origin` would drop them silently while the
  // operator still believed the request was authenticated.
  if (parsed.username !== '' || parsed.password !== '') return null;
  // ONE mechanism, deliberately. Building from `origin + pathname` would make
  // the same guarantee structurally — and that is exactly the problem: with the
  // refusals above it can never behave differently, so no test could tell the
  // two apart and the second line would be uncovered by construction.
  return parsed.href.replace(/\/+$/, '');
}

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

export interface GoogleAuthOptions {
  /**
   * The OAuth app credential. **Optional since the broker split**: a tenant
   * whose tokens the control plane mints and refreshes never receives a pair
   * (PRD Stage 1 §3.2), and the object still has to exist so the claim has
   * somewhere to put the tokens.
   *
   * Optional rather than a `brokered: true` flag on purpose: the absence IS the
   * mode, and making it a type lets the compiler enumerate every site that
   * needs a decision instead of a grep finding the ones somebody remembered.
   */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  serviceAccountKeyPath?: string | undefined;
  vault?: SecretVault | undefined;
  /** Override default OAuth scopes. Defaults to STANDARD_SCOPES. */
  scopes?: string[] | undefined;
  /**
   * The live host-policy view (`network_policy` + the operator floor), so every
   * call this object makes is subject to the instance's egress policy
   * (PRD Stage 1 §3.8). The engine hands in its ToolContext, which satisfies
   * this structurally and is mutated in place — so a policy change at runtime
   * is seen here without re-creating the credential.
   *
   * Optional, and `undefined` means "no policy configured" — the same meaning
   * it carries on every other egress surface. A caller that constructs this
   * object outside an engine keeps today's behaviour.
   */
  hostPolicy?: HostPolicyContext | undefined;
}

export interface DeviceFlowPrompt {
  verificationUrl: string;
  userCode: string;
}

export interface LocalAuthResult {
  authUrl: string;
}

// === Constants ===

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_AUTH_URL = 'https://oauth2.googleapis.com/device/code';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const VAULT_TOKEN_KEY = 'GOOGLE_OAUTH_TOKENS';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const LOCALHOST_TIMEOUT_MS = 120_000; // 2 min to complete browser auth
const DEVICE_POLL_INTERVAL_MS = 5_000; // Poll every 5s for device flow
const DEVICE_TIMEOUT_MS = 300_000; // 5 min to complete device auth

// Scope constants
//
// Every scope lynox will ever accept lives here, and the three sets below
// partition it by GOOGLE's classification — not by read/write, which is what
// the removed `READ_ONLY_SCOPES`/`WRITE_SCOPES` pair claimed and got wrong
// (it listed `drive.file`, a write scope, under neither, and an alias named
// READ_ONLY that returns write scopes lies to every caller).
export const SCOPES = {
  OPENID: 'openid',
  USERINFO_EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
  GMAIL_READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
  GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_COMPOSE: 'https://www.googleapis.com/auth/gmail.compose',
  GMAIL_METADATA: 'https://www.googleapis.com/auth/gmail.metadata',
  MAIL_GOOGLE_COM: 'https://mail.google.com/',
  SHEETS_READONLY: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  SHEETS: 'https://www.googleapis.com/auth/spreadsheets',
  DRIVE_READONLY: 'https://www.googleapis.com/auth/drive.readonly',
  DRIVE_FILE: 'https://www.googleapis.com/auth/drive.file',
  DRIVE: 'https://www.googleapis.com/auth/drive',
  DRIVE_METADATA_READONLY: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  CALENDAR_READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
  CALENDAR_EVENTS: 'https://www.googleapis.com/auth/calendar.events',
  CALENDAR_FREEBUSY: 'https://www.googleapis.com/auth/calendar.freebusy',
  CALENDAR: 'https://www.googleapis.com/auth/calendar',
  CALENDAR_LIST_READONLY: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  DOCS_READONLY: 'https://www.googleapis.com/auth/documents.readonly',
  DOCS: 'https://www.googleapis.com/auth/documents',
} as const;

/**
 * The default consent set — every scope in it is NON-SENSITIVE or SENSITIVE,
 * none is RESTRICTED, so it needs app verification but no annual CASA
 * assessment. Read off the Google Cloud Console's Data Access page on
 * 2026-08-20 — Google publishes no such list — and cross-checked against its
 * published Gmail/Drive/Sheets/Docs scope pages on 2026-08-26.
 *
 * `calendar.freebusy` is the one entry whose class was never read off the
 * Console; it is carried here because `calendar.events` is already sensitive,
 * so it cannot raise the set's class — only the table's completeness is open.
 */
export const STANDARD_SCOPES = [
  SCOPES.OPENID,
  SCOPES.USERINFO_EMAIL,
  SCOPES.CALENDAR_EVENTS,
  SCOPES.CALENDAR_FREEBUSY,
  SCOPES.DRIVE_FILE,
] as const;

/**
 * SENSITIVE by Google's classification: app verification, no CASA.
 *
 * None of these is requested by the standard set. The three `*.readonly`
 * entries are here because they were accepted yesterday and `VALID_SCOPES`
 * may not narrow — a tenant carrying one in `google_oauth_scopes` would
 * otherwise break on its next re-consent, and no test that looks only at the
 * new sets would see it.
 */
export const SENSITIVE_EXTRA_SCOPES = [
  SCOPES.SHEETS,
  SCOPES.SHEETS_READONLY,
  SCOPES.DOCS,
  SCOPES.DOCS_READONLY,
  SCOPES.CALENDAR,
  SCOPES.CALENDAR_READONLY,
  SCOPES.CALENDAR_LIST_READONLY,
  SCOPES.GMAIL_SEND,
] as const;

/**
 * RESTRICTED by Google's classification: verification PLUS an annual CASA
 * assessment and a Letter of Assessment. Nothing lynox requests by default is
 * in here, and that is the whole point of the standard set.
 */
export const RESTRICTED_SCOPES = [
  SCOPES.GMAIL_READONLY,
  SCOPES.GMAIL_MODIFY,
  SCOPES.GMAIL_COMPOSE,
  SCOPES.GMAIL_METADATA,
  SCOPES.MAIL_GOOGLE_COM,
  SCOPES.DRIVE,
  SCOPES.DRIVE_READONLY,
  SCOPES.DRIVE_METADATA_READONLY,
] as const;

/**
 * ⚠ THE THREE SETS ABOVE AND THIS ONE ANSWER TWO DIFFERENT QUESTIONS. Do not
 * merge them back together.
 *
 *  - The three sets are a CLASSIFICATION. They exist so `VALID_SCOPES` can
 *    accept everything a tenant might legitimately already hold, and so the
 *    "no restricted scope in the default set" claim is checkable. They must
 *    stay complete.
 *  - `FULL_SCOPES` is a REQUEST BUNDLE — what a consent screen actually asks a
 *    human for. It must stay MINIMAL, because Google's verification requires
 *    "the least amount of access … necessary", and a scope no lynox code path
 *    exercises is by definition not necessary.
 *
 * The PRD's sentence "`full` = all three sets" collapses the two, and building
 * it literally would have put `mail.google.com/` — read, send and permanently
 * delete the whole mailbox — on the consent screen of a mode whose Gmail half
 * D7 removed from this stage. Every entry below names the code path that
 * exercises it; `FULL_SCOPE_CONSUMERS` is that list, and a test holds the two
 * in step so a scope cannot return to the bundle without one.
 */
export const FULL_SCOPES: readonly string[] = [
  ...STANDARD_SCOPES,
  SCOPES.SHEETS,
  SCOPES.SHEETS_READONLY,
  SCOPES.DOCS,
  SCOPES.DOCS_READONLY,
  SCOPES.CALENDAR_READONLY,
  SCOPES.GMAIL_SEND,
  SCOPES.GMAIL_READONLY,
  SCOPES.DRIVE,
  SCOPES.DRIVE_READONLY,
];

/**
 * What `full` adds over the standard set, and the code path that exercises
 * each addition. Checked against the real tree by a test, so a stale entry
 * fails instead of reassuring.
 *
 * The standard set itself is not listed: it is decided in the PRD and defended
 * by its own tests (nothing restricted, hence CASA-free). `openid` and
 * `userinfo.email` are in it and have no `hasScope` reader yet — §3.5's
 * `email` field is W5 — which is exactly why they belong to the decided set
 * and not to this table.
 *
 * The scopes deliberately absent, and what would put them back:
 *  - `gmail.compose`, `gmail.metadata`, `mail.google.com/` — nothing drafts,
 *    reads metadata-only, or needs delete rights.
 *  - `gmail.modify` — measured: `OAuthGmailProvider` lists, searches, fetches
 *    and sends, and reads `labelIds` OUT of a list response. It never writes a
 *    label, trashes, or calls `messages.modify`, so `gmail.readonly` alone
 *    covers the reading half. This entry was in the table for one commit with
 *    `gmail.readonly`'s evidence string copied into it — which is how a scope
 *    with no consumer passed a test whose whole job is to catch that. The test
 *    now requires each evidence string to belong to exactly one scope.
 *  - `calendar.calendarlist.readonly` — D9 dropped `list_calendars`; the
 *    calendar id stays a parameter the user names.
 *  - `drive.metadata.readonly` — accepted if a tenant already holds it, but
 *    `drive.file` and `drive.readonly` authorise every Drive call lynox makes.
 *  - `calendar` — the blanket scope adds nothing over `calendar.events`,
 *    `calendar.readonly` and `calendar.freebusy` together.
 */
export const FULL_SCOPE_CONSUMERS: Readonly<Record<string, { file: string; evidence: string }>> = {
  [SCOPES.SHEETS]: { file: 'src/integrations/google/google-sheets.ts', evidence: 'SCOPES.SHEETS' },
  [SCOPES.SHEETS_READONLY]: { file: 'src/integrations/google/google-sheets.ts', evidence: 'SCOPES.SHEETS_READONLY' },
  [SCOPES.DOCS]: { file: 'src/integrations/google/google-docs.ts', evidence: 'SCOPES.DOCS' },
  [SCOPES.DOCS_READONLY]: { file: 'src/integrations/google/google-docs.ts', evidence: 'SCOPES.DOCS_READONLY' },
  [SCOPES.CALENDAR_READONLY]: { file: 'src/integrations/google/google-calendar.ts', evidence: 'SCOPES.CALENDAR_READONLY' },
  [SCOPES.DRIVE]: { file: 'src/integrations/google/google-drive.ts', evidence: 'SCOPES.DRIVE' },
  [SCOPES.DRIVE_READONLY]: { file: 'src/integrations/google/google-drive.ts', evidence: 'SCOPES.DRIVE_READONLY' },
  [SCOPES.GMAIL_SEND]: { file: 'src/integrations/mail/providers/oauth-gmail.ts', evidence: "gmailPost<GmailSendResponse>('messages/send'" },
  [SCOPES.GMAIL_READONLY]: { file: 'src/integrations/mail/providers/oauth-gmail.ts', evidence: 'gmailGet<GmailListResponse>' },
};

/** Default scopes for initial auth — the CASA-free standard set. */
const DEFAULT_SCOPES: readonly string[] = STANDARD_SCOPES;

/**
 * All known valid Google OAuth scopes — the ACCEPTANCE allowlist.
 *
 * Built from the three CLASSIFICATION sets, deliberately not from
 * `FULL_SCOPES`: `requestScope` throws on anything outside this set, so
 * narrowing it breaks a tenant whose stored `google_oauth_scopes` names a
 * scope that used to be fine. Accepting is cheap; requesting is not.
 */
const VALID_SCOPES = new Set<string>([
  ...STANDARD_SCOPES,
  ...SENSITIVE_EXTRA_SCOPES,
  ...RESTRICTED_SCOPES,
]);

/** The named consent modes the card offers, plus the one it can only observe. */
export type GoogleScopeMode = 'standard' | 'full' | 'legacy';

/**
 * Which mode a GRANT is in — the highest mode whose required set is a subset
 * of what Google actually granted.
 *
 * `legacy` is not a mode anyone can choose; it is what a grant taken before
 * these sets existed looks like (the old read-only bundle satisfies neither
 * required set). The card shows such a grant's services and parks the toggle
 * at `standard` WITHOUT calling it a mismatch — a mismatch is an expression of
 * user intent, and nobody expressed any.
 *
 * The client cannot compute this: `standardRequired` may be the tenant's
 * `google_oauth_scopes` override, which is runtime config the browser never
 * sees.
 */
export function computeScopeMode(
  granted: readonly string[],
  standardRequired: readonly string[] = STANDARD_SCOPES,
): GoogleScopeMode {
  const held = new Set(granted);
  const covers = (required: readonly string[]): boolean => required.every((s) => held.has(s));
  if (covers(FULL_SCOPES)) return 'full';
  if (covers(standardRequired)) return 'standard';
  return 'legacy';
}

// === Helpers ===

function parseTokenData(raw: string): TokenData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Record<string, unknown>;
    if (typeof data['access_token'] !== 'string' || data['access_token'] === '') return null;
    if (typeof data['refresh_token'] !== 'string') return null;
    if (typeof data['expires_at'] !== 'number' || !Number.isFinite(data['expires_at'])) return null;
    if (!Array.isArray(data['scopes']) || !data['scopes'].every((s: unknown) => typeof s === 'string')) return null;
    // Checked like every other field rather than trusted through the cast: a
    // non-string here compares unequal to any real client id, which would pin
    // the token as permanently foreign and keep a revoked grant for good.
    if (data['client_id'] !== undefined && typeof data['client_id'] !== 'string') return null;
    return parsed as TokenData;
  } catch {
    return null;
  }
}

/**
 * Validate a refresh response from the control plane.
 *
 * The direct path runs every Google response through `validateTokenResponse`.
 * This is the equivalent for the other one, and deliberately stricter: the
 * direct path derives `expires_at` from a `expires_in` it has already bounded
 * to be positive, while this value arrives absolute and unchecked. A `typeof`
 * check alone is not enough — `NaN` is a number, and an `expires_at` of `NaN` makes the staleness
 * comparison in `getAccessToken` false forever, so the engine would serve a
 * dead access token and never refresh again. An out-of-range value fails the
 * other way: an always-past expiry turns the CP into a dependency of every
 * Google call rather than of the hourly refresh.
 */
function validateControlPlaneRefresh(json: unknown): OAuthRefreshResponse {
  const bad = (why: string): never => {
    throw new Error(`Token refresh failed: ${why}.` + REFRESH_FAILURE_REMEDY.transient);
  };
  if (typeof json !== 'object' || json === null) {
    return bad('the control plane returned no usable token');
  }
  const data = json as Record<string, unknown>;
  const token = data['access_token'];
  if (typeof token !== 'string' || token === '') {
    return bad('the control plane returned no usable token');
  }
  const expiresAt = data['expires_at'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return bad('the control plane returned no usable expiry');
  }
  const now = Date.now();
  if (expiresAt <= now || expiresAt > now + MAX_CP_TOKEN_LIFETIME_MS) {
    return bad('the control plane returned an expiry outside the plausible range');
  }
  const handle = data['refresh_handle'];
  if (handle !== undefined && (typeof handle !== 'string' || handle === '')) {
    return bad('the control plane returned an unusable refresh handle');
  }
  return {
    access_token: token,
    expires_at: expiresAt,
    ...(typeof handle === 'string' ? { refresh_handle: handle } : {}),
  };
}

/**
 * The widest access-token lifetime we accept from the control plane. Google's
 * are an hour; a day is slack for any future change without letting an absurd
 * value pin a stale token for a year.
 */
const MAX_CP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a token response from Google and convert to TokenData.
 *
 * `mintedBy` is the client id this process posted to get this response, and is
 * recorded on the token. It is a parameter rather than a field read inside
 * because the only honest value is the one the caller actually presented: the
 * refresh path reuses this function without minting anything, and stamping the
 * currently-configured id there would assert a provenance nobody measured.
 */
function validateTokenResponse(json: unknown, mintedBy?: string | undefined): TokenData {
  if (typeof json !== 'object' || json === null) {
    throw new Error('Invalid token response: not an object');
  }
  const data = json as Record<string, unknown>;
  if (typeof data['access_token'] !== 'string' || data['access_token'] === '') {
    throw new Error('Invalid token response: missing access_token');
  }
  if (typeof data['expires_in'] !== 'number' || data['expires_in'] <= 0) {
    throw new Error('Invalid token response: missing or invalid expires_in');
  }
  const scope = typeof data['scope'] === 'string' ? data['scope'] : '';
  return {
    access_token: data['access_token'],
    refresh_token: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : '',
    expires_at: Date.now() + (data['expires_in'] as number) * 1000,
    scopes: scope ? scope.split(' ') : [],
    ...(mintedBy ? { client_id: mintedBy } : {}),
  };
}

function loadTokenData(vault?: SecretVault | undefined): TokenData | null {
  if (!vault) return null;
  const encrypted = vault.get(VAULT_TOKEN_KEY);
  if (!encrypted) return null;
  return parseTokenData(encrypted);
}

function saveTokenData(data: TokenData, vault?: SecretVault | undefined): void {
  if (!vault) {
    throw new Error('Cannot save tokens without a vault. Set LYNOX_VAULT_KEY to enable the vault.');
  }
  vault.set(VAULT_TOKEN_KEY, JSON.stringify(data), 'any');
}

function deleteTokenData(vault?: SecretVault | undefined): void {
  if (vault) {
    vault.delete(VAULT_TOKEN_KEY);
  }
}

type RefreshFailureKind = 'grant-revoked' | 'client-misconfigured' | 'transient';

/**
 * The remedy per failure kind. A Record over the union rather than a chain of
 * ternaries, so adding a kind is a compile error until it has a remedy.
 */
const REFRESH_FAILURE_REMEDY: Record<RefreshFailureKind, string> = {
  'grant-revoked': ' Re-connect your Google account in Settings → Channels → Google.',
  // Deliberately operator-facing and free of credential NAMES: this string is
  // returned inside tool results (`google-drive.ts`, `google-sheets.ts`), so
  // the model reads it. `GOOGLE_CLIENT_*` are infra-walled (`secret-store.ts`)
  // precisely so the agent never learns to go asking for them.
  'client-misconfigured':
    ' Your Google connection is intact — this instance\'s Google client credentials'
    + ' are not valid, so it cannot refresh until an operator corrects them.',
  transient: ' Retry in a moment — the refresh token is still on file.',
};

/**
 * The same verdict, for the control-plane path.
 *
 * Not an entry in the table above, because it is not a new failure KIND — it is
 * the same one with a different audience. On the direct path the invalid client
 * belongs to this instance and an operator here can fix it; on the control-plane
 * path it is lynox's own, and naming this instance would send the user after
 * something they do not control. It promises no reporting, because nothing in
 * this file reports anything anywhere.
 *
 * A named constant rather than a literal at the throw site: the suppression
 * window replays this text for every attempt it refuses, so it now has two
 * readers, and two copies of a user-facing sentence is how they drift apart.
 */
const CP_CLIENT_MISCONFIGURED_REMEDY =
  ' Your Google connection is intact — lynox could not complete the refresh.';

/**
 * The third audience, for the same reason the second one exists.
 *
 * A foreign grant is not a bad credential: the configured client is perfectly
 * valid, it is simply not the one this token was issued to. So the generic
 * `client-misconfigured` text — "credentials are not valid … until an operator
 * corrects them" — points the wrong way for the case that reaches here after a
 * DELIBERATE client change, where nothing needs correcting and the connection
 * has to be made again instead. Both routes are named because this code cannot
 * tell a typo from a rotation, and guessing wrong strands the user either way.
 *
 * Names no credential, like its neighbours: this string is returned inside tool
 * results, so the model reads it (`google-drive.ts`, `google-sheets.ts`).
 */
const FOREIGN_GRANT_REMEDY =
  ' Your Google connection is intact, but this instance now uses a different'
  + ' Google client than the one the account was connected with. Restore the'
  + ' previous client to resume, or reconnect the account under the current one.';

/**
 * How long a `client-misconfigured` verdict suppresses further token POSTs.
 *
 * Longer than the 120 s mail-watch tick (`providers/oauth-gmail.ts`), on
 * purpose: at 60 s every tick landed after the window had expired, so the
 * brake did nothing for the one caller that polls on its own.
 */
const CLIENT_MISCONFIGURED_COOLDOWN_MS = 300_000;

/**
 * Classify a `/token` refresh failure. Anchoring on the `error` field is what
 * every Google client library does; the HTTP status alone is ambiguous
 * (`invalid_grant` returns 400 just like a transient billing-limit would).
 *
 * The three kinds exist because two of them used to be one, and the pair that
 * was merged pulled in opposite directions:
 *
 * - `invalid_grant` — the GRANT is gone (revoked or expired). Nothing we
 *   change brings it back, so the stored token is worthless and is deleted.
 *   Google's remedy: "Authenticate the user again and ask for user consent to
 *   obtain new tokens."
 * - `invalid_client` (and the sibling client-config codes) — OUR credentials
 *   are wrong. The user's grant at Google is untouched. Google's remedy:
 *   "Review the OAuth client configuration, including the client ID and secret
 *   used for this request." Deleting here would destroy a working grant over a
 *   condition we can fix ourselves.
 *
 * Quotes read at developers.google.com/identity/protocols/oauth2/web-server on
 * 2026-08-21 — dated because a vendor page is a moving claim, and the note this
 * replaces cited a guidance that page does not contain (memory `fb_oauth_refresh`).
 *
 * **Scope, stated because the neighbouring comment used to overstate it:** this
 * separates failures by their `error` CODE, not by their cause. A wrong client
 * *secret* surfaces as `invalid_client` and is covered. A syntactically valid
 * but WRONG client *id* authenticates fine and makes Google reject the token as
 * foreign — reported as `invalid_grant`, indistinguishable *here* from a real
 * revocation, because the body carries nothing that separates them.
 *
 * That second case is no longer decided here. It is decided one step later, by
 * `reclassifyForeignGrant`, which compares the id recorded at minting time
 * against the one we just presented — the comparison this function has no
 * access to. This one stays a pure function of the response, which is what
 * makes it testable against Google's wire format alone.
 */

function classifyRefreshFailure(httpStatus: number, body: string): RefreshFailureKind {
  if (httpStatus >= 500 || httpStatus === 429) return 'transient';
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      if (parsed.error === 'invalid_grant') return 'grant-revoked';
      // `unauthorized_client` / `deleted_client` are the same class as
      // `invalid_client`: our app registration is wrong. Telling the user to
      // "retry in a moment" would be a lie — retrying never fixes any of them.
      if (parsed.error === 'invalid_client'
        || parsed.error === 'unauthorized_client'
        || parsed.error === 'deleted_client') return 'client-misconfigured';
    }
  } catch {
    // Non-JSON body — Google may be returning an HTML error page from a
    // proxy. Don't wipe the token on the basis of unparseable output.
    return 'transient';
  }
  // 4xx with a JSON body naming neither code → unknown failure mode.
  // Conservative default: keep the token.
  return 'transient';
}

/**
 * Separate "the user revoked the grant" from "we presented the token to the
 * wrong client" — the two cases `classifyRefreshFailure` cannot tell apart.
 *
 * Google answers `invalid_grant` to both. A wrong client *secret* fails earlier
 * and louder (`invalid_client`, handled since core#1252); a wrong client *id*
 * that is syntactically valid authenticates fine, and Google then rejects the
 * refresh token as foreign to that client. The response is identical to a real
 * revocation, so the only thing that separates them is the id recorded when the
 * token was minted — which is why this takes the ids rather than the body.
 *
 * Three states, and only ONE of them changes the outcome:
 *
 * - **unknown** (either id absent) → unchanged. A control-plane-minted token
 *   and every blob predating `client_id` land here. Treating unknown as a
 *   mismatch would keep genuinely revoked grants forever and make reconnecting
 *   impossible — the opposite failure, and the more expensive one.
 * - **equal** → unchanged. The token really is dead; deleting it is right.
 * - **different** → `client-misconfigured`. The grant is intact; our
 *   registration is what is wrong. Reusing that kind rather than adding one is
 *   deliberate: its remedy already says exactly this ("Your Google connection
 *   is intact … an operator corrects them"), and it arms the same cool-down.
 *
 * The wrong direction is worth naming because a fix aimed at one failure mode
 * produces the other (`fb_overrule_swap`): being too eager here strands users
 * with a dead token no reconnect clears, being too shy deletes living grants.
 */
function reclassifyForeignGrant(
  failure: RefreshFailureKind,
  mintedBy: string | undefined,
  presentedBy: string | undefined,
): RefreshFailureKind {
  if (failure !== 'grant-revoked') return failure;
  // Falsy, not `!== undefined`: every writer gates its stamp on truthiness, so
  // an empty string never means "minted by the empty client" — it means the
  // same as absent, and reading it as a mismatch would keep a dead token.
  if (!mintedBy || !presentedBy) return failure;
  return mintedBy === presentedBy ? failure : 'client-misconfigured';
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// === Service Account JWT ===

function createServiceAccountJWT(key: ServiceAccountKey, scopes: readonly string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const signingInput = segments.join('.');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key);

  return `${signingInput}.${base64url(signature)}`;
}

// === Success HTML ===

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>lynox</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.box{text-align:center;padding:2rem}h1{color:#4ade80;margin-bottom:.5rem}p{color:#888}</style></head>
<body><div class="box"><h1>Connected</h1><p>Google account linked to lynox. You can close this tab.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => {
  const escaped = msg
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<!DOCTYPE html><html><head><title>lynox</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.box{text-align:center;padding:2rem}h1{color:#ef4444;margin-bottom:.5rem}p{color:#888}</style></head>
<body><div class="box"><h1>Error</h1><p>${escaped}</p></div></body></html>`;
};

// === GoogleAuth Class ===

export class GoogleAuth {
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly serviceAccountKeyPath: string | undefined;
  private readonly vault: SecretVault | undefined;
  private readonly configuredScopes: readonly string[] | undefined;
  /**
   * Read by the four tool modules and by the mail provider, which make their
   * own Google calls with this object's access token — they need the same
   * policy view, and this object is the one thing every one of them already
   * holds. Public so they can read it; there is no setter, so nothing can widen
   * an instance's egress after construction.
   */
  readonly hostPolicy: HostPolicyContext | undefined;
  private tokenData: TokenData | null = null;
  private serviceAccountKey: ServiceAccountKey | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private serviceAccountTokenCache: { token: string; expires_at: number } | null = null;
  private serviceAccountTokenInFlight: Promise<string> | null = null;

  /**
   * The instance's OWN OAuth app credential, or a refusal.
   *
   * A brokered tenant has none: the control plane holds the pair, mints the
   * tokens and refreshes them, and the pair never reaches the tenant (PRD
   * Stage 1 §3.2). Every path that talks to Google's OAuth endpoints AS this
   * app therefore has to ask, and every one of them is a self-host path.
   *
   * It throws rather than returning null because the alternative is what the
   * type change replaced: posting `client_id=undefined` to Google and reading
   * whatever comes back as if it were about the user's grant. What Google
   * answers to that is not measured here, and does not need to be — the request
   * is a bug on our side and stops before it leaves.
   */
  /**
   * The self-host refresh: this instance's own pair, straight to Google.
   *
   * Split out of the ternary in `_doRefresh` so the pair requirement sits at
   * the top of the branch that needs it. A brokered token reaching here means
   * its sealed handle went missing, and the named refusal says so instead of
   * posting an empty `client_id` and reading Google's answer as a verdict on
   * the user's grant.
   */
  private async refreshDirect(refreshToken: string): Promise<Response> {
    const { clientId, clientSecret } = this.requireOwnPair('a direct token refresh');
    return googleFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(30_000),
    }, this.hostPolicy);
  }

  private requireOwnPair(caller: string): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        `${caller} needs this instance's own Google client pair, and there is none. `
        + 'A brokered connection is refreshed by the control plane; use the managed '
        + 'claim flow instead of the self-host OAuth entry points.',
      );
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  constructor(options: GoogleAuthOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.serviceAccountKeyPath = options.serviceAccountKeyPath;
    this.vault = options.vault;
    this.configuredScopes = options.scopes;
    this.hostPolicy = options.hostPolicy;
    this.tokenData = loadTokenData(this.vault);
  }

  /**
   * Check if authenticated (has valid or refreshable tokens).
   */
  isAuthenticated(): boolean {
    if (this.tokenData) return true;
    if (this.serviceAccountKeyPath) return true;
    return false;
  }

  /**
   * Get the current scopes.
   */
  getScopes(): string[] {
    return this.tokenData?.scopes ?? [];
  }

  /**
   * Check if a specific scope is authorized.
   */
  hasScope(scope: string): boolean {
    return this.tokenData?.scopes.includes(scope) ?? false;
  }

  /**
   * True when this credential holds a Google client pair of its own.
   *
   * The absence IS the mode: a brokered tenant never resolves a pair, because
   * the pair lives on the control plane. Callers use this to say something
   * true about where the tenant can widen its grant — NOT to decide whether a
   * refresh may run (that is `requireOwnPair`, which is about the token
   * endpoint, and which brokered refreshes deliberately never reach).
   */
  hasOwnClientPair(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  /**
   * Set tokens directly from an external OAuth broker (e.g. managed control plane).
   * Validates token structure and saves to vault.
   */
  async setTokens(data: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scopes: string[];
    /**
     * Set by the control plane's claim when it sealed the refresh token to this
     * instance. Carrying it here is what routes later refreshes through the CP;
     * dropping it silently would send them to Google with a client secret this
     * process is not supposed to have — and the failure would appear an hour
     * later, at the first expiry, with nothing pointing back to the claim.
     */
    refresh_handle?: string;
    /**
     * The Google account the grant belongs to (contract `OAuthClaimResponse`).
     *
     * Optional because a grant made before Stage 1 asked for `openid email` has
     * none, and absent means UNKNOWN rather than "no account". Stored so the
     * card can name the connection; NOTHING may key on it — addresses change,
     * and the connection row is what identifies a connection (§3.10).
     */
    email?: string;
  }): Promise<void> {
    if (typeof data.access_token !== 'string' || data.access_token.length < 10) {
      throw new Error('Invalid token data: access_token must be a string of at least 10 characters');
    }
    if (typeof data.refresh_token !== 'string' || data.refresh_token.length < 10) {
      throw new Error('Invalid token data: refresh_token must be a string of at least 10 characters');
    }
    if (typeof data.expires_at !== 'number' || !Number.isFinite(data.expires_at) || data.expires_at < Date.now() - 86_400_000) {
      throw new Error('Invalid token data: expires_at must be a valid future timestamp');
    }
    if (!Array.isArray(data.scopes) || data.scopes.length === 0 || !data.scopes.every((s) => typeof s === 'string' && s.length > 0)) {
      throw new Error('Invalid token data: scopes must be a non-empty array of strings');
    }
    this.tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      scopes: data.scopes,
      ...(data.refresh_handle ? { refresh_handle: data.refresh_handle } : {}),
      ...(data.email ? { email: data.email } : {}),
    };
    // A fresh grant ends the suppression. The cool-down exists so a fleet-wide
    // bad client secret cannot make every instance hammer Google forever; it is
    // not there to outlive the reconnect that resolves it. Without this line the
    // window kept refusing for up to five minutes after the user had already
    // done the one thing that fixes it.
    this._clientMisconfigured = null;
    saveTokenData(this.tokenData, this.vault);
  }

  /**
   * Accept tokens this process just minted itself, from any of the three OAuth
   * entry points.
   *
   * One method rather than the same three lines at each entry, because the
   * three had already drifted: `setTokens` above ends the suppression window on
   * a fresh grant and the minting flows did not, so a self-host operator who
   * corrected a client id and re-consented was still refused for up to five
   * minutes by a cool-down their reconnect had already resolved. That is the
   * same reasoning the comment above states — it just never reached here.
   *
   * `mintedBy` stays a parameter so each caller passes the id IT presented;
   * reading `this.clientId` in here would look identical and quietly assert a
   * provenance the caller had not established.
   */
  private _acceptMintedTokens(json: unknown, mintedBy: string): void {
    this.tokenData = validateTokenResponse(json, mintedBy);
    this._clientMisconfigured = null;
    saveTokenData(this.tokenData, this.vault);
  }

  /**
   * Get a valid access token, refreshing if needed.
   * For service accounts, generates a new JWT token.
   */
  async getAccessToken(): Promise<string> {
    // Service account path
    if (this.serviceAccountKeyPath && !this.tokenData) {
      return this._getServiceAccountToken();
    }

    if (!this.tokenData) {
      throw new Error('Not authenticated. Connect your Google account in Settings → Channels → Google.');
    }

    // Check if token needs refresh
    if (Date.now() >= this.tokenData.expires_at - TOKEN_REFRESH_BUFFER_MS) {
      await this._refreshToken();
    }

    return this.tokenData.access_token;
  }

  /**
   * Start localhost redirect OAuth flow.
   * Spins up a temporary HTTP server on a random port, opens browser,
   * waits for Google to redirect back with the auth code.
   */
  async startLocalAuth(scopes?: string[]): Promise<{ authUrl: string; waitForCode: () => Promise<void> }> {
    const { clientId, clientSecret } = this.requireOwnPair('startLocalAuth');
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;

    // Generate CSRF protection state
    const oauthState = randomUUID();

    // Start temporary HTTP server on random port
    const { port, codePromise, close } = await this._startCallbackServer(oauthState);
    const redirectUri = `http://localhost:${port}`;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requestedScopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: oauthState,
    });

    const authUrl = `${AUTH_URL}?${params}`;

    const waitForCode = async (): Promise<void> => {
      try {
        const code = await codePromise;
        // Exchange code for tokens
        const response = await googleFetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(30_000),
        }, this.hostPolicy);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Token exchange failed: ${response.status} ${text}`);
        }

        this._acceptMintedTokens(await response.json(), clientId);
      } finally {
        close();
      }
    };

    return { authUrl, waitForCode };
  }

  /**
   * Start redirect-based OAuth flow for web-hosted instances.
   * Returns an auth URL to redirect the user to. After consent, Google redirects
   * back to the provided redirectUri with an auth code. Call exchangeRedirectCode()
   * with the code to complete the flow.
   */
  startRedirectAuth(redirectUri: string, scopes?: string[]): { authUrl: string; state: string } {
    // Only the id reaches the consent URL; the guard is here for the refusal.
    const { clientId } = this.requireOwnPair('startRedirectAuth');
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;
    const state = randomUUID();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requestedScopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return { authUrl: `${AUTH_URL}?${params}`, state };
  }

  /**
   * Exchange an authorization code from redirect-based OAuth flow.
   */
  async exchangeRedirectCode(code: string, redirectUri: string): Promise<void> {
    const { clientId, clientSecret } = this.requireOwnPair('exchangeRedirectCode');
    const response = await googleFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(30_000),
    }, this.hostPolicy);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    this._acceptMintedTokens(await response.json(), clientId);
  }

  /**
   * Start device flow OAuth — for headless / Docker environments.
   * Returns a verification URL and user code. The user opens the URL in any browser,
   * enters the code, and the method polls until authorized.
   */
  async startDeviceFlow(scopes?: string[]): Promise<DeviceFlowPrompt & { waitForAuth: () => Promise<void> }> {
    const { clientId, clientSecret } = this.requireOwnPair('startDeviceFlow');
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;

    const response = await googleFetch(DEVICE_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: requestedScopes.join(' '),
      }),
      signal: AbortSignal.timeout(30_000),
    }, this.hostPolicy);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Device auth request failed: ${response.status} ${text}`);
    }

    const data = await response.json() as {
      device_code: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    };

    const pollInterval = Math.max((data.interval ?? 5) * 1000, DEVICE_POLL_INTERVAL_MS);

    const waitForAuth = async (): Promise<void> => {
      const deadline = Date.now() + DEVICE_TIMEOUT_MS;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));

        const tokenRes = await googleFetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            device_code: data.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: AbortSignal.timeout(30_000),
        }, this.hostPolicy);

        if (tokenRes.ok) {
          this._acceptMintedTokens(await tokenRes.json(), clientId);
          return;
        }

        const errorData = await tokenRes.json() as { error: string };
        if (errorData.error === 'authorization_pending') continue;
        if (errorData.error === 'slow_down') {
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }
        throw new Error(`Device auth failed: ${errorData.error}`);
      }

      throw new Error('Device auth timed out. Please try again.');
    };

    return {
      verificationUrl: data.verification_url,
      userCode: data.user_code,
      waitForAuth,
    };
  }

  /**
   * Request additional scopes via new auth flow.
   */
  async requestScope(additionalScopes: string[]): Promise<{ authUrl: string; waitForCode: () => Promise<void> } | null> {
    // Validate scope format — must be known Google scopes
    const invalid = additionalScopes.filter(s => !VALID_SCOPES.has(s));
    if (invalid.length > 0) {
      throw new Error(`Unknown Google OAuth scope(s): ${invalid.join(', ')}`);
    }

    const current = this.getScopes();
    const missing = additionalScopes.filter(s => !current.includes(s));
    if (missing.length === 0) return null;

    // Always include current scopes to prevent accidental downgrade
    const allScopes = [...new Set([...current, ...missing])];
    return this.startLocalAuth(allScopes);
  }

  /**
   * Revoke tokens and clean up.
   */
  async revoke(): Promise<void> {
    if (this.tokenData?.access_token) {
      try {
        await googleFetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: this.tokenData.access_token }),
          signal: AbortSignal.timeout(10_000),
        }, this.hostPolicy);
      } catch {
        // Best-effort revocation
      }
    }
    this.tokenData = null;
    deleteTokenData(this.vault);
  }

  /**
   * Drop the local grant WITHOUT revoking it at Google (D12).
   *
   * The switch-back path — a tenant giving up its own Google client for the
   * managed one — must not revoke: the grant is the USER's, revoking is
   * irreversible, and a leftover grant is harmless (Google keeps up to 100
   * live refresh tokens per account and client). Revoking here would also
   * destroy something on the strength of `broker_available`, which does not
   * predict whether the broker consent will succeed.
   *
   * `revoke()` is still the right call for an explicit disconnect, where
   * ending the grant IS what the user asked for.
   */
  disconnect(): void {
    this.tokenData = null;
    deleteTokenData(this.vault);
  }

  /**
   * Get token expiry time.
   */
  getTokenExpiry(): Date | null {
    if (!this.tokenData) return null;
    return new Date(this.tokenData.expires_at);
  }

  /**
   * Get account info.
   */
  getAccountInfo(): { scopes: string[]; expiresAt: Date | null; hasRefreshToken: boolean } {
    return {
      scopes: this.getScopes(),
      expiresAt: this.getTokenExpiry(),
      hasRefreshToken: !!this.tokenData?.refresh_token,
    };
  }

  // === Private Methods ===

  private _startCallbackServer(expectedState?: string): Promise<{ port: number; codePromise: Promise<string>; close: () => void }> {
    return new Promise((resolveSetup, rejectSetup) => {
      let resolveCode: ((code: string) => void) | null = null;
      let rejectCode: ((err: Error) => void) | null = null;

      const codePromise = new Promise<string>((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
      });

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML(error));
          rejectCode?.(new Error(`OAuth error: ${error}`));
          return;
        }

        // Validate CSRF state parameter
        if (expectedState) {
          const returnedState = url.searchParams.get('state');
          if (returnedState !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(ERROR_HTML('Invalid state parameter — possible CSRF attack.'));
            rejectCode?.(new Error('OAuth CSRF: state mismatch'));
            return;
          }
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(SUCCESS_HTML);
          resolveCode?.(code);
          return;
        }

        res.writeHead(404);
        res.end();
      });

      // Timeout — reject if user doesn't complete in time
      const timeout = setTimeout(() => {
        rejectCode?.(new Error('Auth timed out. Please try again.'));
        server.close();
      }, LOCALHOST_TIMEOUT_MS);

      const close = () => {
        clearTimeout(timeout);
        server.close();
      };

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          rejectSetup(new Error('Failed to start callback server'));
          return;
        }
        resolveSetup({ port: addr.port, codePromise, close });
      });

      server.on('error', (err) => {
        rejectSetup(err);
      });
    });
  }

  // Concurrent callers that hit the refresh window all share a single network
  // round-trip. Without this guard, N parallel getAccessToken() calls during
  // an expiry window fire N parallel refresh POSTs to Google, racing to set
  // tokenData and risking rate-limit responses on the refresh endpoint.
  private async _refreshToken(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this._doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * Set when Google rejected OUR client credentials; see `_doRefresh`.
   *
   * The remedy travels WITH the deadline rather than being looked up when the
   * suppression fires. The two paths blame different parties — this instance's
   * operator on the direct one, lynox on the control-plane one — and the choice
   * is made where the failure happens, with `cp` in scope. Re-deriving it later
   * would mean a second copy of that rule, and the copy is where they drift.
   */
  private _clientMisconfigured: { until: number; remedy: string } | null = null;

  private async _doRefresh(): Promise<void> {
    // Either credential can drive a refresh: the raw token on the direct path,
    // the sealed handle on the control-plane one. Requiring the raw token here
    // would make a handle-only token — the end state this arc is moving toward —
    // unrefreshable, and the failure would look like a revoked grant.
    if (!this.tokenData?.refresh_token && !this.tokenData?.refresh_handle) {
      throw new Error('No refresh token available. Re-connect your Google account in Settings → Channels → Google.');
    }

    // Keeping the token on `client-misconfigured` removed a circuit breaker
    // nobody had designed: the old wipe made the NEXT call fail locally at
    // `getAccessToken`, so a bad client secret stopped hitting Google after one
    // attempt. Without it, every caller retries — `oauth-gmail` asks per request
    // and its watcher ticks every 120 s — so a fleet-wide bad secret would turn
    // into every instance POSTing Google's token endpoint forever. The cool-down
    // restores the brake WITHOUT the data loss.
    //
    // A RECONNECT clears it — see `setTokens`. That is not a courtesy: when the
    // control plane refuses a handle minted under a different OAuth client, it
    // answers as a client problem so the token survives, and the user's remedy
    // for that is precisely to reconnect. Without the clear, the suppression
    // would outlast the very action that fixes it, for up to five minutes,
    // while telling the user the connection is still broken.
    //
    // Corrected CREDENTIALS are a different case and still need a restart:
    // `clientId`/`clientSecret` are readonly, so they arrive as a new
    // GoogleAuth — and `reloadGoogle()` swaps the engine's own `_googleAuth`
    // while `MailContext.googleAuth` stays bound at construction
    // (`mail/context.ts:258`), so the Gmail path keeps this instance until the
    // process restarts. That is the already-known `restart_required` limit of
    // `reloadGoogle`, inherited here rather than added.
    if (this._clientMisconfigured !== null && Date.now() < this._clientMisconfigured.until) {
      throw new Error(`Token refresh suppressed.${this._clientMisconfigured.remedy}`);
    }

    // Two ways to refresh. The control-plane one needs BOTH a sealed handle and
    // a complete control-plane identity in env — no flag and no version decides
    // it. Either missing takes the direct call below, which is unchanged for
    // self-host and for any claim that predates handles.
    //
    // Reusing `classifyRefreshFailure` for both paths assumes the CP passes
    // Google's status and error body through rather than rewriting them. The
    // wire contract does NOT state that today — it describes the success shape
    // only — so this is an expectation on the endpoint being built, written
    // here so it is not discovered by a misclassification later.
    const handle = this.tokenData.refresh_handle;
    const cp = handle ? readControlPlaneIdentity() : null;

    // The direct call below reads `refresh_token`. A handle-only token whose
    // control plane is unreachable — env incomplete, or a URL this build
    // refuses — would reach it with an EMPTY one, and Google answers 400
    // `invalid_grant`: indistinguishable here from a revoked grant, so the
    // grant would be deleted because we could not reach our own control plane.
    // Fail transient instead. The token survives; the next attempt can work.
    if (!(cp && handle) && this.tokenData.refresh_token === '') {
      throw new Error(
        'Token refresh failed: this instance cannot reach its control plane.'
        + REFRESH_FAILURE_REMEDY.transient,
      );
    }

    const response = cp && handle
      ? await cpFetch(cp.url, '/internal/oauth/google/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-instance-secret': cp.secret },
          body: JSON.stringify({
            instance_id: cp.instanceId,
            refresh_handle: handle,
          } satisfies OAuthRefreshRequest),
          // Redirects are not followed, and since §3.8 that is enforced by
          // `cpFetch` rather than requested here: it goes through `fetchPinned`,
          // which has no redirect handling at all. The `redirect: 'manual'`
          // that used to sit on this line became inert with that change, and an
          // inert option on a security-relevant call reads as the protection it
          // no longer is. The reason is unchanged: this request carries the
          // instance secret, `CROSS_ORIGIN_DROP_HEADERS` has no entry for
          // `x-instance-secret`, and a 3xx arrives as `!response.ok` below and
          // is classified as transient — so a CP that starts redirecting
          // degrades instead of leaking.
          signal: AbortSignal.timeout(30_000),
        }, this.hostPolicy)
      : await this.refreshDirect(this.tokenData.refresh_token);

    if (!response.ok) {
      const text = await response.text();
      // Wipe the vault ONLY when the grant itself is gone. A bad client
      // secret (`invalid_client`) and a network blip both leave the user's
      // grant intact, so both keep the token — see `classifyRefreshFailure`.
      //
      // The second step is the one the response cannot decide: an `invalid_grant`
      // from a client that did not mint this token is OUR misconfiguration, not
      // a revocation.
      //
      // Only the DIRECT path presented `this.clientId`; on the control-plane
      // path lynox's broker client did, and comparing the token against ours
      // there would answer a question nobody asked. An earlier version of this
      // comment claimed `this.clientId` is undefined on that path — it is not:
      // `cp` hangs on the refresh handle and the env identity, not on whether a
      // pair is configured, and a managed BYO tenant has one (`GOOGLE_CLIENT_*`
      // is customer-writable, `http-api.ts › CUSTOMER_WRITABLE_INFRA_PATTERNS`).
      // Passing `undefined` makes that true instead of asserting it.
      const presentedBy = cp && handle ? undefined : this.clientId;
      const classified = classifyRefreshFailure(response.status, text);
      const failure = reclassifyForeignGrant(classified, this.tokenData.client_id, presentedBy);
      // Kept as its own boolean rather than re-derived from `failure`: after the
      // reclassification the two causes are the same KIND, and only the step
      // that changed it knows which text belongs to the user.
      const foreignGrant = classified === 'grant-revoked' && failure === 'client-misconfigured';
      // Chosen ONCE, here, where `cp` says which client is actually invalid.
      // Not a new failure KIND, so not a new `REFRESH_FAILURE_REMEDY` entry:
      // the same classification with a different audience. On the direct path
      // the invalid client is this instance's own and an operator can fix it;
      // on the CP path it is lynox's, and naming the instance would send the
      // user after something they do not control. A foreign grant is a third
      // audience again: the credentials are valid, they are just not the ones
      // this token belongs to. It is tested first because it is the narrower
      // case — it can only arise on the direct path, where `cp` is null.
      const remedy = foreignGrant
        ? FOREIGN_GRANT_REMEDY
        : cp && failure === 'client-misconfigured'
          ? CP_CLIENT_MISCONFIGURED_REMEDY
          : REFRESH_FAILURE_REMEDY[failure];
      if (failure === 'grant-revoked') {
        this.tokenData = null;
        deleteTokenData(this.vault);
      } else if (failure === 'client-misconfigured') {
        // The remedy is stored with the deadline so every suppressed attempt in
        // the window repeats THIS answer, not the generic one. Two texts about
        // one situation, contradicting each other, is worse than either.
        this._clientMisconfigured = { until: Date.now() + CLIENT_MISCONFIGURED_COOLDOWN_MS, remedy };
      }
      throw new Error(`Token refresh failed: ${response.status} ${text}.${remedy}`);
    }

    if (cp && handle) {
      const body = validateControlPlaneRefresh(await response.json());
      this.tokenData = {
        ...this.tokenData,
        access_token: body.access_token,
        expires_at: body.expires_at,
        // Google may rotate the refresh token on any refresh. Dropping a
        // rotated handle would leave us presenting one Google has already
        // invalidated, and the failure would arrive at the NEXT refresh —
        // an hour later, with nothing pointing back to here.
        ...(body.refresh_handle ? { refresh_handle: body.refresh_handle } : {}),
      };
      saveTokenData(this.tokenData, this.vault);
      return;
    }

    const refreshed = validateTokenResponse(await response.json());
    // A rotated refresh token invalidates whatever the control plane sealed:
    // its handle stands for the token Google just replaced. Carrying it forward
    // would present an invalidated handle at the next CP refresh, which arrives
    // as `invalid_grant` — indistinguishable from a real revocation, so it would
    // delete a living grant. Drop it; a fresh claim seals a new one.
    const rotated = refreshed.refresh_token !== '' && refreshed.refresh_token !== this.tokenData.refresh_token;
    // Preserve refresh_token and scopes from previous auth if not returned.
    //
    // `client_id` is stamped here too, and this line is what makes the foreign-
    // grant check reach ALREADY-CONNECTED installs: their stored blob predates
    // the field, so it is UNKNOWN and the check stands down forever. A direct
    // refresh that Google just accepted under `this.clientId` is proof that this
    // pair owns the token — the same evidence the mint sites record, arriving
    // later. Without it the fix would only ever protect connections made after
    // it shipped, which is the smaller half of the fleet.
    this.tokenData = {
      ...this.tokenData,
      ...(this.clientId ? { client_id: this.clientId } : {}),
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || this.tokenData.refresh_token,
      expires_at: refreshed.expires_at,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : this.tokenData.scopes,
    };
    if (rotated) delete this.tokenData.refresh_handle;
    saveTokenData(this.tokenData, this.vault);
  }

  private _loadServiceAccountKey(): ServiceAccountKey {
    if (!this.serviceAccountKeyPath) {
      throw new Error('No service account key path configured.');
    }

    if (!isAbsolute(this.serviceAccountKeyPath)) {
      throw new Error(`Service account key path must be absolute: "${this.serviceAccountKeyPath}"`);
    }

    if (!existsSync(this.serviceAccountKeyPath)) {
      throw new Error(`Service account key file not found: "${this.serviceAccountKeyPath}"`);
    }

    // Validate file permissions on Unix (should be 0600 or 0400)
    if (process.platform !== 'win32') {
      const mode = statSync(this.serviceAccountKeyPath).mode & 0o777;
      if (mode !== 0o600 && mode !== 0o400) {
        process.stderr.write(
          `WARNING: Service account key file has loose permissions (${mode.toString(8)}). ` +
          `Expected 0600 or 0400. Run: chmod 600 "${this.serviceAccountKeyPath}"\n`,
        );
      }
    }

    const raw = readFileSync(this.serviceAccountKeyPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Service account key file contains invalid JSON.');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Service account key file must be a JSON object.');
    }
    const obj = parsed as Record<string, unknown>;
    const requiredFields = ['type', 'project_id', 'private_key', 'client_email'] as const;
    for (const field of requiredFields) {
      if (typeof obj[field] !== 'string' || obj[field] === '') {
        throw new Error(`Service account key file missing required field: "${field}"`);
      }
    }
    if (obj['type'] !== 'service_account') {
      throw new Error(`Service account key file has unexpected type: "${String(obj['type'])}". Expected "service_account".`);
    }

    // token_uri is used as a `fetch()` target when minting access tokens. A
    // crafted or tampered key file could redirect the JWT assertion (and its
    // implicit `aud` binding) to an internal address. Pin to Google's published
    // OAuth token endpoint — workload-identity-federation has its own flow and
    // does not reach this code path. Missing or empty also rejected (fail-closed).
    const tokenUri = typeof obj['token_uri'] === 'string' ? obj['token_uri'] : '';
    if (tokenUri !== 'https://oauth2.googleapis.com/token') {
      throw new Error(
        `Service account key has unexpected token_uri "${tokenUri}". ` +
        `Expected "https://oauth2.googleapis.com/token". Refusing to use this key.`,
      );
    }

    return parsed as ServiceAccountKey;
  }

  // Service-account access tokens are valid for ~1 hour, but the previous
  // implementation re-minted on every call (JWT sign + HTTPS round-trip per
  // Google API request). Cache the token until just before its expires_at,
  // and coalesce concurrent mints so N parallel callers share one round-trip.
  // Kept as its own state separate from refreshInFlight / _doRefresh — the
  // OAuth-user and SA paths have different lifetimes and identity, never
  // collapse the two into one cache.
  private async _getServiceAccountToken(): Promise<string> {
    if (
      this.serviceAccountTokenCache &&
      Date.now() < this.serviceAccountTokenCache.expires_at - TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.serviceAccountTokenCache.token;
    }
    if (this.serviceAccountTokenInFlight) {
      return this.serviceAccountTokenInFlight;
    }
    this.serviceAccountTokenInFlight = this._mintServiceAccountToken().finally(() => {
      this.serviceAccountTokenInFlight = null;
    });
    return this.serviceAccountTokenInFlight;
  }

  private async _mintServiceAccountToken(): Promise<string> {
    if (!this.serviceAccountKeyPath) {
      throw new Error('No service account key path configured.');
    }

    if (!this.serviceAccountKey) {
      this.serviceAccountKey = this._loadServiceAccountKey();
    }

    const jwt = createServiceAccountJWT(this.serviceAccountKey, this.configuredScopes ?? DEFAULT_SCOPES);

    const response = await googleFetch(this.serviceAccountKey.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(30_000),
    }, this.hostPolicy);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Service account token exchange failed: ${response.status} ${text}`);
    }

    const tokenData = validateTokenResponse(await response.json());
    this.serviceAccountTokenCache = {
      token: tokenData.access_token,
      expires_at: tokenData.expires_at,
    };
    return tokenData.access_token;
  }
}
