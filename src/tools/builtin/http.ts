import dns from 'node:dns/promises';
import type { ToolEntry, NetworkPolicy } from '../../types/index.js';
import { applyShape } from '../../core/api-shape.js';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';

// === Network policy enforcement ===

let _networkPolicy: NetworkPolicy | undefined;
let _allowedHosts: ReadonlySet<string> | undefined;
let _allowedWildcards: string[] | undefined;

// === HTTPS enforcement ===

let _enforceHttps = false;

export function configureEnforceHttps(enforce: boolean): void {
  _enforceHttps = enforce;
}

export function resetEnforceHttps(): void {
  _enforceHttps = false;
}

export function setNetworkPolicy(policy: NetworkPolicy | undefined, hosts: string[] | undefined): void {
  _networkPolicy = policy;
  if (hosts && hosts.length > 0) {
    const exact = new Set<string>();
    const wildcards: string[] = [];
    for (const h of hosts) {
      if (h.startsWith('*.')) {
        wildcards.push(h.slice(2));
      } else {
        exact.add(h);
      }
    }
    _allowedHosts = exact;
    _allowedWildcards = wildcards;
  } else {
    _allowedHosts = undefined;
    _allowedWildcards = undefined;
  }
}

export function clearNetworkPolicy(): void {
  _networkPolicy = undefined;
  _allowedHosts = undefined;
  _allowedWildcards = undefined;
}

function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // IPv4 checks
  const v4Parts = mapped.split('.');
  if (v4Parts.length === 4 && v4Parts.every(p => /^\d{1,3}$/.test(p))) {
    const nums = v4Parts.map(Number);
    if (nums.some(n => n < 0 || n > 255)) {
      return false;
    }
    const [a, b, c] = nums as [number, number, number, number];
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
    if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 (IETF special)
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a >= 224) return true;                           // multicast/reserved ranges
  }
  // IPv6 checks
  const normalized = ip.toLowerCase();
  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local
    if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;    // ff00::/8 multicast
  }
  return false;
}

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

