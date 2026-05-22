import type { ToolEntry } from '../../types/index.js';
import { applyShape } from '../../core/api-shape.js';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';
import { isFeatureEnabled } from '../../core/features.js';
import { fetchPinned, isPrivateIP } from '../../core/network-guard.js';

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
    throw new Error('Network access denied: air-gapped isolation');
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

function shouldRewriteToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD';
  return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD';
}

export async function fetchWithValidatedRedirects(url: string, init: RequestInit, ctx?: ToolContext | undefined): Promise<Response> {
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    applyHostPolicy(currentUrl, ctx);
    const requestInit: RequestInit = {
      ...init,
      method,
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
  if (!toolContext?.apiStore) return defaultBody;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return defaultBody;
  }

  const profile = toolContext.apiStore.getByHostname(hostname);
  const shape = profile?.response_shape;
  if (!profile || !shape) return defaultBody;

  const result = applyShape(json, shape);

  if (result.error) {
    if (channels.shapeError.hasSubscribers) {
      channels.shapeError.publish({
        profileId: profile.id,
        hostname,
        error: result.error,
      });
    }
    return defaultBody;
  }

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
    if (WRITE_METHODS.has(method)) {
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
      const response = await Promise.race([
        fetchWithValidatedRedirects(input.url, opts, toolContext),
        wallTimeout,
      ]);
      const status = `${response.status} ${response.statusText}`;
      // Strip sensitive response headers to prevent credential leakage to agent
      const REDACTED_HEADERS = new Set([
        'set-cookie', 'authorization', 'www-authenticate', 'proxy-authenticate',
        'proxy-authorization', 'x-auth-token', 'x-api-key', 'x-csrf-token',
        'x-xsrf-token', 'cookie',
      ]);
      const respHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        if (REDACTED_HEADERS.has(key.toLowerCase())) {
          respHeaders.push(`${key}: [redacted]`);
        } else {
          respHeaders.push(`${key}: ${value}`);
        }
      });

      let body = '';
      const contentType = response.headers.get('content-type') ?? '';
      const responseLimit = agent.toolContext?.userConfig?.http_response_limit ?? DEFAULT_RESPONSE_BYTES;
      // Race the body read against the same wall-clock — Node fetch's response
      // body stream doesn't honour signal aborts after headers arrive, so a
      // chunked-transfer stall here would otherwise hang the run.
      const { text, truncated } = await Promise.race([
        readBodyLimited(response, responseLimit),
        wallTimeout,
      ]);

      if (contentType.includes('json') && !truncated) {
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
        const limitKB = Math.round(responseLimit / 1024);
        body += `\n... [truncated — response exceeded ${limitKB}KB limit. Set "http_response_limit" in config to increase.]`;
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
