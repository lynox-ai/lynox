import type { ToolEntry } from '../../types/index.js';
import { applyShape } from '../../core/api-shape.js';
import type { ResponseShape } from '../../core/api-store.js';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';
import { resolveGuardedAckHosts } from '../../core/tool-context.js';
import { isFeatureEnabled } from '../../core/features.js';
import { fetchPinned, flattenHeaders, redirectHopHeaders, isCrossOriginHop, assertHostPolicy } from '../../core/network-guard.js';
import type { EgressSurface } from '../../core/network-guard.js';
import { contractGrants } from '../permission-guard.js';
import { isEndpointAcked, isVettedEgressHost } from '../../core/llm/endpoint-allowlist.js';
import { isProtectedSecretWrite } from '../../core/secret-store.js';
import { ToolSoftFailure } from '../../core/tool-soft-failure.js';
import {
  extractHtmlText,
  isHtmlContentType,
  DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS,
  DEFAULT_HTML_EXTRACT_MAX_CHARS,
  MIN_USEFUL_EXTRACT_CHARS,
} from '../../core/html-extract.js';
import type { HtmlExtractResult } from '../../core/html-extract.js';
import { pv } from '../../core/prompt-value.js';

// Network policy (`networkPolicy`, `allowedHosts`, `allowedWildcards`),
// HTTPS-enforcement (`enforceHttps`), and cross-session rate limits
// (`rateLimitProvider`, `hourlyRateLimit`, `dailyRateLimit`) live on
// ToolContext. Engine-init wires them via applyNetworkPolicy() /
// applyHttpRateLimits() / applyEnforceHttps() in tool-context.ts. The
// tool handler reads from `agent.toolContext` and threads it into
// assertHostPolicy() + fetchWithValidatedRedirects().
//
// SSRF defense + user network-policy: the IP-pinning fetch helper (fetchPinned)
// and the configurable network_policy gate (assertHostPolicy) both come from
// network-guard.ts. fetchWithValidatedRedirects applies assertHostPolicy per hop
// (protocol / enforce_https / policy / private-IP early-out) and delegates each
// HTTP hop to fetchPinned(), which resolves DNS once + pins the connection to
// the validated IP (closes the DNS-rebinding window between validate + connect).

/** Translate technical block reasons into business-friendly messages */
function friendlyBlockMessage(technical: string): string {
  if (technical.includes('private IP')) return 'That address points to an internal network and cannot be reached.';
  if (technical.includes('enforce_https')) return 'Only secure HTTPS connections are allowed. HTTP is disabled.';
  if (technical.includes('unsupported protocol')) return 'Only HTTP and HTTPS connections are supported.';
  // This string is what the MODEL reads back as the tool result, so it teaches a
  // rule. "Network access is disabled" taught the wrong one: it describes the
  // machine, while the policy only covers this tool — the engine's own outbound
  // paths and anything a shell command starts are outside `network_policy`. A
  // model that believes the machine is offline either gives up on work it could
  // legitimately do, or tries another route, succeeds, and learns that the stated
  // policy is decorative. Naming the scope avoids both without advertising a way
  // around it.
  if (technical.includes('network_policy=deny-all')) return 'Network access is disabled for this tool in the current security mode.';
  if (technical.includes('guarded egress policy')) return 'That server is not reachable under the current egress policy. Connect it as an API via api_setup, or ask your operator to allow it.';
  if (technical.includes('unrecognised egress policy')) return 'Network access is blocked by an unrecognised egress policy configuration.';
  if (technical.includes('allow-list')) return 'That server is not in the allowed list for this security mode.';
  if (technical.includes('too many redirects')) return 'The server redirected too many times. The URL may be incorrect.';
  if (technical.includes('hourly')) return 'Hourly request limit reached. Try again later.';
  if (technical.includes('daily')) return 'Daily request limit reached. Try again tomorrow.';
  if (technical.includes('session')) return 'Request limit reached for this session.';
  return technical;
}

