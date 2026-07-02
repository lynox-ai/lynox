import type { ToolEntry } from '../../types/index.js';
import { applyShape } from '../../core/api-shape.js';
import type { ResponseShape } from '../../core/api-store.js';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';
import { isFeatureEnabled } from '../../core/features.js';
import { fetchPinned, isPrivateIP, flattenHeaders, redirectHopHeaders, isCrossOriginHop } from '../../core/network-guard.js';
import { contractGrants } from '../permission-guard.js';
import { isAllowlistedEndpoint, isEndpointAcked } from '../../core/llm/endpoint-allowlist.js';

// Network policy (`networkPolicy`, `allowedHosts`, `allowedWildcards`),
// HTTPS-enforcement (`enforceHttps`), and cross-session rate limits
// (`rateLimitProvider`, `hourlyRateLimit`, `dailyRateLimit`) live on
// ToolContext. Engine-init wires them via applyNetworkPolicy() /
// applyHttpRateLimits() / applyEnforceHttps() in tool-context.ts. The
// tool handler reads from `agent.toolContext` and threads it into
// applyHostPolicy() + fetchWithValidatedRedirects().
//
// SSRF defense: isPrivateIP (decodes IPv4-mapped-IPv6 incl. hex form) and the
// IP-pinning fetch helper come from network-guard.ts. fetchWithValidatedRedirects
// applies the policy/enforce-https/allow-list checks here and delegates each
// HTTP hop to fetchPinned(), which resolves DNS once + pins the connection to
// the validated IP (closes the DNS-rebinding window between validate + connect).

/** Translate technical block reasons into business-friendly messages */
function friendlyBlockMessage(technical: string): string {
  if (technical.includes('private IP')) return 'That address points to an internal network and cannot be reached.';
  if (technical.includes('enforce_https')) return 'Only secure HTTPS connections are allowed. HTTP is disabled.';
  if (technical.includes('unsupported protocol')) return 'Only HTTP and HTTPS connections are supported.';
  if (technical.includes('air-gapped')) return 'Network access is disabled in this security mode.';
  if (technical.includes('allow-list')) return 'That server is not in the allowed list for this security mode.';
  if (technical.includes('too many redirects')) return 'The server redirected too many times. The URL may be incorrect.';
  if (technical.includes('hourly')) return 'Hourly request limit reached. Try again later.';
  if (technical.includes('daily')) return 'Daily request limit reached. Try again tomorrow.';
  if (technical.includes('session')) return 'Request limit reached for this session.';
  return technical;
}

/**
 * Apply user-policy checks BEFORE the SSRF / IP-pinning layer:
 *  - protocol must be http/https
 *  - enforceHttps: reject plain HTTP unless target is localhost
 *  - networkPolicy: deny-all / allow-list
 *  - reject hostname that is itself a private-IP literal (cheap early-out)
 *
 * The DNS-resolve + private-IP check + IP-pinning all happen in fetchPinned()
 * — a single resolve that drives both validation and the socket connect, with
 * no rebind window in between.
 */
