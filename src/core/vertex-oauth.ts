/**
 * Google Vertex AI OAuth token provider.
 *
 * Generates short-lived OAuth access tokens from a GCP service account,
 * used to authenticate to Vertex AI's OpenAI-compatible endpoint.
 *
 * The google-auth-library handles token caching and auto-refresh internally —
 * we just call `getAccessToken()` before each request and let it decide whether
 * to use a cached token or fetch a fresh one.
 */

import type { ApiKeyProvider } from './openai-adapter.js';

/** Lazy-loaded GoogleAuth constructor — only imported when vertex OAuth is actually used. */
type GoogleAuthCtor = new (opts: { scopes: string[]; keyFile?: string | undefined; credentials?: object | undefined }) => {
  getClient(): Promise<{ getAccessToken(): Promise<{ token?: string | null | undefined }> }>;
};

let _googleAuthCtor: GoogleAuthCtor | null = null;

async function loadGoogleAuth(): Promise<GoogleAuthCtor> {
  if (_googleAuthCtor) return _googleAuthCtor;
  try {
    const mod = await import('google-auth-library');
    _googleAuthCtor = (mod.GoogleAuth ?? (mod as unknown as { default: { GoogleAuth: GoogleAuthCtor } }).default.GoogleAuth) as GoogleAuthCtor;
    return _googleAuthCtor;
  } catch {
    throw new Error(
      'Vertex AI OAuth requires google-auth-library. Install it with:\n' +
      '  pnpm add google-auth-library\n' +
      'Then configure credentials via GOOGLE_APPLICATION_CREDENTIALS env var.',
    );
  }
}

/**
 * Create an API key provider that returns fresh OAuth tokens for Vertex AI.
 *
 * The token provider is a function the adapter calls before each request.
 * google-auth-library caches tokens internally and refreshes automatically
 * when they're about to expire (tokens live for ~1 hour).
 *
 * Credentials resolution (first match wins):
 *   1. keyFile option (explicit path)
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON)
 *   3. gcloud Application Default Credentials (local dev)
 *   4. GCE/GKE metadata service (when running on GCP)
 */
export function createVertexOAuthProvider(opts: { keyFile?: string | undefined } = {}): ApiKeyProvider {
  let authInstance: Awaited<ReturnType<GoogleAuthCtor['prototype']['getClient']>> extends infer _C ? Promise<InstanceType<GoogleAuthCtor>> | null : never = null;

  return async (): Promise<string> => {
    if (!authInstance) {
      const GoogleAuth = await loadGoogleAuth();
      authInstance = Promise.resolve(new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...(opts.keyFile ? { keyFile: opts.keyFile } : {}),
      }));
    }
    const auth = await authInstance;
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    if (!tokenRes.token) {
      throw new Error('Failed to obtain Vertex AI access token — check GOOGLE_APPLICATION_CREDENTIALS');
    }
    return tokenRes.token;
  };
}