/**
 * A block the agent must READ — recorded in the ledger as a failure all the same.
 *
 * ## Why a returned block became a thrown one
 *
 * The handler declines a request in fourteen places and RETURNED the refusal as
 * an ordinary string, because the model has to read it and adapt (retry another
 * host, ask the operator, give up on that branch). `agent.ts` books a returned
 * string as a success and writes an EMPTY `output_json`, and
 * `run-history-analytics.ts` derives `error_count` from `output_json != ''`
 * alone. So a blocked call was, in the ledger, byte-for-byte a successful call
 * that had nothing to say.
 *
 * That is not a cosmetic defect. Measured on a real thread (dogfood 2026-08-23):
 * an agent asked to read a PUBLIC repository hit a guarded block on
 * `api.github.com`, saw no failure anywhere, and reported the repository as
 * non-existent — a fact-claim built on a refusal it could not perceive. It then
 * proposed spawning six to eight sub-agents onto an analysis with no codebase.
 * The same defect had already been observed ten days earlier, on the same
 * instance, in the same shape: eight egress blocks at 0–2 ms, every one with an
 * empty output field, none counted. It was written down and not fixed, and it
 * cost the same user a second time.
 *
 * `ToolSoftFailure` is the existing mechanism for exactly this (core#1259): the
 * payload takes the ordinary result path — masked, injection-scanned, truncated,
 * NOT marked `is_error` — while the reason lands in `output_json`, where the
 * counter can see it.
 *
 * What changes is the ledger and the diagnostics channel, not the conversation:
 * `toolEnd` now publishes `success: false` for a refused call, which flips the
 * Bugsink breadcrumb and the debug line. Both are operator surfaces, and both
 * were previously as wrong as the ledger.
 *
 * ## The rule for a fifteenth block
 *
 * Throw, never return. The payload argument must be the string the caller would
 * otherwise have returned, so what the model reads does not change; that is what
 * keeps this an observability fix rather than a behaviour change in disguise.
 *
 * Not every refusal goes through here, and that is deliberate: the `catch` at
 * the bottom of the handler re-throws a network-layer block as an ordinary
 * `Error`, which the agent loop already books as a failure and shows the model
 * as `is_error`. Only the paths that RETURNED were silent, so only they moved.
 *
 * The `technical` reason is what an operator needs and the friendly text
 * deliberately withholds: which rule fired, and — where the rule is
 * host-specific — on which host. It is safe to record because `agent.ts` masks
 * it through `maskSecrets` and bounds it before persisting, and because the
 * input row beside it already carries the same URL.
 */
function blockedFriendly(technical: string): never {
  throw new ToolSoftFailure(friendlyBlockMessage(technical), technical);
}

/**
 * As {@link blockedFriendly}, for the blocks this handler phrases itself.
 *
 * Deliberately NOT routed through `friendlyBlockMessage`: its rules match on
 * substrings, and these messages are not written to avoid them — a consent
 * refusal mentioning "this session" would be rewritten into "Request limit
 * reached for this session", which is a different and false statement. Passing
 * the message through unchanged keeps the model-visible bytes identical to what
 * the `return` produced.
 */
function blockedVerbatim(message: string): never {
  throw new ToolSoftFailure(message, message);
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
  // Which egress surface this ride is — REQUIRED so the `guarded` policy can
  // open discovery reads while gating full-control targets (no safe default).
  surface: EgressSurface,
  ctx?: ToolContext | undefined,
  // Slice B: for a capability-contract-governed write, every redirect hop must
  // ALSO stay within the contract — `isDangerous`/the consent gate only saw the
  // ORIGINAL url, so without this a 307/308 to another (network-allow-listed)
  // host would carry the POST body past the contract's host/path pin (S1).
  // Returns true if the hop is permitted. Omitted for non-contract calls (no
  // redirect-behaviour change).
  redirectGuard?: ((nextUrl: string, method: string) => boolean) | undefined,
  // Union of connected api_profiles' human-accepted egress hosts, consulted only
  // for a full-control surface under `guarded`. Computed in the handler (where
  // the ApiStore resolves) and re-checked here per redirect hop.
  guardedAckHosts?: ReadonlySet<string> | undefined,
  // An engine-attached credential header whose name is NOT in the fixed
  // cross-origin drop set. `CROSS_ORIGIN_DROP_HEADERS` covers Authorization,
  // Cookie and the common `X-Api-Key`/`X-Auth-Token` spellings, but an
  // `auth.type: 'header'` profile names its own slot — `Private-Token`,
  // `X-Shopify-Access-Token`, anything — and the engine now fills it from the
  // vault on every request. One 302 off the accepted host would otherwise replay
  // that credential to the new origin, and it is exempt from the egress scan
  // precisely because the engine put it there.
  extraCredentialHeader?: string | undefined,
  // Returns the FINAL hop alongside the response. Callers need the URL, not
  // just the bytes: cost attribution profiles by hostname, and link extraction
  // resolves relative hrefs against it and filters on its origin — so handing
  // back the REQUESTED url lets one 302 to an attacker attribute the attacker's
  // paths to the origin the agent trusts, which it will then call WITH the
  // credentials that origin's api_profile carries. `response.url` cannot serve
  // here: fetchPinned constructs its Responses, so that field is always empty.
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  // Carried explicitly so credential headers (incl. the engine-attached OAuth2
  // Bearer) can be dropped on a cross-origin hop (mirror fetch()); see
  // redirectHopHeaders.
  let headers = flattenHeaders(init.headers);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    assertHostPolicy(currentUrl, surface, ctx, guardedAckHosts);
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
      return { response, finalUrl: currentUrl };
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
    headers = redirectHopHeaders(headers, currentUrl, nextUrl, extraCredentialHeader);
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
    // Invalid URL — will be caught by assertHostPolicy later
  }
  return null;
}