function applyHostPolicy(rawUrl: string, ctx?: ToolContext | undefined): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // HTTPS enforcement (localhost exempted for development)
  if (ctx?.enforceHttps && parsed.protocol === 'http:') {
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      throw new Error('Blocked: HTTP not allowed — enforce_https is enabled. Use HTTPS.');
    }
  }

  // Network policy enforcement
  if (ctx?.networkPolicy === 'deny-all') {
    // 'Blocked:' prefix so the handler's friendly-message layer rewrites it
    // (consistent with every other block); 'air-gapped' keeps the mapping match.
    throw new Error('Blocked: network access denied (air-gapped isolation)');
  }
  if (ctx?.networkPolicy === 'allow-list') {
    let allowed = false;
    if (ctx.allowedHosts?.has(hostname)) {
      allowed = true;
    } else if (ctx.allowedWildcards.length > 0) {
      for (const domain of ctx.allowedWildcards) {
        if (hostname === domain || hostname.endsWith(`.${domain}`)) {
          allowed = true;
          break;
        }
      }
    }
    if (!allowed) {
      throw new Error(`Blocked: hostname "${hostname}" not in network allow-list`);
    }
  }

  // Cheap early-out for literal-IP private targets — fetchPinned would catch
  // these anyway, but rejecting before any DNS attempt keeps the error
  // synchronous + matches the legacy validateUrl flow.
  if (isPrivateIP(hostname)) {
    throw new Error(`Blocked: private IP address "${hostname}"`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_RESPONSE_BYTES = 100_000;

// Safety-net response shaping: when an API profile defines NO `response_shape`
// and the parsed JSON is large, apply a generic structural cap so an unshaped
// heavy API (DataForSEO, Stripe list endpoints, ...) can't silently inject tens
// of KB into the context — which then re-bills via the prompt cache on every
// subsequent turn. Falls back to the raw body on any error; never worse than
// the unshaped response. Below the threshold the raw body is returned untouched.
const DEFAULT_SHAPE_THRESHOLD_CHARS = 30_000;
const DEFAULT_LARGE_RESPONSE_SHAPE: ResponseShape = {
  kind: 'reduce',
  max_array_items: 25,
  max_string_chars: 1_000,
  max_chars: 24_000,
};
// JSON bodies get a higher read ceiling than the raw-text limit: the shaping
// pass (explicit profile shape OR the safety-net cap) reduces them back down to
// a few KB, so byte-truncating a large JSON to invalid mid-cut text BEFORE it
// can be parsed + shaped would defeat the cap on exactly the heavy API pulls
// (e.g. DataForSEO bulk keyword data, routinely >100KB) that motivate it. Only
// applied when the user hasn't pinned an explicit `http_response_limit`.
const JSON_SHAPE_READ_CEILING = 2_000_000;

function shouldRewriteToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD';
  return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD';
}

export async function fetchWithValidatedRedirects(
  url: string,
  init: RequestInit,
  ctx?: ToolContext | undefined,
  // Slice B: for a capability-contract-governed write, every redirect hop must
  // ALSO stay within the contract — `isDangerous`/the consent gate only saw the
  // ORIGINAL url, so without this a 307/308 to another (network-allow-listed)
  // host would carry the POST body past the contract's host/path pin (S1).
  // Returns true if the hop is permitted. Omitted for non-contract calls (no
  // redirect-behaviour change).
  redirectGuard?: ((nextUrl: string, method: string) => boolean) | undefined,
): Promise<Response> {
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  // Carried explicitly so credential headers (incl. the engine-attached OAuth2
  // Bearer) can be dropped on a cross-origin hop (mirror fetch()); see
  // redirectHopHeaders.
  let headers = flattenHeaders(init.headers);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    applyHostPolicy(currentUrl, ctx);
    const requestInit: RequestInit = {
      ...init,
      method,
      headers,
    };
    if (body !== undefined) {
      requestInit.body = body;
    } else {
      delete (requestInit as { body?: unknown }).body;
    }
    // fetchPinned does the DNS-resolve + IP validation + connection-pinning in
    // one shot — no rebind window between validate and connect.
    const response = await fetchPinned(currentUrl, requestInit);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Blocked: redirect without location header (${response.status})`);
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`Blocked: too many redirects (>${MAX_REDIRECTS})`);
    }

    const nextUrl = new URL(location, currentUrl).toString();
    if (shouldRewriteToGet(response.status, method)) {
      method = 'GET';
      body = undefined;
    }
    // Drop credential headers before a cross-origin hop (mirror fetch()) so the
    // OAuth2 Bearer / Authorization / Cookie is not replayed off-origin.
    headers = redirectHopHeaders(headers, currentUrl, nextUrl);
    // A 307/308 preserves the method + body — drop the body too on a cross-origin
    // hop (e.g. an api_setup OAuth client_secret POST whose token_url issues an
    // open redirect), degrading to a bodyless GET like the 301/302/303 path.
    if (body !== undefined && isCrossOriginHop(currentUrl, nextUrl)) {
      method = 'GET';
      body = undefined;
    }
    if (redirectGuard && !redirectGuard(nextUrl, method)) {
      throw new Error(`Blocked: redirect to ${new URL(nextUrl).hostname} is outside the workflow's capability-contract`);
    }
    currentUrl = nextUrl;
  }

  throw new Error('Blocked: redirect handling failed');
}

export async function readBodyLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      if (value.byteLength <= remaining) {
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      } else {
        bytes += remaining;
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        break;
      }
    }

    text += decoder.decode();
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failures.
      }
    }
    return { text, truncated };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort cleanup.
    }
  }
}

