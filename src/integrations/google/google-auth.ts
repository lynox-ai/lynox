import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { OAuthRefreshRequest, OAuthRefreshResponse } from '../../contract/http.js';
import { createSign, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { SecretVault } from '../../core/secret-vault.js';

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
}

/**
 * The three values a managed instance needs to reach its control plane, or null
 * when any is missing.
 *
 * All three or none, deliberately: a partially configured instance must take
 * the direct path rather than build a half-formed request. The same env names
 * `managed-hook.ts` uses — the engine has exactly one identity toward the CP.
 */
function readControlPlaneIdentity(): { url: string; instanceId: string; secret: string } | null {
  const rawUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';
  if (!rawUrl || !instanceId || !secret) return null;
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
  // Credentials in the base would authenticate the request somewhere the
  // operator did not mean; `origin` drops them silently, so refuse instead.
  if (parsed.username !== '' || parsed.password !== '') return null;
  // `origin + pathname` cannot carry a query, a fragment or credentials by
  // construction. With all three refused above it is byte-equal to `href`
  // for every value that reaches here — the two are belt and braces, and
  // that is deliberate: the string check states the intent, this makes it
  // structural.
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
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
  clientId: string;
  clientSecret: string;
  serviceAccountKeyPath?: string | undefined;
  vault?: SecretVault | undefined;
  /** Override default OAuth scopes. Defaults to READ_ONLY_SCOPES. */
  scopes?: string[] | undefined;
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
export const SCOPES = {
  GMAIL_READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
  GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  SHEETS_READONLY: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  SHEETS: 'https://www.googleapis.com/auth/spreadsheets',
  DRIVE_READONLY: 'https://www.googleapis.com/auth/drive.readonly',
  DRIVE_FILE: 'https://www.googleapis.com/auth/drive.file',
  DRIVE: 'https://www.googleapis.com/auth/drive',
  CALENDAR_READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
  CALENDAR_EVENTS: 'https://www.googleapis.com/auth/calendar.events',
  DOCS_READONLY: 'https://www.googleapis.com/auth/documents.readonly',
  DOCS: 'https://www.googleapis.com/auth/documents',
} as const;

/** Read-only scopes — safe default for initial auth. */
export const READ_ONLY_SCOPES = [
  SCOPES.GMAIL_READONLY,
  SCOPES.SHEETS_READONLY,
  SCOPES.DRIVE_READONLY,
  SCOPES.CALENDAR_READONLY,
  SCOPES.DOCS_READONLY,
] as const;

/** Write scopes — opt-in via config or requestScope(). */
export const WRITE_SCOPES = [
  SCOPES.GMAIL_SEND,
  SCOPES.GMAIL_MODIFY,
  SCOPES.SHEETS,
  SCOPES.DRIVE,
  SCOPES.DRIVE_FILE,
  SCOPES.CALENDAR_EVENTS,
  SCOPES.DOCS,
] as const;

/** Default scopes for initial auth — read-only for security. */
const DEFAULT_SCOPES: readonly string[] = READ_ONLY_SCOPES;

/** All known valid Google OAuth scopes. */
const VALID_SCOPES = new Set<string>([...READ_ONLY_SCOPES, ...WRITE_SCOPES]);

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

/** Validate a token response from Google and convert to TokenData. */
function validateTokenResponse(json: unknown): TokenData {
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
 * foreign — reported as `invalid_grant`, indistinguishable here from a real
 * revocation, because `TokenData` does not record the id that minted it. That
 * case still deletes. Closing it needs the minting `client_id` persisted.
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
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly serviceAccountKeyPath: string | undefined;
  private readonly vault: SecretVault | undefined;
  private readonly configuredScopes: readonly string[] | undefined;
  private tokenData: TokenData | null = null;
  private serviceAccountKey: ServiceAccountKey | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private serviceAccountTokenCache: { token: string; expires_at: number } | null = null;
  private serviceAccountTokenInFlight: Promise<string> | null = null;

  constructor(options: GoogleAuthOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.serviceAccountKeyPath = options.serviceAccountKeyPath;
    this.vault = options.vault;
    this.configuredScopes = options.scopes;
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
    };
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
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;

    // Generate CSRF protection state
    const oauthState = randomUUID();

    // Start temporary HTTP server on random port
    const { port, codePromise, close } = await this._startCallbackServer(oauthState);
    const redirectUri = `http://localhost:${port}`;

    const params = new URLSearchParams({
      client_id: this.clientId,
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
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Token exchange failed: ${response.status} ${text}`);
        }

        this.tokenData = validateTokenResponse(await response.json());
        saveTokenData(this.tokenData, this.vault);
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
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;
    const state = randomUUID();

    const params = new URLSearchParams({
      client_id: this.clientId,
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
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    this.tokenData = validateTokenResponse(await response.json());
    saveTokenData(this.tokenData, this.vault);
  }

  /**
   * Start device flow OAuth — for headless / Docker environments.
   * Returns a verification URL and user code. The user opens the URL in any browser,
   * enters the code, and the method polls until authorized.
   */
  async startDeviceFlow(scopes?: string[]): Promise<DeviceFlowPrompt & { waitForAuth: () => Promise<void> }> {
    const requestedScopes = scopes ?? this.configuredScopes ?? DEFAULT_SCOPES;

    const response = await fetch(DEVICE_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: requestedScopes.join(' '),
      }),
      signal: AbortSignal.timeout(30_000),
    });

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

        const tokenRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            device_code: data.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (tokenRes.ok) {
          this.tokenData = validateTokenResponse(await tokenRes.json());
          saveTokenData(this.tokenData, this.vault);
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
        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: this.tokenData.access_token }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Best-effort revocation
      }
    }
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

  /** Set when Google rejected OUR client credentials; see `_doRefresh`. */
  private _clientMisconfiguredUntil: number | null = null;

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
    // It dies with the instance — `clientId`/`clientSecret` are readonly, so
    // corrected credentials arrive as a new GoogleAuth. That is NOT the same as
    // "a fix always clears it": `reloadGoogle()` swaps the engine's own
    // `_googleAuth`, but `MailContext.googleAuth` is readonly and bound at
    // construction (`mail/context.ts:258`), so the Gmail path keeps this
    // instance — and this window — until the process restarts. That is the
    // already-known `restart_required` limitation of `reloadGoogle`, not
    // something the cool-down adds; it just inherits it.
    if (this._clientMisconfiguredUntil !== null && Date.now() < this._clientMisconfiguredUntil) {
      throw new Error(`Token refresh suppressed.${REFRESH_FAILURE_REMEDY['client-misconfigured']}`);
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
      ? await fetch(`${cp.url}/internal/oauth/google/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-instance-secret': cp.secret },
          body: JSON.stringify({
            instance_id: cp.instanceId,
            refresh_handle: handle,
          } satisfies OAuthRefreshRequest),
          // Do not follow redirects: `fetch` replays request headers on a
          // same-origin hop and this request carries the instance secret. A 3xx
          // arrives as `!response.ok` below and is classified as transient, so
          // a CP that starts redirecting degrades instead of leaking.
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
      : await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: this.tokenData.refresh_token,
            grant_type: 'refresh_token',
          }),
          signal: AbortSignal.timeout(30_000),
        });

    if (!response.ok) {
      const text = await response.text();
      // Wipe the vault ONLY when the grant itself is gone. A bad client
      // secret (`invalid_client`) and a network blip both leave the user's
      // grant intact, so both keep the token — see `classifyRefreshFailure`.
      const failure = classifyRefreshFailure(response.status, text);
      if (failure === 'grant-revoked') {
        this.tokenData = null;
        deleteTokenData(this.vault);
      } else if (failure === 'client-misconfigured') {
        this._clientMisconfiguredUntil = Date.now() + CLIENT_MISCONFIGURED_COOLDOWN_MS;
      }
      // The remedy text is written for the direct path, where the invalid client
      // is this instance's own. On the CP path it is lynox's shared client, so
      // telling the user an operator must fix THIS instance would send them
      // after the wrong thing — the cool-down still applies either way.
      // Not a new failure KIND, so not a new `REFRESH_FAILURE_REMEDY` entry:
      // the same classification with a different audience. On the direct path
      // the invalid client is this instance's own and an operator can fix it;
      // on the CP path it is lynox's, and naming the instance would send the
      // user after something they do not control. It says only that, because
      // nothing here reports the failure anywhere.
      const remedy = cp && failure === 'client-misconfigured'
        ? ' Your Google connection is intact — lynox could not complete the refresh.'
        : REFRESH_FAILURE_REMEDY[failure];
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
    // Preserve refresh_token and scopes from previous auth if not returned
    this.tokenData = {
      ...this.tokenData,
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

    const response = await fetch(this.serviceAccountKey.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal: AbortSignal.timeout(30_000),
    });

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
