import type { OAuthRefreshRequest } from '../../contract/http.js';
import type { SecretVault } from '../../core/secret-vault.js';
import type { HostPolicyContext } from '../../core/network-guard.js';
import { cpFetch } from '../../core/connector-egress.js';
import { readControlPlaneIdentity, validateControlPlaneRefresh } from '../../core/control-plane-client.js';
import {
  MICROSOFT_REFRESH_CODES,
  readMicrosoftRefreshFailure,
  type MicrosoftRefreshFailureKind,
} from '../../core/oauth-refresh-failure.js';
import { MICROSOFT_OAUTH_TOKENS_KEY } from './vault-keys.js';

/**
 * A Microsoft 365 mailbox grant, held by the engine and refreshed through the
 * control plane.
 *
 * Narrower than `GoogleAuth` on purpose. Microsoft is brokered only: the control
 * plane keeps lynox's client secret AND the refresh token, and hands this
 * process a sealed `refresh_handle` (contract `OAuthHandleClaimResponse`).
 * There is no direct path to Microsoft's token endpoint and no raw refresh token
 * anywhere in this file — so an instance without a control plane cannot refresh
 * at all, and says so instead of guessing.
 *
 * Failures of the refresh are read by `readMicrosoftRefreshFailure`
 * (`oauth-refresh-failure.ts`), never by a second parser here. Only one verdict
 * empties the vault: `grant-revoked`. Every other one keeps the grant and names
 * who has to act.
 */

interface TokenData {
  access_token: string;
  /** The refresh token sealed to this instance by the control plane. Opaque. */
  refresh_handle: string;
  /** Absolute expiry of `access_token`, epoch milliseconds. */
  expires_at: number;
  scopes: string[];
  /** The directory tenant the grant belongs to. */
  tid: string;
  /** For display only, never an identifier. Absent means unknown. */
  email?: string;
}

/** Why the stored grant changed. `refresh` keeps the grant; it is not a new consent. */
export type MicrosoftTokenChangeReason = 'grant' | 'refresh' | 'disconnect';

export interface MicrosoftTokenChange {
  reason: MicrosoftTokenChangeReason;
  /** The stored grant after the change, or `null` when it was removed. */
  tokenData: {
    readonly scopes: readonly string[];
    readonly tid: string;
    readonly email?: string | undefined;
    readonly expires_at: number;
  } | null;
}

export interface MicrosoftAuthOptions {
  vault?: SecretVault | undefined;
  /** The live host-policy view; the refresh is a connector call and obeys it. */
  hostPolicy?: HostPolicyContext | undefined;
  /**
   * Announce that the stored grant changed, so a mirror of it (the connection
   * row) can follow. A mirror, not a gate: the vault write has happened when
   * this fires, and a throw from it is swallowed.
   */
  onTokenChange?: ((event: MicrosoftTokenChange) => void) | undefined;
}

/**
 * What the settings card shows for the last refresh failure. Each value is one
 * state of the mail card; the card itself is built later, this is its input.
 *
 * - `revoked` — access was withdrawn; the grant is gone, connect again.
 * - `sign-in` — Microsoft asks the user to sign in again; the grant is kept.
 * - `not-assigned` — the user is not assigned to the app, or a policy blocks the
 *   sign-in (50105, 53003); only the admin can change that.
 * - `account-disabled` — the account is disabled (50057); only the admin can
 *   re-enable it, so "sign in again" would be the wrong advice.
 * - `app-not-in-tenant` — the app is not installed in the tenant (700016): the
 *   admin removed it or never consented; the admin consent fixes it.
 * - `lynox-error` — our own client registration was refused; nothing for the
 *   user to do.
 * - `retrying` — a passing failure; nothing to show beyond a retry.
 */
export type MicrosoftCardState =
  | 'revoked'
  | 'sign-in'
  | 'not-assigned'
  | 'account-disabled'
  | 'app-not-in-tenant'
  | 'lynox-error'
  | 'retrying';

/**
 * The card state for a refresh verdict and the codes it was decided on.
 *
 * A `switch` that ends in `never`, so a verdict added to
 * `MicrosoftRefreshFailureKind` without a state here is a compile error, not a
 * card that silently shows nothing.
 *
 * For `needs-admin` the deciding code is the first one on the needs-admin list,
 * not the first in the body: the body may carry other numbers before it.
 */