// `approvedOutboundDomains` (per-Session approved hosts) and
// `pendingOutboundPrompts` (per-Session in-flight prompt dedup) used to
// live as module-level state. They moved onto `agent.sessionCounters`
// in step 3 of the Wave 4.1 migration — approval no longer leaks
// between conversations, and dedup is naturally bounded to the Session
// that issued the prompt. See SessionCounters JSDoc on types/agent.ts
// for the per-Session ownership contract.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Max http_request invocations per Session. Previously enforced via the
 * module-level `sessionHttpRequestCount`; that masqueraded as per-session
 * but actually accumulated for the lifetime of the process (no reset
 * between Sessions outside the test-only `resetHttpRequestCount` helper).
 * Now charged against `agent.sessionCounters.httpRequests`, which the
 * owning Session allocates fresh on construction and the spawn-agent path
 * shares with sub-agents.
 */
export const MAX_REQUESTS_PER_SESSION = 100;

// Cross-session rate limits live on ToolContext (rateLimitProvider,
// hourlyRateLimit, dailyRateLimit). Engine-init configures them via
// applyHttpRateLimits().

/**
 * Default cross-session rate limits exposed for engine-init.ts. The
 * handler defaults to `Infinity` (i.e. no limit) when the ToolContext
 * fields are unset, so changing these only affects new orchestrator
 * instances that opt in via applyHttpRateLimits.
 */
export { HTTP_TOOL_HOURLY_LIMIT as DEFAULT_HOURLY_LIMIT, HTTP_TOOL_DAILY_LIMIT as DEFAULT_DAILY_LIMIT } from '../../core/limits.js';

// === Egress control: detect data exfiltration attempts ===

/** Common secret/API key patterns that should never appear in outbound requests. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/,                    label: 'Anthropic API key' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/,                          label: 'OpenAI-style API key' },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/,                         label: 'GitHub personal access token' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/,                         label: 'GitHub OAuth token' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/,                         label: 'AWS access key' },
  { pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/,                    label: 'Google API key' },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,    label: 'private key' },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,  label: 'JWT token' },
];

/**
 * Scan a string for embedded secrets/credentials.
 * Returns the first match label or null if clean.
 */
export function detectSecretInContent(content: string): string | null {
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return label;
    }
  }
  return null;
}

/**
 * Detect GET-based data exfiltration via suspiciously long query strings
 * or base64-encoded data in URL parameters.
 */
function detectGetExfiltration(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Flag query strings >500 chars (heuristic for encoded data exfil)
    if (parsed.search.length > 500) {
      return 'suspiciously long query string (>500 chars, possible data exfiltration)';
    }
    // Detect base64-looking blobs in URL params
    if (/[A-Za-z0-9+/=]{64,}/.test(parsed.search)) {
      return 'base64-like data in URL parameters (possible data exfiltration)';
    }
  } catch {
    // Invalid URL — will be caught by applyHostPolicy later
  }
  return null;
}

/**
 * Apply the API profile's response_shape (if any) to a parsed JSON response.
 * Falls back to standard JSON.stringify on any error; never throws.
 */
async function maybeShapeJson(json: unknown, url: string, toolContext: ToolContext | undefined): Promise<string> {
  const defaultBody = JSON.stringify(json, null, 2);

  // 1. Explicit per-API shape — a profile's `response_shape` wins when present.
  const apiStore = toolContext?.apiStore;
  if (apiStore) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }
    const profile = hostname ? apiStore.getByHostname(hostname) : undefined;
    const shape = profile?.response_shape;
    if (profile && shape) {
      const result = applyShape(json, shape);
      if (!result.error) {
        if (channels.shapeApplied.hasSubscribers) {
          channels.shapeApplied.publish({
            profileId: profile.id,
            hostname,
            beforeChars: result.beforeChars,
            afterChars: result.afterChars,
            kind: shape.kind ?? 'reduce',
          });
        }
        return result.shaped;
      }
      if (channels.shapeError.hasSubscribers) {
        channels.shapeError.publish({ profileId: profile.id, hostname, error: result.error });
      }
      // fall through to the safety-net cap below
    }
  }

  // 2. Safety-net: no explicit shape (or it errored). Return raw unless the body
  //    is large enough to bloat the context, then apply the generic structural cap.
  if (defaultBody.length <= DEFAULT_SHAPE_THRESHOLD_CHARS) return defaultBody;
  const capped = applyShape(json, DEFAULT_LARGE_RESPONSE_SHAPE);
  if (capped.error) return defaultBody;
  if (channels.shapeApplied.hasSubscribers) {
    channels.shapeApplied.publish({
      profileId: '(default-cap)',
      hostname: '',
      beforeChars: capped.beforeChars,
      afterChars: capped.afterChars,
      kind: 'reduce',
    });
  }
  return capped.shaped +
    `\n[note: large API response auto-capped (${capped.beforeChars}→${capped.afterChars} chars) to protect the context window — ` +
    `define a response_shape on this API profile for precise field selection, or use spawn_agent role='collector' to work the full dataset in an isolated context.]`;
}

