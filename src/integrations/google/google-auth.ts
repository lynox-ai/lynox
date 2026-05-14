import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createSign, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { SecretVault } from '../../core/secret-vault.js';

// === Types ===

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scopes: string[];
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

/**
 * Classify a /token refresh failure as permanent (refresh token itself
 * is dead → wipe the vault) vs transient (503/429/network → keep the
 * token, surface a retry-friendly error).
 *
 * Google returns a JSON body like `{"error":"invalid_grant", ...}` for
 * permanent failures and a 4xx/5xx status with no useful body or
 * different `error` codes for transient ones. Anchoring on the `error`
 * field is what every Google client library does; the HTTP status
 * alone is ambiguous (invalid_grant returns 400 just like a transient
 * billing-limit-exceeded would). See memory
 * `feedback_oauth_refresh_token_loss.md`.
 */
function isPermanentRefreshFailure(httpStatus: number, body: string): boolean {
  if (httpStatus >= 500 || httpStatus === 429) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      return parsed.error === 'invalid_grant' || parsed.error === 'invalid_client';
    }
  } catch {
    // Non-JSON body — Google may be returning an HTML error page from a
    // proxy. Don't wipe the token on the basis of unparseable output.
    return false;
  }
  // 4xx with a JSON body that doesn't say invalid_grant/invalid_client →
  // unknown failure mode. Conservative default: keep the token, force
  // an explicit re-auth only on the recognised permanent codes.
  return false;
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

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>LYNOX</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.box{text-align:center;padding:2rem}h1{color:#4ade80;margin-bottom:.5rem}p{color:#888}</style></head>
<body><div class="box"><h1>Connected</h1><p>Google account linked to LYNOX. You can close this tab.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => {
  const escaped = msg
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<!DOCTYPE html><html><head><title>LYNOX</title>
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
      throw new Error('Not authenticated. Connect your Google account in Settings → Integrations.');
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
   * Start device flow OAuth — for headless/Docker/Telegram environments.
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

  private async _doRefresh(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      throw new Error('No refresh token available. Re-connect your Google account in Settings → Integrations.');
    }

    const response = await fetch(TOKEN_URL, {
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
      // Only wipe the vault when Google says the refresh token itself is
      // dead (invalid_grant) or our client credentials are bad
      // (invalid_client). Transient errors — 503, 429, network blips — used
      // to delete the token too, forcing the user back through the full
      // OAuth flow for what was a recoverable failure (memory:
      // `feedback_oauth_refresh_token_loss.md`).
      const isPermanent = isPermanentRefreshFailure(response.status, text);
      if (isPermanent) {
        this.tokenData = null;
        deleteTokenData(this.vault);
      }
      throw new Error(`Token refresh failed: ${response.status} ${text}.${isPermanent ? ' Re-connect your Google account in Settings → Integrations.' : ' Retry in a moment — the refresh token is still on file.'}`);
    }

    const refreshed = validateTokenResponse(await response.json());
    // Preserve refresh_token and scopes from previous auth if not returned
    this.tokenData = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || this.tokenData.refresh_token,
      expires_at: refreshed.expires_at,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : this.tokenData.scopes,
    };
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