export function microsoftCardState(kind: MicrosoftRefreshFailureKind, codes: readonly number[]): MicrosoftCardState {
  switch (kind) {
    case 'grant-revoked':
      return 'revoked';
    case 'needs-user':
      return 'sign-in';
    case 'needs-admin': {
      const deciding = decidingErrorCode(kind, codes);
      if (deciding === 50057) return 'account-disabled';
      if (deciding === 700016) return 'app-not-in-tenant';
      return 'not-assigned';
    }
    case 'client-misconfigured':
      return 'lynox-error';
    case 'transient':
      return 'retrying';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/**
 * The error number to quote for a verdict: the one the verdict was decided on
 * where a list decided it (`needs-admin`, `grant-revoked`), otherwise the first
 * in the body. Quoting the first number blindly would name a code the card did
 * not act on, next to a card state that came from another one.
 */
export function decidingErrorCode(kind: MicrosoftRefreshFailureKind, codes: readonly number[]): number | null {
  const onList = (list: readonly number[]): number | undefined => codes.find((c) => list.includes(c));
  if (kind === 'needs-admin') return onList(MICROSOFT_REFRESH_CODES.needsAdmin) ?? codes[0] ?? null;
  if (kind === 'grant-revoked') return onList(MICROSOFT_REFRESH_CODES.grantRevoked) ?? codes[0] ?? null;
  return codes[0] ?? null;
}

/**
 * The sentence appended to a refresh error, per verdict. A `Record` over the
 * union, so a verdict without a sentence does not compile.
 *
 * These strings reach the model inside tool results, so they name no
 * credential and quote nothing Microsoft wrote: only the error number, which
 * the caller appends where there is one.
 */
const MICROSOFT_REFRESH_REMEDY: Record<MicrosoftRefreshFailureKind, string> = {
  'grant-revoked': ' Access to the Microsoft 365 mailbox was withdrawn. Connect the mailbox again in the mail settings.',
  'needs-user': ' Microsoft asks for a new sign-in. Connect the mailbox again in the mail settings; the connection is kept until then.',
  'needs-admin': ' Only the Microsoft 365 admin of this organisation can fix this. The connection is kept.',
  'client-misconfigured': ' The Microsoft connection is intact; lynox could not complete the refresh.',
  transient: ' Retry in a moment; the connection is still on file.',
};

/**
 * How long a verdict that retrying cannot fix suppresses further refreshes:
 * `client-misconfigured`, `needs-user`, `needs-admin`. Longer than the 120 s
 * mail-watch tick, so the brake holds for the caller that polls on its own. A
 * new grant ends it at once.
 */
const PERMANENT_FAILURE_COOLDOWN_MS = 300_000;

/** The longest `Retry-After` honoured on a 429; a larger value is capped, not trusted. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Refresh this long before the access token expires. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** The widest access-token lifetime a claim may carry. */
const MAX_CLAIM_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** A display address longer than this is not stored. */
const MAX_EMAIL_LENGTH = 320;

/** The last refused refresh, as the card reads it. */
export interface MicrosoftRefreshFailure {
  kind: MicrosoftRefreshFailureKind;
  /** The `error_codes` number the verdict was decided on ({@link decidingErrorCode}); null when there was none. */
  firstErrorCode: number | null;
  cardState: MicrosoftCardState;
  /** Epoch milliseconds. */
  at: number;
}

function parseTokenData(raw: string): TokenData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Record<string, unknown>;
    if (typeof data['access_token'] !== 'string' || data['access_token'] === '') return null;
    if (typeof data['refresh_handle'] !== 'string' || data['refresh_handle'] === '') return null;
    if (typeof data['expires_at'] !== 'number' || !Number.isFinite(data['expires_at'])) return null;
    if (!Array.isArray(data['scopes']) || !data['scopes'].every((s: unknown) => typeof s === 'string')) return null;
    if (typeof data['tid'] !== 'string' || data['tid'] === '') return null;
    if (data['email'] !== undefined && typeof data['email'] !== 'string') return null;
    return parsed as TokenData;
  } catch {
    return null;
  }
}

/**
 * Validate a claim from the control plane. Throws on anything the contract does
 * not allow; `provider` must be the one this class serves, so a claim for
 * another broker never lands in this slot.
 */
function validateClaim(claim: unknown): TokenData {
  const bad = (why: string): never => {
    throw new Error(`Invalid Microsoft claim: ${why}`);
  };
  if (typeof claim !== 'object' || claim === null) return bad('not an object');
  const c = claim as Record<string, unknown>;
  if (c['provider'] !== 'microsoft') return bad('provider is not microsoft');
  const accessToken = c['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length < 10) return bad('access_token missing or too short');
  const handle = c['refresh_handle'];
  if (typeof handle !== 'string' || handle === '') return bad('refresh_handle missing');
  const expiresAt = c['expires_at'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return bad('expires_at is not a number');
  const now = Date.now();
  if (expiresAt <= now || expiresAt > now + MAX_CLAIM_TOKEN_LIFETIME_MS) return bad('expires_at outside the plausible range');
  const scopes = c['scopes'];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s: unknown) => typeof s === 'string' && s !== '')) {
    return bad('scopes must be a non-empty array of strings');
  }
  const tid = c['tid'];
  if (typeof tid !== 'string' || tid === '') return bad('tid missing');
  const email = c['email'];
  if (email !== undefined && typeof email !== 'string') return bad('email is not a string');
  return {
    access_token: accessToken,
    refresh_handle: handle,
    expires_at: expiresAt,
    scopes: scopes as string[],
    tid,
    // Kept only when it is a plausible display value; dropping an odd one costs
    // the card an address, keeping it would store an unbounded string.
    ...(typeof email === 'string' && email !== '' && email.length <= MAX_EMAIL_LENGTH ? { email } : {}),
  };
}