async function validateUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // HTTPS enforcement (localhost exempted for development)
  if (_enforceHttps && parsed.protocol === 'http:') {
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      throw new Error('Blocked: HTTP not allowed — enforce_https is enabled. Use HTTPS.');
    }
  }

  // Network policy enforcement
  if (_networkPolicy === 'deny-all') {
    throw new Error('Network access denied: air-gapped isolation');
  }
  if (_networkPolicy === 'allow-list') {
    let allowed = false;
    if (_allowedHosts?.has(hostname)) {
      allowed = true;
    } else if (_allowedWildcards) {
      for (const domain of _allowedWildcards) {
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

  if (isPrivateIP(hostname)) {
    throw new Error(`Blocked: private IP address "${hostname}"`);
  }
  const dnsTimeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5_000));
  const resolved = await Promise.race([
    dns.lookup(hostname, { all: true, verbatim: true }),
    dnsTimeout,
  ]).catch(() => [] as Array<{ address: string; family: number }>);
  for (const record of resolved) {
    if (isPrivateIP(record.address)) {
      throw new Error(`Blocked: "${hostname}" resolves to private IP "${record.address}"`);
    }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_RESPONSE_BYTES = 100_000;

function shouldRewriteToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD';
  return (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD';
}

async function fetchWithValidatedRedirects(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await validateUrl(currentUrl);
    const requestInit: RequestInit = {
      ...init,
      method,
      redirect: 'manual',
    };
    if (body !== undefined) {
      requestInit.body = body;
    }
    const response = await fetch(currentUrl, requestInit);

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

async function readBodyLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
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

/** Domains approved for outbound data requests (POST/PUT/PATCH) in this session. */
const approvedOutboundDomains = new Set<string>();
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const MAX_REQUESTS_PER_SESSION = 100;
let sessionHttpRequestCount = 0;

/** Reset the session HTTP request counter (for testing). */
export function resetHttpRequestCount(): void {
  sessionHttpRequestCount = 0;
}

// === Persistent cross-session rate limiting ===

import type { ToolCallCountProvider } from '../../core/tool-context.js';

let _rateLimitProvider: ToolCallCountProvider | null = null;
const DEFAULT_HOURLY_LIMIT = 200;
const DEFAULT_DAILY_LIMIT = 2000;
let _hourlyLimit = DEFAULT_HOURLY_LIMIT;
let _dailyLimit = DEFAULT_DAILY_LIMIT;

/** Configure cross-session HTTP rate limits. Called once at orchestrator init. */
export function configureHttpRateLimits(opts: {
  provider: ToolCallCountProvider;
  hourlyLimit?: number | undefined;
  dailyLimit?: number | undefined;
}): void {
  _rateLimitProvider = opts.provider;
  _hourlyLimit = opts.hourlyLimit ?? DEFAULT_HOURLY_LIMIT;
  _dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
}

/** Reset rate limit config (for testing). */
export function resetHttpRateLimits(): void {
  _rateLimitProvider = null;
  _hourlyLimit = DEFAULT_HOURLY_LIMIT;
  _dailyLimit = DEFAULT_DAILY_LIMIT;
}

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
    // Invalid URL — will be caught by validateUrl later
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
        timeout_ms: { type: 'number', description: 'Request timeout in milliseconds (default: 30000)' },
      },
      required: ['url'],
    },
  },
  handler: async (input: HttpRequestInput, agent: import('../../types/index.js').IAgent): Promise<string> => {
    // Check persistent cross-session rate limits
    if (_rateLimitProvider && (_hourlyLimit < Infinity || _dailyLimit < Infinity)) {
      if (_hourlyLimit < Infinity) {
        const hourlyCount = _rateLimitProvider.getToolCallCountSince('http_request', 1);
        if (hourlyCount >= _hourlyLimit) {
          return friendlyBlockMessage(`Blocked: hourly HTTP request limit (${_hourlyLimit}) exceeded. Count: ${hourlyCount}.`);
        }
      }
      if (_dailyLimit < Infinity) {
        const dailyCount = _rateLimitProvider.getToolCallCountSince('http_request', 24);
        if (dailyCount >= _dailyLimit) {
          return friendlyBlockMessage(`Blocked: daily HTTP request limit (${_dailyLimit}) exceeded. Count: ${dailyCount}.`);
        }
      }
    }

    // Check session rate limit before any validation — only increment on actual request attempt
    if (sessionHttpRequestCount >= MAX_REQUESTS_PER_SESSION) {
      return friendlyBlockMessage(`Blocked: session HTTP request limit (${MAX_REQUESTS_PER_SESSION}) exceeded.`);
    }

    // Per-API rate limiting + profile enforcement (from API Store)
    const toolContext = agent.toolContext;
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

    // First-use consent for outbound data requests (POST/PUT/PATCH)
    if (WRITE_METHODS.has(method)) {
      const hostname = new URL(input.url).hostname;
      if (!approvedOutboundDomains.has(hostname)) {
        if (!agent.promptUser) {
          return `Blocked: outbound ${method} to ${hostname} requires user consent but no interactive prompt is available (autonomous/background mode).`;
        }
        if (agent.promptUser) {
          const answer = await agent.promptUser(
            `⚠ http_request: ${method} to ${hostname} — Allow outbound data?`,
            ['Allow', 'Deny', '\x00'],
          );
          if (!['y', 'yes', 'allow'].includes(answer.toLowerCase())) {
            return `Blocked: outbound ${method} to ${hostname} denied by user.`;
          }
          approvedOutboundDomains.add(hostname);
        }
      }
    }

    const opts: RequestInit = { method, headers };
    if (input.body && method !== 'GET' && method !== 'HEAD') {
      opts.body = input.body;
    }
    const timeoutMs = input.timeout_ms ?? 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    opts.signal = controller.signal;

    try {
      sessionHttpRequestCount++;
      const response = await fetchWithValidatedRedirects(input.url, opts);
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
      const { text, truncated } = await readBodyLimited(response, responseLimit);

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
      const wrapped = wrapUntrustedData(rawResult, 'http_response');
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
    }
  },
};