/** Outcome of the engine-managed auth attach. */
interface AttachedAuth {
  /** Lower-cased header the engine filled. The egress scan skips exactly this one. */
  slot?: string | undefined;
  /** Set when the engine REFUSED — the handler returns this verbatim and sends nothing. */
  refusal?: string | undefined;
  /** Set when the engine declined to attach for a recoverable reason. Surfaced on a 401. */
  hint?: string | undefined;
}

/**
 * Attach the profile's credential to `headers` and report which slot was filled.
 *
 * Runs BEFORE the egress secret scan, which then skips the returned slot. That
 * order is deliberate: the alternative is predicting which slot is about to
 * become engine-owned so the scan can spare it, and a prediction that disagrees
 * with what the attach actually did sends the request with no credential at all.
 *
 * Three outcomes, and the difference matters:
 *   - `slot`    — attached; the scan skips it, redirects drop it cross-origin.
 *   - `refusal` — the engine says no and nothing is sent. Reserved for a profile
 *                 that is trying something it may not: a protected vault key, a
 *                 CRLF-bearing header name. These are attacks, not misconfigurations.
 *   - `hint`    — bearer/header only: could not attach for a recoverable reason (no acceptance on
 *                 record, no vault key, empty value). Nothing is dropped, the
 *                 model's own header stands, and the request proceeds exactly as
 *                 it does today; the hint rides along on a 401 so the cause is
 *                 nameable instead of silent. `custom_endpoint_ack` only exists
 *                 since 2026-07-02 and `regateMigratedApiConnections` strips it on
 *                 self→managed import, so refusing here would break integrations
 *                 that work today, on upgrade, with no action by their owner.
 */