/** `Retry-After` in milliseconds, from seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - now, 0), MAX_RETRY_AFTER_MS);
}

export class MicrosoftAuth {
  private readonly vault: SecretVault | undefined;
  /** Read-only, like `GoogleAuth.hostPolicy`: the mail provider's Graph calls obey the same view. */
  readonly hostPolicy: HostPolicyContext | undefined;
  private readonly onTokenChange: ((event: MicrosoftTokenChange) => void) | undefined;
  private tokenData: TokenData | null;
  private refreshInFlight: Promise<void> | null = null;
  /**
   * Set by a verdict retrying cannot fix. The sentence travels with the
   * deadline, so every refused attempt in the window repeats the same answer.
   */
  private suppressed: { until: number; message: string } | null = null;
  private lastFailure: MicrosoftRefreshFailure | null = null;

  constructor(options: MicrosoftAuthOptions) {
    this.vault = options.vault;
    this.hostPolicy = options.hostPolicy;
    this.onTokenChange = options.onTokenChange;
    const raw = this.vault?.get(MICROSOFT_OAUTH_TOKENS_KEY) ?? null;
    this.tokenData = raw ? parseTokenData(raw) : null;
    if (raw && this.tokenData === null) {
      // Not deleted: an unreadable blob is not a revoked grant, and a reconnect
      // overwrites it. Loud, so a format drift is not discovered as "logged out".
      console.warn('[lynox] Microsoft grant in the vault is unreadable; treating the mailbox as not connected.');
    }
  }

  /** Whether a grant is stored. Says nothing about whether it still refreshes. */
  isConnected(): boolean {
    return this.tokenData !== null;
  }

  getAccountInfo(): { scopes: string[]; tid: string; email: string | null; expiresAt: Date } | null {
    if (!this.tokenData) return null;
    return {
      scopes: [...this.tokenData.scopes],
      tid: this.tokenData.tid,
      email: this.tokenData.email ?? null,
      expiresAt: new Date(this.tokenData.expires_at),
    };
  }

  /** The last refused refresh, or null when the last attempt succeeded or none was made. */
  getLastRefreshFailure(): MicrosoftRefreshFailure | null {
    return this.lastFailure;
  }

  /**
   * Store a grant handed over by the control plane's claim. Ends any
   * suppression and clears the last failure: a new grant is the remedy for
   * every verdict that keeps the old one.
   */
  acceptClaim(claim: unknown): void {
    const data = validateClaim(claim);
    if (!this.vault) {
      throw new Error('Cannot store the Microsoft grant without a vault. Set LYNOX_VAULT_KEY to enable the vault.');
    }
    this.persist(data, 'grant');
    this.suppressed = null;
    this.lastFailure = null;
  }

  /** A valid access token, refreshed through the control plane when it is about to expire. */
  async getAccessToken(): Promise<string> {
    if (!this.tokenData) {
      throw new Error('Not connected. Connect the Microsoft 365 mailbox in the mail settings.');
    }
    if (Date.now() >= this.tokenData.expires_at - TOKEN_REFRESH_BUFFER_MS) {
      try {
        await this.refresh();
      } catch (err: unknown) {
        // The refresh starts early. A refusal inside that margin does not make
        // the token in hand invalid: while it is still valid it is used, and the
        // verdict stays on record for the card. A revoked grant is gone by now
        // and falls through to the throw.
        const held = this.tokenData as TokenData | null;
        if (held !== null && Date.now() < held.expires_at) return held.access_token;
        throw err;
      }
    }
    // Re-read: the grant may have been dropped (a disconnect, or a revocation
    // seen by another caller) while this one was waiting.
    const current = this.tokenData as TokenData | null;
    if (current === null) throw new Error('Not connected. Connect the Microsoft 365 mailbox in the mail settings.');
    return current.access_token;
  }

  /**
   * Drop the local grant. There is no revoke route for Microsoft in the
   * contract yet, so this does not end the grant at Microsoft: the user or the
   * admin removes the app there. The caller says so.
   */
  disconnect(): void {
    this.drop();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const grant = this.tokenData;
    if (!grant) throw new Error('Not connected. Connect the Microsoft 365 mailbox in the mail settings.');

    if (this.suppressed !== null && Date.now() < this.suppressed.until) {
      throw new Error(`Token refresh suppressed.${this.suppressed.message}`);
    }

    // Brokered only. Without a complete control-plane identity there is no way
    // to refresh, and that is a reachability problem, not a verdict on the grant.
    const cp = readControlPlaneIdentity();
    if (cp === null) {
      throw new Error(`Token refresh failed: this instance cannot reach its control plane.${MICROSOFT_REFRESH_REMEDY.transient}`);
    }

    const response = await cpFetch(cp.url, '/internal/oauth/microsoft/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-instance-secret': cp.secret },
      body: JSON.stringify({
        instance_id: cp.instanceId,
        refresh_handle: grant.refresh_handle,
      } satisfies OAuthRefreshRequest),
      signal: AbortSignal.timeout(30_000),
    }, this.hostPolicy);

    if (!response.ok) {
      // The control plane passes Microsoft's status and body through unchanged
      // (contract `OAuthRefreshRequest`), which is what lets this read them.
      const text = await response.text();
      this.assertStillCurrent(grant);
      const { kind, codes } = readMicrosoftRefreshFailure(response.status, text);
      const firstErrorCode = decidingErrorCode(kind, codes);
      const now = Date.now();
      this.lastFailure = { kind, firstErrorCode, cardState: microsoftCardState(kind, codes), at: now };
      // Status and the error number only. The body is Microsoft's, open-ended,
      // and would reach the model through a tool result.
      const reference = firstErrorCode === null ? '' : ` (Microsoft error ${firstErrorCode})`;
      const message = `${MICROSOFT_REFRESH_REMEDY[kind]}${reference}`;
      if (kind === 'grant-revoked') {
        this.drop();
      } else if (kind === 'client-misconfigured' || kind === 'needs-user' || kind === 'needs-admin') {
        this.suppressed = { until: now + PERMANENT_FAILURE_COOLDOWN_MS, message };
      } else if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'), now);
        if (wait !== null && wait > 0) this.suppressed = { until: now + wait, message };
      }
      throw new Error(`Token refresh failed: ${response.status}.${message}`);
    }

    const json: unknown = await response.json();
    this.assertStillCurrent(grant);
    const body = validateControlPlaneRefresh(json, MICROSOFT_REFRESH_REMEDY.transient);
    // Microsoft rotates the refresh token on every refresh. A handle that is
    // not replaced keeps working until the old token's lifetime ends, then fails
    // without warning; so a rotated one always replaces the stored one.
    this.persist({
      ...grant,
      access_token: body.access_token,
      expires_at: body.expires_at,
      ...(body.refresh_handle ? { refresh_handle: body.refresh_handle } : {}),
    }, 'refresh');
    this.lastFailure = null;
  }

  /**
   * Refuse to act on an answer for a grant that is no longer the stored one.
   *
   * The refresh is out for up to 30 s. A reconnect (`acceptClaim`) or a
   * `disconnect` in that window replaces or removes the grant it was sent for;
   * writing its answer back would undo the reconnect, resurrect the
   * disconnected grant, or — on a revocation of the OLD handle — delete the new
   * one. So the answer is dropped, nothing is written, braked or recorded.
   */
  private assertStillCurrent(sentFor: TokenData): void {
    if (this.tokenData !== sentFor) {
      throw new Error('Token refresh discarded: the Microsoft connection was replaced or removed while the refresh was out. Ask for the token again; it reports the current state.');
    }
  }

  /**
   * Persist a grant AND announce it: the only way this class writes one. The
   * vault is written first, so a failed write leaves memory and vault on the
   * same grant instead of memory holding a handle the vault never saw.
   */
  private persist(data: TokenData, reason: 'grant' | 'refresh'): void {
    if (!this.vault) throw new Error('Cannot store the Microsoft grant without a vault.');
    this.vault.set(MICROSOFT_OAUTH_TOKENS_KEY, JSON.stringify(data), 'any');
    this.tokenData = data;
    this.announce(reason);
  }

  /** Drop the grant AND announce it: the only way this class clears one. */
  private drop(): void {
    this.tokenData = null;
    this.vault?.delete(MICROSOFT_OAUTH_TOKENS_KEY);
    this.announce('disconnect');
  }

  private announce(reason: MicrosoftTokenChangeReason): void {
    if (!this.onTokenChange) return;
    try {
      this.onTokenChange({
        reason,
        tokenData: this.tokenData === null ? null : {
          scopes: this.tokenData.scopes,
          tid: this.tokenData.tid,
          email: this.tokenData.email,
          expires_at: this.tokenData.expires_at,
        },
      });
    } catch (err: unknown) {
      console.warn(`[lynox] Microsoft token-change hook failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