interface HttpRequestInput {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  timeout_ms?: number | undefined;
}

export const httpRequestTool: ToolEntry<HttpRequestInput> = {
  definition: {
    name: 'http_request',
    description: 'Make an HTTP request to a specific API endpoint. Use for authenticated APIs, custom endpoints, or structured data fetching. For general web search or reading public pages, use web_research instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout_ms: { type: 'number', description: 'Request timeout in milliseconds (default: 30000, hard cap: 60000). Includes both connection and full body read — a hung response body still trips the timeout. If an API legitimately needs >60s, use webhooks or polling instead.' },
      },
      required: ['url'],
    },
  },
  handler: async (input: HttpRequestInput, agent: import('../../types/index.js').IAgent): Promise<string> => {
    const toolContext = agent.toolContext;

    // Check persistent cross-session rate limits (sourced from ToolContext)
    const rateLimitProvider = toolContext?.rateLimitProvider ?? null;
    const hourlyLimit = toolContext?.hourlyRateLimit ?? Infinity;
    const dailyLimit = toolContext?.dailyRateLimit ?? Infinity;
    if (rateLimitProvider && (hourlyLimit < Infinity || dailyLimit < Infinity)) {
      if (hourlyLimit < Infinity) {
        const hourlyCount = rateLimitProvider.getToolCallCountSince('http_request', 1);
        if (hourlyCount >= hourlyLimit) {
          return friendlyBlockMessage(`Blocked: hourly HTTP request limit (${hourlyLimit}) exceeded. Count: ${hourlyCount}.`);
        }
      }
      if (dailyLimit < Infinity) {
        const dailyCount = rateLimitProvider.getToolCallCountSince('http_request', 24);
        if (dailyCount >= dailyLimit) {
          return friendlyBlockMessage(`Blocked: daily HTTP request limit (${dailyLimit}) exceeded. Count: ${dailyCount}.`);
        }
      }
    }

    // Check session rate limit before any validation — only increment on actual request attempt
    if (agent.sessionCounters.httpRequests >= MAX_REQUESTS_PER_SESSION) {
      return friendlyBlockMessage(`Blocked: session HTTP request limit (${MAX_REQUESTS_PER_SESSION}) exceeded.`);
    }

    // Per-API rate limiting + profile enforcement (from API Store)
    if (toolContext?.apiStore && toolContext.apiStore.size > 0) {
      try {
        const reqHostname = new URL(input.url).hostname;
        // Check per-API rate limit
        const apiBlock = toolContext.apiStore.checkRateLimit(reqHostname);
        if (apiBlock) {
          return friendlyBlockMessage(apiBlock);
        }
        // Soft-warning: note missing profile but let the request through
        // The agent sees the warning in the response and can create a profile for next time
        const SKIP_PROFILE_CHECK = new Set(['www.google.com', 'google.com', 'github.com', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'localhost', '127.0.0.1']);
        if (!toolContext.apiStore.getByHostname(reqHostname) && !SKIP_PROFILE_CHECK.has(reqHostname)) {
          const looksLikeApi = reqHostname.startsWith('api.') || input.url.includes('/v1') || input.url.includes('/v2') || input.url.includes('/v3') || input.url.includes('/api/');
          if (looksLikeApi) {
            // Store warning — appended to response after the request completes
            (input as unknown as Record<string, unknown>)['_profileWarning'] = `Note: No API profile for "${reqHostname}". After this task, create one via api_setup to ensure correct usage next time.`;
          }
        }
      } catch {
        // Invalid URL — will be caught below
      }
    }

    const method = input.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
        return `Blocked: header '${key}' contains invalid characters (CRLF/null).`;
      }
      headers[key] = value;
    }

    // Egress secret scan over AGENT-SUPPLIED header values (all methods).
    // Headers are an equally valid exfil channel as bodies — `Authorization:
    // Bearer sk-ant-…` on a GET to a third-party host hands the credential
    // over just as plainly as POSTing it in JSON. Run BEFORE the OAuth2
    // injection below so engine-managed access tokens (which may be JWT-
    // shaped and would self-trip the scan) are never re-scanned: the
    // engine-managed Authorization path is the trusted, profile-driven flow
    // — anything the agent hand-set is what we're trying to catch here.
    for (const [headerName, headerValue] of Object.entries(headers)) {
      const headerMatch = detectSecretInContent(headerValue);
      if (headerMatch) {
        return `Blocked: request header '${headerName}' appears to contain a ${headerMatch}. Sending secrets to external servers is not allowed.`;
      }
    }

    // Egress secret scan over the URL itself (path + query), all methods. A
    // credential smuggled into the query — `…?token=sk-ant-…` — exfiltrates just
    // like one in a header or body, and unlike the body scan the URL rides EVERY
    // method incl. GET. detectGetExfiltration's heuristics (long/base64 query)
    // don't catch a bare key that its own `-`/`_` chars break out of a base64
    // run, so scan for the explicit secret patterns here too. detectSecretInContent
    // matches only specific credential prefixes (no generic long-string rule), so
    // this won't false-trip on ordinary long paths/IDs.
    //
    // EXCEPTION: a configured api_profile using `query`-param key auth (Google
    // Maps/YouTube `?key=…`) legitimately carries the key in the URL — that's the
    // user's declared, intended mechanism, not exfil. Skip the scan only for such
    // profiled hosts; an unprofiled attacker host is still scanned.
    let urlAuthType: string | undefined;
    try {
      urlAuthType = toolContext?.apiStore?.getByHostname(new URL(input.url).hostname)?.auth?.type;
    } catch { /* invalid URL — applyHostPolicy reports it below */ }
    if (urlAuthType !== 'query') {
      const urlSecretMatch = detectSecretInContent(input.url);
      if (urlSecretMatch) {
        return `Blocked: request URL appears to contain a ${urlSecretMatch}. Sending secrets to external servers is not allowed.`;
      }
    }

    // Engine-managed OAuth2 Authorization for matched api_profile.
    // Profile drives — the agent should NOT have to remember which vault key
    // holds the current access_token. Two failure modes this prevents:
    //   1. Agent re-references the OLD vault key after api_setup recreates a
    //      profile (staging 2026-05-18: SHOPIFY_ACCESS_TOKEN was stale, but
    //      fetch_token had written the new token to SHOPIFY_SEO_ACCESS_TOKEN.
    //      Agent kept reaching for the old key → 401 forever).
    //   2. Token rotation: when fetch_token mints a fresh access_token, every
    //      subsequent http_request to this profile should use it automatically.
    // For oauth2 profiles, engine owns auth — override whatever the agent set.
    if (toolContext?.apiStore && agent.secretStore) {
      try {
        const reqHostnameForAuth = new URL(input.url).hostname;
        const oauthProfile = toolContext.apiStore.getByHostname(reqHostnameForAuth);
        if (oauthProfile?.auth?.type === 'oauth2') {
          // Wave 5d runtime egress gate (base_url parity with fetch_token). The
          // engine force-attaches the managed access_token below, so a profile
          // that entered the store WITHOUT passing the save-time allowlist gate
          // (loadFromDirectory at boot, migration-import, hand-dropped JSON)
          // could hand the vault token to a non-vetted host. Fail-closed: refuse
          // the attach unless the target host is allowlisted OR the profile
          // carries a persisted acceptance covering it.
          if (
            !isAllowlistedEndpoint(input.url) &&
            !isEndpointAcked(oauthProfile.custom_endpoint_ack, input.url)
          ) {
            return `Error: api_profile "${oauthProfile.id}" maps to a non-vetted sub-processor (${reqHostnameForAuth}) with no recorded acceptance — refusing to attach the managed access_token to that host. Re-save the profile via api_setup({ action: "update", ... }) and accept controller-responsibility (confirm_custom_endpoint: true) to unblock.`;
          }
          const tokenKey = `${oauthProfile.id.toUpperCase().replace(/-/g, '_')}_ACCESS_TOKEN`;
          const resolvedToken = agent.secretStore.resolve(tokenKey);
          if (resolvedToken) {
            for (const k of Object.keys(headers)) {
              if (k.toLowerCase() === 'authorization') delete headers[k];
            }
            headers['Authorization'] = `Bearer ${resolvedToken}`;
          } else {
            return `Error: api_profile "${oauthProfile.id}" is oauth2 but the vault has no access_token under "${tokenKey}". Mint one first with: api_setup({ action: "fetch_token", id: "${oauthProfile.id}" }). Requires client_id + client_secret already stored under the keys configured in auth.oauth.`;
          }
        }
      } catch {
        // Invalid URL — caught by applyHostPolicy below
      }
    }

    // GET-based exfiltration detection
    if (method === 'GET' || method === 'HEAD') {
      const exfilWarning = detectGetExfiltration(input.url);
      if (exfilWarning) {
        if (!agent.promptUser) {
          return `Blocked: ${exfilWarning}`;
        }
        const answer = await agent.promptUser(
          `⚠ http_request: ${exfilWarning} — Allow?`,
          ['Allow', 'Deny', '\x00'],
        );
        if (!['y', 'yes', 'allow'].includes(answer.toLowerCase())) {
          return `Blocked: ${exfilWarning} — denied by user.`;
        }
      }
    }

    // Request body secret scanning (POST/PUT/PATCH)
    if (input.body && WRITE_METHODS.has(method)) {
      const secretMatch = detectSecretInContent(input.body);
      if (secretMatch) {
        return `Blocked: request body appears to contain a ${secretMatch}. Sending secrets to external servers is not allowed.`;
      }
    }

    // First-use consent for outbound data requests (POST/PUT/PATCH).
    // Approvals + in-flight dedup live on this Session's counters object so
    // they don't leak between conversations. Concurrent tool_use blocks
    // against the same hostname share one prompt so we don't collide on
    // PromptStore's per-session unique index.
    //
    // Slice B: a capability-contract that grants this exact (method, host, path)
    // IS the pre-declared, human-confirmed consent — it satisfies this gate the
    // same way an interactive "Allow" would (the grant `isDangerous` already
    // enforced before this tool ran). This is what makes a contract-governed
    // headless write actually execute; without it the gate below would block
    // every unattended POST/PUT/PATCH (no `promptUser` in a background run).
    const contractGrantsWrite =
      agent.capabilityContract !== undefined &&
      contractGrants('http_request', input, agent.capabilityContract);
    if (WRITE_METHODS.has(method) && !contractGrantsWrite) {
      const hostname = new URL(input.url).hostname;
      const approved = agent.sessionCounters.approvedOutboundDomains;
      const pendingMap = agent.sessionCounters.pendingOutboundPrompts;
      if (!approved.has(hostname)) {
        if (!agent.promptUser) {
          return `Blocked: outbound ${method} to ${hostname} requires user consent but no interactive prompt is available (autonomous/background mode).`;
        }
        const promptUser = agent.promptUser;
        let pending = pendingMap.get(hostname);
        if (!pending) {
          pending = (async () => {
            try {
              const answer = await promptUser(
                `⚠ http_request: ${method} to ${hostname} — Allow outbound data?`,
                ['Allow', 'Deny', '\x00'],
              );
              const allowed = ['y', 'yes', 'allow'].includes(answer.toLowerCase());
              if (allowed) approved.add(hostname);
              return allowed;
            } finally {
              pendingMap.delete(hostname);
            }
          })();
          pendingMap.set(hostname, pending);
        }
        const allowed = await pending;
        if (!allowed) {
          return `Blocked: outbound ${method} to ${hostname} denied by user.`;
        }
      }
    }

    const opts: RequestInit = { method, headers };
    if (input.body && method !== 'GET' && method !== 'HEAD') {
      opts.body = input.body;
    }
    // Hard cap. The original 30s default + agent-overridable timeout meant a
    // hung Shopify endpoint locked cat's session for 28 min on 2026-05-19 —
    // the agent's run held the per-session mutex while readBodyLimited blocked
    // on a stalled response body. AbortController.signal propagates to fetch
    // but NOT to response.body.getReader() once headers have arrived, so a
    // chunked-transfer stall is invisible to the timeout below. Race below
    // is the wrap-around guarantee: no matter where in the pipeline things
    // hang, the whole tool call resolves within HARD_CAP.
    const HTTP_HARD_CAP_MS = 60_000;
    const requestedTimeout = input.timeout_ms ?? 30_000;
    const timeoutMs = Math.min(Math.max(1, requestedTimeout), HTTP_HARD_CAP_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    opts.signal = controller.signal;

    // Wall-clock timeout that wins even if the abort signal doesn't fire (e.g.
    // body-stream hang). Resolves with a thrown HttpTimeoutError so the catch
    // below can format the agent-visible message.
    let wallTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const wallTimeout = new Promise<never>((_, reject) => {
      wallTimeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`HTTP request timed out after ${timeoutMs}ms (wall clock)`));
      }, timeoutMs + 1000);
    });

    try {
      agent.sessionCounters.httpRequests++;
      // For a contract-governed write, re-validate every redirect hop against
      // the contract so a 307/308 can't carry the body past the host/path pin.
      const contract = agent.capabilityContract;
      const redirectGuard = (contractGrantsWrite && contract !== undefined)
        ? (nextUrl: string, redirectMethod: string): boolean =>
            contractGrants('http_request', { url: nextUrl, method: redirectMethod }, contract)
        : undefined;
      const response = await Promise.race([
        fetchWithValidatedRedirects(input.url, opts, toolContext, redirectGuard),
        wallTimeout,
      ]);
      const status = `${response.status} ${response.statusText}`;
      // Strip sensitive response headers to prevent credential leakage to agent
      const REDACTED_HEADERS = new Set([
        'set-cookie', 'authorization', 'www-authenticate', 'proxy-authenticate',
        'proxy-authorization', 'x-auth-token', 'x-api-key', 'x-csrf-token',
        'x-xsrf-token', 'cookie',
      ]);
      // Transport / CORS / browser-security headers are noise to the agent and
      // just burn context tokens on every call. Drop them (incl. the whole
      // `access-control-*` family) and keep only payload-relevant headers
      // (content-type, content-length, location, retry-after, link, ratelimit…).
      const NOISE_HEADERS = new Set([
        'connection', 'keep-alive', 'transfer-encoding', 'cache-control', 'pragma',
        'expires', 'age', 'vary', 'date', 'server', 'x-powered-by', 'via', 'alt-svc',
        'strict-transport-security', 'content-security-policy', 'referrer-policy',
        'x-content-type-options', 'x-frame-options', 'x-xss-protection',
        'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
        'cross-origin-embedder-policy', 'cf-ray', 'cf-cache-status', 'x-cache',
        'report-to', 'nel', 'timing-allow-origin',
      ]);
      const respHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        const lk = key.toLowerCase();
        if (REDACTED_HEADERS.has(lk)) {
          respHeaders.push(`${key}: [redacted]`);
        } else if (lk.startsWith('access-control-') || NOISE_HEADERS.has(lk)) {
          // dropped — transport/CORS/security noise, irrelevant to the agent
        } else {
          respHeaders.push(`${key}: ${value}`);
        }
      });

      let body = '';
      const contentType = response.headers.get('content-type') ?? '';
      const isJson = contentType.includes('json');
      const explicitLimit = agent.toolContext?.userConfig?.http_response_limit;
      const responseLimit = explicitLimit ?? DEFAULT_RESPONSE_BYTES;
      // Read JSON up to the higher shape-ceiling (unless the user pinned a limit)
      // so the shaping pass can run on large payloads instead of byte-truncating
      // them to invalid mid-cut text first. See JSON_SHAPE_READ_CEILING.
      const readLimit = isJson && explicitLimit === undefined
        ? JSON_SHAPE_READ_CEILING
        : responseLimit;
      // Race the body read against the same wall-clock — Node fetch's response
      // body stream doesn't honour signal aborts after headers arrive, so a
      // chunked-transfer stall here would otherwise hang the run.
      const { text, truncated } = await Promise.race([
        readBodyLimited(response, readLimit),
        wallTimeout,
      ]);

      if (isJson && !truncated) {
        try {
          const json = JSON.parse(text) as unknown;
          // Apply per-API response shaping if the profile defines one.
          const shapedBody = await maybeShapeJson(json, input.url, toolContext);
          body = shapedBody;
        } catch {
          body = text;
        }
      } else {
        body = text;
      }

      if (truncated) {
        const limitKB = Math.round(readLimit / 1024);
        // Active delegation hint: a half-cut response in the main context is
        // expensive (eats the cap, may still miss the field the agent needs).
        // A collector sub-agent can fetch + summarize in an isolated context
        // and return only the relevant slice — that's the cheaper path.
        body +=
          `\n... [truncated — response exceeded ${limitKB}KB limit. ` +
          `For large responses prefer \`spawn_agent\` with role='collector' ` +
          `(it fetches + summarizes in an isolated context, no main-context bloat). ` +
          `Or bump "http_response_limit" in config if the full body is unavoidable.]`;
      }

      const rawResult = `HTTP ${status}\n${respHeaders.join('\n')}\n\n${body}`;
      // Wrap response in data boundary markers (prompt injection defense)
      const { wrapUntrustedData } = await import('../../core/data-boundary.js');
      let wrapped = wrapUntrustedData(rawResult, 'http_response');

      // OAuth2 401-hint: append OUTSIDE the untrusted_data wrap so the
      // agent treats it as system guidance, not external response data.
      // Fires when an http_request hits 401 against an URL matched by an
      // api_profile with `auth.type: 'oauth2'` AND `auth.oauth.token_url`
      // set — the 2026-05-18 Shopify failure mode: stale vault
      // access_token + agent ping-ponged the user through "re-paste from
      // admin UI" instead of calling `api_setup fetch_token`.
      if (response.status === 401 && toolContext?.apiStore) {
        try {
          const reqHostname = new URL(input.url).hostname;
          const matchedProfile = toolContext.apiStore.getByHostname(reqHostname);
          if (matchedProfile?.auth?.type === 'oauth2' && matchedProfile.auth.oauth?.token_url) {
            wrapped += `\n\n**[Agent reminder — OAuth2 401 on a managed-OAuth api_profile]**\nThis URL maps to api_profile "${matchedProfile.id}" (auth.type=oauth2 with token_url configured). The vault's access_token is almost certainly expired. Recover with:\n  api_setup({ action: "fetch_token", id: "${matchedProfile.id}" })\nThat uses the stored client_id + client_secret to mint a fresh access_token via the OAuth grant — no user interaction required. Do NOT walk the user through "re-paste a token from the provider admin UI" — 2026-era providers (Shopify Dev Dashboard, TikTok, etc.) don't expose long-lived tokens there anymore.`;
          }
        } catch {
          // Bad URL fell through earlier; nothing to do.
        }
      }

      // Phase E (api-cost-display): if this hit a profiled API with a per_call
      // cost model, surface the cost on the streamHandler so the web-ui can
      // show "$0.0006" alongside the tool_result. per_token / per_unit are
      // deferred — we have no reliable token counter for arbitrary HTTP bodies.
      try {
        // Use the response's final URL (after redirects) for attribution so a
        // redirect chain that lands on a different host is profiled against
        // its actual endpoint, not the original request URL.
        const finalUrl = response.url || input.url;
        const parsedFinal = new URL(finalUrl);
        const profile = toolContext?.apiStore?.getByHostname(parsedFinal.hostname);
        if (profile?.cost?.model === 'per_call' && isFeatureEnabled('api-cost-display')) {
          const streamHandler = toolContext?.streamHandler;
          if (streamHandler) {
            // Mirror emitBootstrapProgress: catch sync throws via the outer
            // try/catch, and chain .catch on the Promise so an async rejection
            // from the handler cannot escape as an unhandledRejection.
            const emitResult = streamHandler({
              type: 'api_cost',
              tool: 'http_request',
              profileId: profile.id,
              profileName: profile.name,
              endpoint: parsedFinal.pathname,
              costUsd: profile.cost.rate_usd,
              agent: agent.name,
            });
            if (emitResult instanceof Promise) {
              emitResult.catch(() => { /* best-effort */ });
            }
          }
        }
      } catch { /* cost emission is best-effort */ }

      // Append profile warning if this was an unregistered API
      const profileWarning = (input as unknown as Record<string, unknown>)['_profileWarning'];
      return profileWarning ? `${wrapped}\n\n${String(profileWarning)}` : wrapped;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
      }
      // Translate SSRF/network errors into business-friendly messages
      if (err instanceof Error && err.message.startsWith('Blocked:')) {
        throw new Error(friendlyBlockMessage(err.message));
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (wallTimeoutId !== undefined) clearTimeout(wallTimeoutId);
    }
  },
};