async function attachEngineManagedAuth(
  url: string,
  headers: Record<string, string>,
  toolContext: ToolContext | undefined,
  agent: import('../../types/index.js').IAgent,
): Promise<AttachedAuth> {
  const secretStore = agent.secretStore;
  if (!toolContext?.apiStore || !secretStore) return {};

  let profile: ReturnType<NonNullable<ToolContext['apiStore']>['getByHostname']>;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
    profile = toolContext.apiStore.getByHostname(hostname);
  } catch {
    return {}; // invalid URL — assertHostPolicy reports it downstream
  }
  const auth = profile?.auth;
  if (!profile || !auth) return {};

  /** Replace the slot case-insensitively so no second, differently-cased entry survives. */
  const put = (name: string, value: string): AttachedAuth => {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    }
    headers[name] = value;
    return { slot: name.toLowerCase() };
  };

  // The engine is about to hand a stored credential to this host, so the host must
  // be vetted or carry a recorded human acceptance. `isVettedEgressHost`, not
  // `isAllowlistedEndpoint`: the latter also vouches for `*.openai.azure.com`, a
  // namespace ANY account can register (see its own docstring). Under the broader
  // check, a prompt-injected agent could point a profile at `x.openai.azure.com`,
  // save it with no human prompt because it reads as allowlisted, and have the
  // engine attach a vault credential to an attacker's host — past the scan that
  // would otherwise have caught it, since the engine's own slot is exempt.
  // Same question api_setup asks when it decides whether to prompt for acceptance.
  // They must agree: when they did not, the attach demanded an ack that api_setup
  // would never create — see isVettedEgressHost.
  const hostVetted = isVettedEgressHost(url) || isEndpointAcked(profile.custom_endpoint_ack, url);

  if (auth.type === 'oauth2') {
    // Wave 5d runtime egress gate (base_url parity with fetch_token). A profile can
    // enter the store without passing the save-time gate (loadFromDirectory at boot,
    // or a JSON dropped into the apis dir), so re-verify here, fail-closed.
    if (!hostVetted) {
      return { refusal: `Error: api_profile "${profile.id}" maps to a non-vetted sub-processor (${hostname}) with no recorded acceptance — refusing to attach the managed access_token to that host. Re-save the profile via api_setup({ action: "update", ... }) and accept controller-responsibility when prompted to unblock.` };
    }
    // Profile drives — the agent should NOT have to remember which vault key holds
    // the current access_token. Prevents two failure modes: a stale key re-referenced
    // after api_setup recreated the profile (staging 2026-05-18: fetch_token had
    // written SHOPIFY_SEO_ACCESS_TOKEN, the agent kept reaching for
    // SHOPIFY_ACCESS_TOKEN → 401 forever), and rotation, where every later request
    // should pick up a freshly minted token automatically.
    const tokenKey = `${profile.id.toUpperCase().replace(/-/g, '_')}_ACCESS_TOKEN`;
    const resolved = secretStore.resolve(tokenKey);
    if (!resolved) {
      return { refusal: `Error: api_profile "${profile.id}" is oauth2 but the vault has no access_token under "${tokenKey}". Mint one first with: api_setup({ action: "fetch_token", id: "${profile.id}" }). Requires client_id + client_secret already stored under the keys configured in auth.oauth.` };
    }
    return put('Authorization', `Bearer ${resolved}`);
  }

  if (auth.type === 'basic' && auth.basic_format === 'user_pass_split') {
    // The model CANNOT do this one itself: Basic is base64(user:pass) and it never
    // holds either half, only `secret:NAME` refs resolved after it has composed the
    // header. You cannot Base64-encode a value you do not have.
    if (!hostVetted) {
      return { refusal: `Error: api_profile "${profile.id}" maps to a non-vetted sub-processor (${hostname}) with no recorded acceptance — refusing to attach the stored credentials to that host. Re-save the profile via api_setup({ action: "update", ... }) and accept controller-responsibility when prompted to unblock.` };
    }
    // HTTPS only. Unlike the oauth2 sibling's rotatable access_token this is a
    // long-lived password the operator typed once; `getByHostname` keys on hostname
    // alone, so without this an `http://` URL to the same host would ship it clear.
    if (!url.toLowerCase().startsWith('https://')) {
      return { refusal: `Error: api_profile "${profile.id}" uses stored credentials — refusing to attach them over a non-HTTPS URL. Use https://.` };
    }
    // Explicit keys win; otherwise the first two `vault_keys` IN ORDER. A profile
    // carrying both would otherwise authenticate as whichever the array listed first.
    const userKey = auth.username_key ?? auth.vault_keys?.[0];
    const passKey = auth.password_key ?? auth.vault_keys?.[1];
    if (!userKey || !passKey) {
      return { refusal: `Error: api_profile "${profile.id}" is basic/user_pass_split but does not name two vault keys. Set auth.username_key and auth.password_key (or list both in auth.vault_keys, username first) via api_setup({ action: "update", ... }).` };
    }
    const protectedKeys = [userKey, passKey].filter(k => isProtectedSecretWrite(k));
    if (protectedKeys.length > 0) {
      return { refusal: protectedKeyRefusal(profile.id, protectedKeys.join(' + ')) };
    }
    const user = secretStore.resolve(userKey);
    const pass = secretStore.resolve(passKey);
    // Truthiness, not a null check: an EMPTY vault value would ship
    // `Basic base64("ck:")` — a half-credential that reads as an auth failure
    // rather than as a missing secret.
    if (!user || !pass) {
      const missing = [user ? null : userKey, pass ? null : passKey].filter(Boolean).join(' + ');
      return { refusal: `Error: api_profile "${profile.id}" is basic/user_pass_split but the vault has no usable value for ${missing}. Ask the user for the credential with ask_secret, then retry.` };
    }
    return put('Authorization', `Basic ${Buffer.from(`${user}:${pass}`, 'utf-8').toString('base64')}`);
  }

  if (auth.type === 'bearer' || auth.type === 'header') {
    // The last two types the model still had to attach by hand — and the reason a
    // bexio connection could not be made at all on 2026-08-08. The model CAN compose
    // these (the value goes on the wire as-is), but it cannot survive doing so: it
    // holds only a `secret:NAME` ref that agent.ts resolves before this handler runs,
    // so the scanner sees the real credential, and for a token shaped like one it
    // knows (a JWT, `ghp_…`, `sk-…`) it blocks the request to the very host the
    // operator authorised. bexio issues JWTs, so `bearer` there had NO working path.
    //
    // Below this line every exit is a `hint`, not a `refusal`, except the two that
    // catch a profile reaching for something it may not have.
    const tokenKey = auth.vault_keys?.[0];
    if (!tokenKey) {
      return { hint: `api_profile "${profile.id}" is auth.type="${auth.type}" but names no vault key, so the engine could not attach the credential. Set auth.vault_keys: ["YOUR_KEY_NAME"] via api_setup({ action: "update", ... }) and store the value with ask_secret.` };
    }
    // The bound the oauth2 branch gets for free by deriving its key from the profile
    // id. This name comes from the PROFILE, which a prompt-injected agent can author:
    // without it, `vault_keys: ['ANTHROPIC_API_KEY']` hands the tenant's own provider
    // key to whatever host the profile names. `isProtectedSecretWrite`, not
    // `isInfraSecret` — the provider slots live in a separate set that
    // `isInfraSecret` does not cover, and they are exactly what such a profile wants.
    if (isProtectedSecretWrite(tokenKey)) {
      return { refusal: protectedKeyRefusal(profile.id, tokenKey) };
    }
    if (!hostVetted) {
      return { hint: `api_profile "${profile.id}" maps to ${hostname}, which is not a vetted sub-processor and carries no recorded acceptance, so the engine did not attach the stored credential. Re-save the profile via api_setup({ action: "update", ... }) and accept controller-responsibility when prompted.` };
    }
    if (!url.toLowerCase().startsWith('https://')) {
      return { hint: `api_profile "${profile.id}" uses a stored credential and the engine will not attach it over a non-HTTPS URL. Use https://.` };
    }
    const token = secretStore.resolve(tokenKey);
    // Truthiness, not a null check — an empty value would ship a bare `Bearer `,
    // which reads on the wire as a bad token rather than as a missing one.
    if (!token) {
      return { hint: `api_profile "${profile.id}" is auth.type="${auth.type}" but the vault has no usable value for ${tokenKey}. Ask the user for the credential with ask_secret, then retry.` };
    }
    // `header` names its own slot and carries the raw token; `bearer` is the
    // Authorization/`Bearer ` special case. The default matches what the profile
    // description shows the model (api-store.ts) and what bootstrap writes
    // (api-setup.ts) — defaulting to Authorization here would put the token in a
    // header the model was told is called something else, i.e. a silent 401.
    const slot = auth.type === 'bearer' ? 'Authorization' : (auth.header_name ?? 'X-Api-Key');
    const value = auth.type === 'bearer' ? `Bearer ${token}` : token;
    // The handler's CRLF check covers `input.headers` — the agent's own map. These
    // two come from the PROFILE and the VAULT and would otherwise enter having
    // passed nothing; `X-Key\r\nX-Evil: …` would smuggle a second header on a path
    // that exists precisely to bypass the agent.
    if (/[\r\n\0]/.test(slot) || /[\r\n\0]/.test(value)) {
      return { refusal: `Error: api_profile "${profile.id}" produced an auth header containing CRLF/null — refusing to send it. Check auth.header_name and the stored value of ${tokenKey}.` };
    }
    return put(slot, value);
  }

  return {};
}

/** Shared wording — the same refusal for basic and bearer/header. */
function protectedKeyRefusal(profileId: string, keys: string): string {
  return `Error: api_profile "${profileId}" names protected secret(s) ${keys} as its credentials. Those belong to the platform or hold the tenant's own provider key, and are never attached to an outbound request. Use a credential the user supplied for this API.`;
}

/**
 * Apply the API profile's response_shape (if any) to a parsed JSON response.
 * Falls back to standard JSON.stringify on any error; never throws.
 */
async function maybeShapeJson(json: unknown, url: string, toolContext: ToolContext | undefined): Promise<string> {
  const defaultBody = JSON.stringify(json, null, 2);

  // When an EXPLICIT profile shape errors (esp. include paths that matched no
  // fields), surface WHY to the agent so it fixes the paths in one pass instead
  // of thrashing refine→refine. Threaded into every safety-net return below.
  let explicitShapeError: string | undefined;
  const shapeHint = (): string =>
    explicitShapeError
      ? `\n[response_shape not applied — ${explicitShapeError}. Returning the raw response (capped if large) so you can see its real structure; fix the include paths and retry.]`
      : '';

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
      explicitShapeError = result.error;
      if (channels.shapeError.hasSubscribers) {
        channels.shapeError.publish({ profileId: profile.id, hostname, error: result.error });
      }
      // fall through to the safety-net cap below
    }
  }

  // 2. Safety-net: no explicit shape (or it errored). Return raw unless the body
  //    is large enough to bloat the context, then apply the generic structural cap.
  if (defaultBody.length <= DEFAULT_SHAPE_THRESHOLD_CHARS) return defaultBody + shapeHint();
  const capped = applyShape(json, DEFAULT_LARGE_RESPONSE_SHAPE);
  if (capped.error) return defaultBody + shapeHint();
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
    `define a response_shape on this API profile for precise field selection, or use spawn_agent role='collector' to work the full dataset in an isolated context.]` +
    shapeHint();
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
    // The cap is stated HERE because the model cannot plan around a limit it only
    // discovers by hitting it. Before this line it learned about the ceiling at
    // request 101 — mid-bulk, with no way to have batched differently. The escape
    // is named in the same breath, because "you will be stopped" without "here is
    // how to not be" only teaches the model to give up.
    description: `Make an HTTP request to a specific API endpoint. Use for authenticated APIs, custom endpoints, or structured data fetching. For general web search or reading public pages, use web_research instead. Capped at ${MAX_REQUESTS_PER_SESSION} per conversation, shared with sub-agents (so splitting into sub-agents buys nothing). For more, save a workflow and fire it per batch via task_create(workflow_id, params) — each firing gets a fresh budget.`,
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
          blockedFriendly(`Blocked: hourly HTTP request limit (${hourlyLimit}) exceeded. Count: ${hourlyCount}.`);
        }
      }
      if (dailyLimit < Infinity) {
        const dailyCount = rateLimitProvider.getToolCallCountSince('http_request', 24);
        if (dailyCount >= dailyLimit) {
          blockedFriendly(`Blocked: daily HTTP request limit (${dailyLimit}) exceeded. Count: ${dailyCount}.`);
        }
      }
    }

    // Check session rate limit before any validation — only increment on actual request attempt
    if (agent.sessionCounters.httpRequests >= MAX_REQUESTS_PER_SESSION) {
      blockedFriendly(`Blocked: session HTTP request limit (${MAX_REQUESTS_PER_SESSION}) exceeded.`);
    }

    // Per-API rate limiting + profile enforcement (from API Store)
    if (toolContext?.apiStore && toolContext.apiStore.size > 0) {
      try {
        const reqHostname = new URL(input.url).hostname;
        // Check per-API rate limit
        const apiBlock = toolContext.apiStore.checkRateLimit(reqHostname);
        if (apiBlock) {
          blockedFriendly(apiBlock);
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
      } catch (err) {
        // A block raised INSIDE this try must not be swallowed by it. The catch
        // exists for one thing — a malformed URL, which `assertHostPolicy`
        // reports properly further down — and a bare `catch {}` around a
        // `throw` turns a refusal into a request that proceeds. The per-API
        // rate limit used to `return` from here, so the hazard arrived with
        // this change; the guard covers any future throw in this block too.
        if (err instanceof ToolSoftFailure) throw err;
        // Invalid URL — will be caught below
      }
    }

    const method = input.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) {
        blockedVerbatim(`Blocked: header '${key}' contains invalid characters (CRLF/null).`);
      }
      headers[key] = value;
    }

    // Engine-managed auth runs BEFORE the egress scan, and reports back the slot
    // it actually filled. The scan then skips exactly that slot.
    //
    // The ordering is the whole design. Attaching after the scan needs someone to
    // PREDICT, before the fact, which slot is about to be engine-owned so the scan
    // can spare it — and a prediction that disagrees with the attach is a request
    // sent with no credential at all. Attaching first replaces the prediction with
    // an observation: `attachedAuthSlot` is set by the code that did the attaching.
    //
    // It also makes the change additive. When the engine cannot attach — no
    // acceptance recorded, no vault key, no `secretStore` on this agent — nothing
    // is dropped, the model's own header stands and is scanned exactly as it is
    // today. A profile that works now keeps working; `custom_endpoint_ack` only
    // exists since 2026-07-02 and the self→managed migration strips it on purpose,
    // so anything else would break live integrations on upgrade.
    const auth = await attachEngineManagedAuth(input.url, headers, toolContext, agent);
    // A refusal means nothing was sent — a failed call, not a quiet one. It is
    // phrased for the model (`Error: api_profile "x" is oauth2 but the vault has
    // no access_token …`), so it goes to the ledger verbatim.
    if (auth.refusal) blockedVerbatim(auth.refusal);
    const attachedAuthSlot = auth.slot;

    // Egress secret scan over AGENT-SUPPLIED header values (all methods).
    // Headers are an equally valid exfil channel as bodies — `Authorization:
    // Bearer sk-ant-…` on a GET to a third-party host hands the credential
    // over just as plainly as POSTing it in JSON. The engine-managed slot above
    // is skipped: the engine put that value there from the vault, on the
    // profile-driven path, and re-scanning it would flag the profile's OWN
    // credential (a bexio PAT is a JWT). Anything the agent hand-set is what
    // we're trying to catch here, and on every other header it still is.
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (attachedAuthSlot !== undefined && headerName.toLowerCase() === attachedAuthSlot) continue;
      const headerMatch = detectSecretInContent(headerValue);
      if (headerMatch) {
        blockedVerbatim(`Blocked: request header '${headerName}' appears to contain a ${headerMatch}. Sending secrets to external servers is not allowed.`);
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
    } catch { /* invalid URL — assertHostPolicy reports it below */ }
    if (urlAuthType !== 'query') {
      const urlSecretMatch = detectSecretInContent(input.url);
      if (urlSecretMatch) {
        blockedVerbatim(`Blocked: request URL appears to contain a ${urlSecretMatch}. Sending secrets to external servers is not allowed.`);
      }
    }


    // Under the `guarded` egress policy a full-control http_request may reach
    // only baseline ∪ the operator floor ∪ hosts a connected api_profile was
    // human-accepted for. Compute that accepted-host union here (the handler is
    // where the ApiStore resolves) and gate the target BEFORE the exfil /
    // write-consent prompts below — so a to-be-blocked host never triggers a
    // pointless consent prompt and returns the correct block reason.
    // fetchWithValidatedRedirects re-checks it per redirect hop.
    const guardedAckHosts = resolveGuardedAckHosts(toolContext);
    if (toolContext?.networkPolicy === 'guarded') {
      try {
        assertHostPolicy(input.url, 'full-control', toolContext, guardedAckHosts);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Blocked:')) {
          blockedFriendly(err.message);
        }
        // Non-Blocked (e.g. malformed URL) — defer to existing downstream handling.
      }
    }

    // GET-based exfiltration detection
    if (method === 'GET' || method === 'HEAD') {
      const exfilWarning = detectGetExfiltration(input.url);
      if (exfilWarning) {
        if (!agent.promptUser) {
          blockedVerbatim(`Blocked: ${exfilWarning}`);
        }
        const answer = await agent.promptUser(
          pv`⚠ http_request: ${exfilWarning} — Allow?`,
          ['Allow', 'Deny', '\x00'],
        );
        if (!['y', 'yes', 'allow'].includes(answer.toLowerCase())) {
          blockedVerbatim(`Blocked: ${exfilWarning} — denied by user.`);
        }
      }
    }

    // Request body secret scanning (POST/PUT/PATCH)
    if (input.body && WRITE_METHODS.has(method)) {
      const secretMatch = detectSecretInContent(input.body);
      if (secretMatch) {
        blockedVerbatim(`Blocked: request body appears to contain a ${secretMatch}. Sending secrets to external servers is not allowed.`);
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
          blockedVerbatim(`Blocked: outbound ${method} to ${hostname} requires user consent but no interactive prompt is available (autonomous/background mode).`);
        }
        const promptUser = agent.promptUser;
        let pending = pendingMap.get(hostname);
        if (!pending) {
          pending = (async () => {
            try {
              const answer = await promptUser(
                pv`⚠ http_request: ${method} to ${hostname} — Allow outbound data?`,
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
          blockedVerbatim(`Blocked: outbound ${method} to ${hostname} denied by user.`);
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
      const { response, finalUrl: finalRequestUrl } = await Promise.race([
        fetchWithValidatedRedirects(input.url, opts, 'full-control', toolContext, redirectGuard, guardedAckHosts, attachedAuthSlot),
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

      // HTML gets the same protection JSON has had: a large page is extracted to
      // text instead of dumping raw markup into the context. Opt-out via
      // `http_html_extract: false` for the scraping case that needs the markup.
      const isHtml = !isJson && isHtmlContentType(contentType);
      const htmlExtractEnabled = agent.toolContext?.userConfig?.http_html_extract ?? true;
      let htmlExtracted: HtmlExtractResult | undefined;

      if (isJson && !truncated) {
        try {
          const json = JSON.parse(text) as unknown;
          // Apply per-API response shaping if the profile defines one.
          const shapedBody = await maybeShapeJson(json, input.url, toolContext);
          body = shapedBody;
        } catch {
          body = text;
        }
      } else if (isHtml && htmlExtractEnabled && text.length > DEFAULT_HTML_EXTRACT_THRESHOLD_CHARS) {
        const extracted = extractHtmlText(text, { baseUrl: finalRequestUrl });
        // A near-empty extraction means the page is JS-rendered — the raw markup
        // still carries more (inline JSON, data attributes), so keep it.
        if (extracted.bodyChars >= MIN_USEFUL_EXTRACT_CHARS) {
          htmlExtracted = extracted;
          body = extracted.text;
        } else {
          body = text;
        }
      } else {
        body = text;
      }

      if (htmlExtracted) {
        body +=
          `\n[note: HTML auto-extracted to text (${htmlExtracted.beforeChars}→${htmlExtracted.afterChars} chars) ` +
          `to protect the context window — title, meta/OG tags, headings and visible text kept; ` +
          `scripts, styles and markup dropped` +
          (htmlExtracted.truncated ? `; the extracted text itself hit the ${DEFAULT_HTML_EXTRACT_MAX_CHARS}-char cap` : '') +
          `. For reading public pages prefer \`web_research\` with action='read'. ` +
          `Set "http_html_extract": false in config if you need the raw markup.]`;
      }

      if (truncated) {
        const limitKB = Math.round(readLimit / 1024);
        // Active delegation hint: a half-cut response in the main context is
        // expensive (eats the cap, may still miss the field the agent needs).
        // A collector sub-agent can fetch + summarize in an isolated context
        // and return only the relevant slice — that's the cheaper path. After a
        // successful extraction that bloat is already gone, so the hint would be
        // wrong advice — say only that the page was longer than what we read.
        body += htmlExtracted
          ? `\n[note: the page exceeded the ${limitKB}KB read limit — the extraction above covers its first ${limitKB}KB.]`
          : `\n... [truncated — response exceeded ${limitKB}KB limit. ` +
            `For large responses prefer \`spawn_agent\` with role='collector' ` +
            `(it fetches + summarizes in an isolated context, no main-context bloat). ` +
            `Or bump "http_response_limit" in config if the full body is unavoidable.]`;
      }

      const rawResult = `HTTP ${status}\n${respHeaders.join('\n')}\n\n${body}`;
      // Wrap response in data boundary markers (prompt injection defense)
      const { wrapUntrustedData } = await import('../../core/data-boundary.js');
      let wrapped = wrapUntrustedData(rawResult, 'http_response');

      // Engine-managed-auth 401-hint. When the engine DECLINED to attach a
      // credential it did not fail the request — a profile that works today keeps
      // working — so the reason would otherwise be invisible and the 401 would
      // read as a bad token. That is the exact loop this whole change exists to
      // end: three token rotations against a request that carried no credential.
      // Outside the untrusted_data wrap: system guidance, not response data.
      if (response.status === 401 && auth.hint !== undefined) {
        wrapped += `\n\n**[Agent reminder — the engine did not attach this profile's credential]**\n${auth.hint}\nUntil then the request goes out with only the headers you set yourself.`;
      }

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
        // Attribute to the final URL after redirects, so a chain landing on a
        // different host is profiled against its actual endpoint. This used to
        // read `response.url || input.url`, and `response.url` is always ''
        // because fetchPinned constructs the Response — so it silently did the
        // opposite of what this comment promised.
        const parsedFinal = new URL(finalRequestUrl);
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
      // A soft failure leaves untouched. `ToolSoftFailure` extends Error with
      // the REASON as its message, and `blockedFriendly`'s reason starts with
      // "Blocked:" — so the branch two lines down would match it, re-wrap it as
      // an ordinary Error, and run `friendlyBlockMessage` over an already
      // friendly string. The refusal would arrive as `is_error` with a
      // double-mapped message, i.e. a behaviour change, silently.
      //
      // No refusal site is inside this try today (all fourteen are above line
      // 900). This exists because `blockedFriendly`'s doc comment tells the next
      // person to throw rather than return, and following that rule HERE would
      // otherwise be the trap. A rule that is safe only outside one region of
      // the file needs the region to enforce it, not the reader to remember.
      if (err instanceof ToolSoftFailure) throw err;
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
