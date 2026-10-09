import type { ToolEntry } from '../../types/index.js';
import { urlScanForms } from '../../core/url-scan-forms.js';
import { applyShape } from '../../core/api-shape.js';
import type { ResponseShape } from '../../core/api-store.js';
import { accessTokenKey, hasRevokedGrant, recordedWrites, refreshTokenKey } from '../../core/api-store.js';
// Not from `types/index.js`: `ApiProfile` is one of the exported types that
// does not live in the barrel, which `CLAUDE.md` says to look for rather than
// assume. The barrel import typechecks as a namespace and fails on the member.
import type { ApiProfile } from '../../core/api-store.js';
import { revokedGrantMessage, tokenFingerprint } from '../../core/oauth-refresh-failure.js';
import { shapedForLog, VAULT_NAME_SHAPE, DERIVED_NAME_SHAPE, GRANT_TYPE_SHAPE, HTTP_HEADER_NAME } from '../../core/profile-value-shape.js';
import { OAUTH_PRESETS } from '../../core/oauth-presets.js';
import { isOwnerPrincipal } from '../../core/request-principal.js';
import { newCorrelationId } from '../../core/audit-log.js';
import type { AuditPhase } from '../../core/audit-log.js';
import { secretsForProfile } from '../../core/profile-secret-view.js';
import { channels } from '../../core/observability.js';
import type { ToolContext } from '../../core/tool-context.js';
import { resolveGuardedAckHosts } from '../../core/tool-context.js';
import { isFeatureEnabled } from '../../core/features.js';
import { repairStrayCloseTag } from './model-json-body.js';
import { fetchPinned, flattenHeaders, redirectHopHeaders, isCrossOriginHop, assertHostPolicy } from '../../core/network-guard.js';
import type { EgressCall, HostPolicyContext } from '../../core/network-guard.js';
import { contractGrants } from '../permission-guard.js';
import { WRITE_POSSIBLY_LANDED_PREFIX, ungrantedWriteNote, urlForNote } from '../../core/write-notes.js';
import { isEndpointAcked, isVettedEgressHost } from '../../core/llm/endpoint-allowlist.js';
import { isProtectedSecretWrite, SECRET_SHAPES } from '../../core/secret-store.js';
import type { SecretShape, SecretShapeKind } from '../../core/secret-store.js';
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
import { noteAnsweredBy, noteCallConnection } from '../../core/call-connection.js';
import { approvalKey, currentEpoch, isApproved, normalizeApprovalHost, recordApproval } from '../../core/untrusted-epoch.js';
import { bodyFieldNames, effectiveWriteMethod, retargetingHeader, isOutboundEffectWrite, normalizeWritePath, pathForQuestion } from '../../core/outbound-write.js';
import { inSessionPromptChain } from '../../core/prompt-chain.js';

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
 * `getToolStats` derives its `error_count` from that field
 * (`output_json != '' AND != '{}'`) and reads no other column for it. So a
 * blocked call was, in that view, byte-for-byte a successful call that had
 * nothing to say.
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
 * As {@link blockedFriendly}, for the refusals phrased outside
 * `friendlyBlockMessage` — the ones this handler writes itself, plus
 * `auth.refusal`, which `attachEngineManagedAuth` phrases.
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

/**
 * A redirect refused after a write was already sent: the host received the request and
 * answered it, so the write may have happened even though the call ends refused. Its own
 * class so the handler can say that instead of "blocked", ahead of the generic rewrite.
 */
export class RedirectRefusedAfterWrite extends Error {
  constructor(method: string, sentUrl: string, redirectUrl: string, why: 'grant' | 'consent' = 'grant') {
    super(
      `${WRITE_POSSIBLY_LANDED_PREFIX} ${method} ${urlForNote(sentUrl)} was sent and answered with a redirect to ` +
      (why === 'grant'
        ? `${urlForNote(redirectUrl)}, which this run's grant does not cover; the redirect was not followed. ` +
          `Do not repeat the request: check the target system for whether it was carried out.`
        : `${urlForNote(redirectUrl)}, which needs its own approval; the redirect was not followed. ` +
          `Check the target system for whether the request was carried out. A request sent to that address directly asks first.`),
    );
    this.name = 'RedirectRefusedAfterWrite';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Write approvals denied in a tool batch, keyed by the batch's identity (`IAgent.approvalBatch`):
 *  a call of the same batch that waited on that question is refused without asking again. */
const deniedInBatch = new WeakMap<object, Set<string>>();
/** In-flight consent questions of a tool batch, keyed like `deniedInBatch`, by the question:
 *  parallel calls with the same question share one answer instead of asking twice. */
const pendingInBatch = new WeakMap<object, Map<string, Promise<boolean>>>();
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
  // Which egress surface this ride is, AND the allowance it is entitled to —
  // REQUIRED so the `guarded` policy can open discovery reads while gating
  // full-control targets and admitting a connector to its own hosts (no safe
  // default). Re-applied per redirect hop, so an allowed host cannot 302 to a
  // forbidden one on any surface.
  call: EgressCall,
  // Only the host-policy fields are read here. Typed as the narrow structural
  // interface rather than ToolContext so a connector caller — which holds a
  // policy, not a tool context — can pass one without inventing the rest.
  ctx?: HostPolicyContext | undefined,
  // Slice B: for a capability-contract-governed write, every redirect hop must
  // ALSO stay within the contract — `isDangerous`/the consent gate only saw the
  // ORIGINAL url, so without this a 307/308 to another (network-allow-listed)
  // host would carry the POST body past the contract's host/path pin (S1).
  // Returns true if the hop is permitted. Omitted for non-contract calls (no
  // redirect-behaviour change).
  //
  // `'consent'` refuses the hop as one that needs its own approval (an interactive write whose
  // target the approval did not show), with the note that says so; `false` refuses it as
  // outside the contract.
  redirectGuard?: ((nextUrl: string, method: string) => boolean | 'consent') | undefined,
  // An engine-attached credential header whose name is NOT in the fixed
  // cross-origin drop set. `CROSS_ORIGIN_DROP_HEADERS` covers Authorization,
  // Cookie and the common `X-Api-Key`/`X-Auth-Token` spellings, but an
  // `auth.type: 'header'` profile names its own slot — `Private-Token`,
  // `X-Shopify-Access-Token`, anything — and the engine now fills it from the
  // vault on every request. One 302 off the accepted host would otherwise replay
  // that credential to the new origin, and it is exempt from the egress scan
  // precisely because the engine put it there.
  extraCredentialHeader?: string | undefined,
  // True for a header value that carries a resolved secret. On a cross-origin hop such a
  // header is dropped whatever it is called: the fixed credential set below cannot know a
  // header name the caller chose, and the secret was bound to the FIRST host only.
  carriesSecret?: ((value: string) => boolean) | undefined,
  // Returns the FINAL hop alongside the response. Callers need the URL, not
  // just the bytes: cost attribution profiles by hostname, and link extraction
  // resolves relative hrefs against it and filters on its origin — so handing
  // back the REQUESTED url lets one 302 to an attacker attribute the attacker's
  // paths to the origin the agent trusts, which it will then call WITH the
  // credentials that origin's api_profile carries. `response.url` cannot serve
  // here: fetchPinned constructs its Responses, so that field is always empty.
): Promise<{ response: Response; finalUrl: string; hosts: string[] }> {
  let currentUrl = url;
  // Every host the request reached, the final one included: an answer counts as the approved
  // host's own only when all of them are that host.
  const hosts: string[] = [];
  let method = (init.method ?? 'GET').toUpperCase();
  const originalMethod = method;
  let body = init.body;
  // Carried explicitly so credential headers (incl. the engine-attached OAuth2
  // Bearer) can be dropped on a cross-origin hop (mirror fetch()); see
  // redirectHopHeaders.
  let headers = flattenHeaders(init.headers);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    assertHostPolicy(currentUrl, call, ctx);
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
    hosts.push(new URL(currentUrl).hostname);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl, hosts };
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
    if (carriesSecret && isCrossOriginHop(currentUrl, nextUrl)) {
      headers = Object.fromEntries(Object.entries(headers).filter(([, v]) => !carriesSecret(v)));
    }
    // A 307/308 preserves the method + body — drop the body too on a cross-origin
    // hop (e.g. an api_setup OAuth client_secret POST whose token_url issues an
    // open redirect), degrading to a bodyless GET like the 301/302/303 path.
    if (body !== undefined && isCrossOriginHop(currentUrl, nextUrl)) {
      method = 'GET';
      body = undefined;
    }
    const verdict = redirectGuard ? redirectGuard(nextUrl, method) : true;
    if (verdict !== true) {
      // Decided on the method the call STARTED with: after a 303 (or a cross-origin hop)
      // `method` is already GET, and a POST that reached the host would then read as a
      // read that was merely redirected.
      if (verdict === 'consent' || isWriteMethod(originalMethod)) {
        throw new RedirectRefusedAfterWrite(originalMethod, url, nextUrl, verdict === 'consent' ? 'consent' : 'grant');
      }
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

// The write approvals (`approvedWrites`, see `core/untrusted-epoch.ts`) live on
// `agent.sessionCounters`, so an approval never leaks between conversations. The
// consent questions are asked one at a time on the Session's prompt chain
// (`core/prompt-chain.ts`: the PromptStore holds one pending prompt per Session),
// and parallel calls of one batch with the same question share its answer
// (`pendingInBatch`).
/**
 * The undo class of a method's effect on the remote; `null` for the two methods this
 * tool treats as reads.
 *
 * ONE source for two questions that used to be two separate literals in this file: the
 * `undo` class this tool declares, and the method set the consent path plus the
 * request-body secret scan read.
 *
 * What that does and does NOT buy: the two answers are the same BY DERIVATION, so they
 * cannot be edited apart. Nothing stops a future change from writing a second copy of
 * the classification and reading that instead. A copy that re-enumerates the WRITES is
 * caught — it disagrees on every verb outside the enum, and the unknown-verb witness in
 * `http.test.ts` asserts that disagreement at all three sites that read it. A
 * byte-identical copy is not catchable by any test; refusing that one needs a guard over
 * the source, and there is none here.
 *
 * PUT/PATCH overwrite a resource that a prior GET can image, so they are `restorable`.
 * POST is `none`: it is as often an RPC (send, charge, trigger) as a create, and only the
 * response can tell — a POST that returned a created id is compensatable per TARGET,
 * which is the bulk ledger's call, not this declaration's. DELETE is `none`: re-creating
 * a remote resource from its image is not generally possible (the id is the server's).
 */
export function undoClassFor(method: string): 'restorable' | 'none' | null {
  const m = method.toUpperCase();
  // The READS are enumerated, not the writes. Two methods get `null`; everything else gets
  // at least `none` — it may have done something, and putting it back is not ours to
  // promise. (`types/tools.ts` defines the per-input `null` as "an input with no effect".)
  //
  // Enumerating the writes instead left `null` carrying two claims, "a read" and "a verb I
  // do not know", and handed the second one the first one's answer. Since the gate below
  // reads "has an undo class", an unknown verb was then not a write and needed no consent.
  //
  // Why THESE two, and not the four the HTTP spec calls safe: these are the two the schema
  // offers as reads. A verb that is not offered needs no classification here, and the
  // conservative answer for it is the gated one. So this list is "what this tool reads",
  // NOT "what cannot have an effect" — it does not claim to be complete, and adding a
  // method to the enum is a decision the schema test asks for by name.
  if (m === 'GET' || m === 'HEAD') return null;
  if (m === 'PUT' || m === 'PATCH') return 'restorable';
  return 'none';
}

/**
 * A method this tool must not send without consent: everything `undoClassFor` gives an
 * undo class, which after the polarity above means everything except the two reads.
 *
 * Read by both gates below, so the set they apply and the set this tool declares as
 * having an undo class are the same set by construction rather than by agreement.
 *
 * Deliberately WIDER than "changes state on the remote", and the difference is the point:
 * for a verb the classifier does not know, we do not know that it changes anything — only
 * that we cannot rule it out. The name `isWriteMethod` IS that stronger claim and is kept
 * for continuity; read it as "not known to be a read", and resist narrowing it back to the
 * verbs we are sure about, because the write set is the open one.
 */
export function isWriteMethod(method: string): boolean {
  return undoClassFor(method) !== null;
}

/**
 * The message for a request that ran out of time. A request that can change something on the
 * other side — any method but GET and HEAD — may have been received and carried out before the
 * time ran out, and "timed out" alone reads as "did not happen". For a POST or PATCH, sending it
 * again can do it twice; PUT and DELETE are meant to be safe to repeat, but only if the server
 * keeps to that, so they are warned the same way. When the response headers had already arrived
 * (`answeredStatus`, from the final hop after any redirect) and only the body stalled, the
 * request certainly reached a server — a redirect is itself an answer to it.
 */
export function httpTimeoutMessage(timeoutMs: number, method: string, wallClock: boolean, answeredStatus?: string): string {
  const base = `HTTP request timed out after ${timeoutMs}ms${wallClock ? ' (wall clock)' : ''}`;
  const verb = method.toUpperCase();
  const read = answeredStatus === undefined ? '' : ` while reading the response; the server had already answered ${answeredStatus}`;
  if (verb === 'GET' || verb === 'HEAD') return `${base}${read}`;
  const landed = answeredStatus === undefined
    ? `The ${verb} may still have reached the server and taken effect`
    : `The ${verb} reached the server`;
  return `${base}${read}. ${landed} — check the result there before sending it again.`;
}

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

// Credential shapes that must never appear in an outbound request, chosen by
// KIND from the shared list: every provider key format (`vendor`), private-key
// blocks, JWTs, and this scan's own wider spellings (`egress-wide`). A format
// added to the shared list is scanned here without an edit in this file.
// `contextual` (URL userinfo, `Bearer …`) and `generic` (any long token) stay
// out on purpose: outbound bodies and headers legitimately carry long IDs and
// auth headers, and blocking those would refuse ordinary API calls.
const EGRESS_SHAPE_KINDS: ReadonlySet<SecretShapeKind> = new Set(['vendor', 'key-block', 'jwt', 'egress-wide']);
const SECRET_PATTERNS: ReadonlyArray<SecretShape> =
  SECRET_SHAPES.filter((s) => EGRESS_SHAPE_KINDS.has(s.kind));

/**
 * What the model reads when a request is refused for carrying a credential.
 * The scanner cannot tell a real key from a placeholder written in the same
 * format, so the text names the way out for each. For a real key the way out
 * depends on the host's profile, and the three cases get fixed sentences — no
 * profile-authored text enters this string, since it reaches the model before
 * any network call:
 * - `none`: no api_profile for the host → connect the service.
 * - `attached`: the engine attached the profile's key → the extra one is not needed.
 * - `not-attached`: a profile of an engine-attached type (bearer, header, oauth2,
 *   basic with split credentials) exists but its key was not attached → check it.
 * - `model-owned`: a profile whose auth type the engine never attaches (query,
 *   none, pre-encoded basic) → send the key the way the profile describes.
 */
export type EgressProfileState = 'none' | 'attached' | 'not-attached' | 'model-owned';
export function egressSecretRefusal(where: string, label: string, profile: EgressProfileState = 'none'): string {
  const realKey = profile === 'attached'
    ? `The engine already attaches this service's stored key to the request; leave keys out of your own headers, URL and body. `
    : profile === 'not-attached'
      ? `This service has an api_profile, but the engine did not attach its stored key to this request. Check the profile with api_setup (re-save it and accept when prompted, or store its key with ask_secret) instead of putting the key into the request. `
      : profile === 'model-owned'
        ? `This service has an api_profile whose auth type the engine does not attach. Send the key the way the profile describes (a query-parameter profile carries it in the URL), or change the profile's auth type with api_setup. `
        : `If this is a real key for the service you are calling, connect that service with api_setup instead of putting the key into the request — the engine then attaches the stored key itself. `;
  return `Blocked: ${where} appears to contain a ${label}, so this request was not sent. `
    + realKey
    + `If it is example or placeholder text, write it without the key's format (for example <your token>).`;
}

/**
 * The same refusal for outgoing mail. There is no connected-service route for a
 * key in a mail — a real key is never sent by email — so the only way out named
 * is the one for example text.
 */
export function mailSecretRefusal(tool: 'mail_send' | 'mail_reply', label: string): string {
  return `${tool} blocked: the message appears to contain a ${label}. A real key is never sent by email. `
    + `If it is example or placeholder text, write it without the key's format (for example <your token>) and send again.`;
}

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

const BASE64_RUN = /[A-Za-z0-9+/=]{64,}/;

/** A run of 64+ base64 characters that mixes upper case, lower case and digits. */
function hasBase64ShapedRun(text: string): boolean {
  return (text.match(/[A-Za-z0-9+/=]{64,}/g) ?? []).some((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run));
}

/**
 * Detect GET-based data exfiltration via suspiciously long query strings
 * or base64-encoded data in URL parameters.
 */
function detectGetExfiltration(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Flag query strings >500 chars (heuristic for encoded data exfil), measured on the query
    // as sent: percent-decoding only ever shortens a string (each `%XX` becomes one character or
    // one byte), so the form as sent is the upper bound and the conservative one to measure.
    if (parsed.search.length > 500) {
      return 'suspiciously long query string (>500 chars, possible data exfiltration)';
    }
    // Detect base64-looking blobs in URL params — in the query as sent, and in the forms
    // `urlScanForms` decodes it to (one round of percent-decoding). A run found only in a decoded
    // form must also mix upper case, lower case and digits: decoding joins the segments of an
    // encoded path (`%2F`) into one long run, and a path that lacks one of the three classes is
    // not flagged for that. A path that has all three is flagged: the same false-positive class
    // as the same path sent unencoded, but over a larger set of inputs, since it now also hits
    // when the path is encoded. Measured on sample queries in `http.test.ts` (GET_QUERY_SAMPLES).
    const [asSent, ...decoded] = urlScanForms(parsed.search);
    if (BASE64_RUN.test(asSent!) || decoded.some(hasBase64ShapedRun)) {
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
  /**
   * Set when the engine did not attach, for a reason worth naming. Surfaced on a 401.
   *
   * A THUNK, not a string, and both reasons came out of review rather than design.
   * Built eagerly it ran `secretStore.resolve()` on EVERY request to a model-owned
   * profile — publishing a `secretAccess` audit event for a credential the engine
   * never used, on requests that mostly did not 401. And it fixed the wording
   * before the redirect chain was known, while `redirectHopHeaders` strips
   * Authorization on a cross-origin hop: the text then claimed "you set the header
   * yourself" about a request that reached the answering host without one. Both
   * facts are settled only once the response is.
   */
  hint?: ((ctx: HintContext) => string) | undefined;
}

/** What a hint may only know once the response is back. */
interface HintContext {
  /**
   * The final hop changed origin, so `redirectHopHeaders` dropped Authorization /
   * Cookie (`CROSS_ORIGIN_DROP_HEADERS`) — a header the model set did NOT reach
   * the host that answered.
   */
  crossOriginRedirect: boolean;
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
 *   - `hint`    — did not attach, for a reason worth naming. Nothing is dropped, the
 *                 model's own header stands, and the request proceeds exactly as
 *                 it does today; the hint rides along on a 401 so the cause is
 *                 nameable instead of silent. `custom_endpoint_ack` only exists
 *                 since 2026-07-02 and `regateMigratedApiConnections` strips it on
 *                 self→managed import, so refusing here would break integrations
 *                 that work today, on upgrade, with no action by their owner.
 *
 *                 TWO populations, and they were one line apart in intent for a
 *                 while: bearer/header decline for a RECOVERABLE reason (no
 *                 acceptance on record, no vault key, empty value), while the
 *                 model-owned shapes below — basic/pre_encoded_b64, basic with no
 *                 basic_format, query, and `none` — are working as designed and
 *                 hint anyway. A shape the engine will never attach is precisely
 *                 the one whose 401 the model cannot explain on its own.
 */
/**
 * How far before expiry an oauth2 access token is renewed.
 *
 * Derived, not chosen. The token has to stay valid through everything that
 * happens after the check:
 *   · the exchange itself — `TOKEN_EXCHANGE_TIMEOUT_MS` is 15 s
 *     (`core/oauth-token-exchange.ts`);
 *   · then the request it is attached to — `http_request` caps `timeout_ms`
 *     at 60 s and defaults to 30 s (see the tool's schema below).
 * So anything under 75 s can hand a provider a token that dies mid-call, and
 * the failure would look like a revocation rather than a race. Five minutes is
 * four times the hard cap, and it is the value the Google path has used since
 * it was written (`integrations/google/google-auth.ts`) — the one constant a
 * review of that file classified as provider-neutral rather than Google-shaped.
 *
 * ⚠ Degenerate case, named because the arithmetic hides it: a provider issuing
 * tokens shorter than this buffer would be refreshed on every single call. None
 * of the providers this engine connects does — Shopify's client-credentials
 * token lives 24 h — but a profile pointed at one would burn an exchange per
 * request rather than fail, which is the safer of the two wrong behaviours and
 * the reason there is no floor here.
 */
export const OAUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * The longest timeout one `http_request` fetch may be given, whatever it asks for.
 * The handler races the fetch against that timeout plus {@link HTTP_WALL_GRACE_MS},
 * so a stalled body cannot hold a session.
 */
export const HTTP_HARD_CAP_MS = 60_000;

/** How far past its timeout the handler's wall timer lets a fetch run before it gives up on it. */
export const HTTP_WALL_GRACE_MS = 1000;

/**
 * The name `api_setup` registers under. A literal, because a static import of
 * `api-setup.ts` from this module is a cycle — the same reason the renewal below
 * imports it dynamically. Pinned by a test against `apiSetupTool.definition.name`
 * rather than trusted, since a rename here fails open: the gate would stop finding
 * the tool and every renewal would quietly refuse.
 */
const API_SETUP_TOOL_NAME = 'api_setup';

/**
 * Whether a token may be renewed on THIS caller's behalf.
 *
 * Pure and exported so a test can assert the decision without performing it. The
 * renewal writes secrets and posts a client secret; a test that could only reach
 * this judgement by running it would have to run that too.
 *
 * TWO conditions, answering two different questions, and an agent can pass one
 * and fail the other:
 *
 * **1. The right.** Tool scoping in this engine is keyed on `definition.name`
 * (`tools/resolve-tools.ts › resolveTools`, and `tools/resolve-tools.ts › withinSurface` for
 * what a derived list may hold), so
 * calling another tool's handler directly walks past it. Without this check an
 * `http_request` would carry out the write side of `api_setup` for a caller that
 * does not hold `api_setup` — and two populations are exactly in that state:
 * `roles.ts`'s `collector` (which describes itself as writing only to memory), and
 * every workflow step, because `INLINE_CORE_TOOLS` never admits `api_setup` and
 * the step's tools are filtered to that set. So the renewal is allowed only where
 * the caller could have run `fetch_token` itself, which means it adds no right.
 * That is also why it is not enough to read `toolContext.tools`: `session.ts`
 * fills that with the UNSCOPED registry.
 *
 * **2. The guards.** `fetch_token` dereferences two things it is handed:
 * `agent.sessionCounters.httpRequests`, the per-session HTTP budget, and
 * `agent.toolContext`, which it passes to `exchangeToken` as the carrier of the
 * egress controls. A fabricated agent — `{ secretStore } as IAgent` is one that
 * exists — satisfies the compiler and neither of those.
 *
 * ⚠ The runtime checks below look redundant against the types, and are not:
 * `IAgent` declares both fields non-optional, so an `as IAgent` cast is a promise
 * the type system then stops questioning. This is the one place that has to
 * distrust it.
 *
 * ⚠ Condition 2 is UNREACHABLE through `http_request`, and that is the honest
 * description of what it is for. The handler dereferences `agent.toolContext`
 * and `agent.sessionCounters.httpRequests` itself, both before it ever calls the
 * attach — so an agent missing either cannot arrive here by that route. The only
 * other caller is `attachStoredCredential`, the bulk worker effect's entry
 * point, and its fabricated agent is missing BOTH at once. So no behavioural
 * test can separate the two halves, and the predicate tests are the only
 * witnesses that can exist for them. That was measured, after a count of killed
 * mutants said "2" and a count of distinct WITNESSES said "2, both of one kind":
 * the attempt to add an effect-level witness failed on unmutated code, at the
 * handler's own counter check, which is how the unreachability was found.
 *
 * It stays because it is the barrier for the next caller that does not come
 * through the handler — and one exists today.
 *
 * ⚠ The paragraph above is a claim about code that can move, and it is anchored
 * on SYMBOLS rather than line numbers for that reason — but it is NOT pinned by
 * a test, and a reader should know which of the two it is. It cannot be. If the
 * handler's two reads were moved BELOW the attach, the renewal would become
 * reachable for such an agent and this condition would then decline it
 * silently: no exchange, no log, which is observably identical to the handler
 * having thrown first. The only difference would be where the throw comes from,
 * and asserting that pins an unguarded dereference a future cleanup should be
 * free to fix. So the same masking that makes the witness impossible makes the
 * detector impossible, and this is prose on purpose rather than prose for want
 * of effort.
 *
 * ⚠ And condition 2 is NECESSARY, not SUFFICIENT — said plainly because the
 * cheap reading of it is that a caller which passes carries real guards. It
 * refuses a dereference that would throw, and it refuses the fabricated agent
 * that exists today. It cannot certify that a `toolContext` it was handed
 * actually holds a network policy or a rate-limit provider, because a real agent
 * may legitimately have neither set. Nothing here can close that; the durable
 * answer is an authorization recorded when the work is PLANNED and carried by
 * the effect, rather than inferred at runtime from an object's shape.
 */
export function mayRenewOAuthUnattended(agent: import('../../types/index.js').IAgent): boolean {
  // Condition 2 reads first for legibility only. An earlier comment claimed
  // that asking condition 1 first would throw a TypeError on a fabricated
  // agent; it would not, because condition 1 carries its own `typeof` guard
  // before it calls anything. Both orders are safe, and saying otherwise
  // invented a correctness reason for a formatting choice.
  const counters: unknown = agent.sessionCounters;
  if (typeof counters !== 'object' || counters === null) return false;
  if (typeof (counters as { httpRequests?: unknown }).httpRequests !== 'number') return false;
  const toolContext: unknown = agent.toolContext;
  if (typeof toolContext !== 'object' || toolContext === null) return false;

  if (typeof agent.getAvailableTools !== 'function') return false;
  return agent.getAvailableTools().some((t) => t.definition.name === API_SETUP_TOOL_NAME);
}

/**
 * Whether this PROFILE may be renewed unattended — a different question from
 * whether the CALLER may trigger one, which is why it is a second predicate and
 * not another condition in the first.
 *
 * One thing is being protected, in two shapes: a token a USER consented to must
 * never be swapped, unattended, for an app-level one. `fetch_token` posts a
 * client-credentials grant for every `grant_type` but `refresh_token`, absent
 * ones included — so wherever the stored token came from a human at a consent
 * screen, that default is the swap.
 *
 * Allowed, because neither can be that swap:
 *   · `grant_type: 'refresh_token'` — presents the user's own grant back;
 *   · `grant_type: 'client_credentials'`, explicitly chosen;
 *   · neither of those, no refresh token, and no callback behind it — the
 *     hand-built app-only profile this piece exists for, Shopify's shape.
 *
 * Refused:
 *   · anything whose `oauth_grant.origin` is `callback` and that is not a
 *     refresh-token grant;
 *   · a stored refresh token with no explicit `grant_type` — the older,
 *     hand-configured version of the same ambiguity.
 *
 * ⚠ The second refusal used to be the only one, and the first version of this
 * comment argued that it sufficed: a profile with no refresh token "can only
 * mean client_credentials". That is true of a profile somebody BUILT, and false
 * of one `connect` produced — a provider that answers the authorization-code
 * exchange without a refresh token (no `offline_access`, say) leaves exactly
 * that shape, and since the callback writes `token_expires_at` there is now a
 * reader to act on it. The missing discriminator was never the grant type; it
 * was whether a human had been sent to a consent screen, which only
 * `oauth_grant.origin` records.
 *
 * A model calling `fetch_token` by hand can still do all of this. What is
 * refused here is doing it BY ITSELF, on expiry, with nobody choosing it.
 */
export function oauthProfileMayBeRenewedUnattended(
  profile: {
    auth?: { oauth?: { grant_type?: string | undefined; refresh_token_key?: string | undefined } | undefined } | undefined;
    oauth_grant?: { origin?: 'callback' | undefined } | undefined;
  },
  hasStoredRefreshToken: boolean,
): boolean {
  const grantType = profile.auth?.oauth?.grant_type;
  // The only grant that presents the user's own authorization back to the
  // provider. It replaces nothing it did not come from, so where it is named
  // there is nothing to decide.
  if (grantType === 'refresh_token') return true;
  // Past this line the exchange is one the profile cannot mean well: an absent
  // grant type makes `fetch_token` post CLIENT-CREDENTIALS, and a named one that
  // is neither of the two it supports is simply posted and rejected. So the
  // question is no longer "which grant type" but "whose token would that
  // replace", and `oauth_grant.origin` is the one field that answers it: the
  // engine writes it, a value arriving in a create or update is discarded
  // (`api-setup.ts`, the update path reads the stored record back over it), and
  // `callback` means a human sat at the provider's consent screen for this.
  //
  // ⚠ What this does NOT claim, because an earlier version of this comment did:
  // that the engine-owned half is asked FIRST. It is asked second. An injected
  // `api_setup update` setting `grant_type: 'refresh_token'` passes the clause
  // above and never reaches this one — and that is deliberate, because the
  // ordering is what lets a connected profile renew at all. What the engine-owned
  // half protects against is the CLIENT-CREDENTIALS swap specifically, not every
  // model-authored edit: a refresh-token grant presents a token from the
  // profile's own slot and `fetch_token` refuses when that slot is empty, so the
  // worst an inside edit buys is an exchange the caller could have run by hand —
  // which `mayRenewOAuthUnattended` already established it may.
  if (profile.oauth_grant?.origin === 'callback') return false;
  if (grantType === 'client_credentials') return true;
  return !hasStoredRefreshToken;
}

/**
 * Would running `fetch_token` for this profile replace a token a USER consented
 * to with an app-level one?
 *
 * The same question the unattended gate asks, factored out because a SECOND
 * place has to ask it: the 401 reminder further down tells the model to run
 * `fetch_token`, outside the untrusted-data wrap, as system guidance. Without
 * this, declining a renewal only moved the swap one model turn later — the token
 * stays stale, the provider answers 401, and the engine itself instructs the
 * model to perform exactly what the gate refused.
 *
 * ⚠ The two populations OVERLAP; they are not the same set, and an earlier
 * version of this comment said they were. The gate is asked behind
 * `typeof token_expires_at === 'number'` and never looks at `token_url`; the
 * reminder requires `token_url` and never looks at the expiry. So a profile with
 * a token_url and no recorded expiry reaches the reminder and never the gate,
 * and one with an expiry and no token_url reaches the gate and never the
 * reminder. Neither contains the other — which is a reason to ask the same
 * question in both places, not a reason to believe one answer covers both.
 *
 * Narrower than the gate on purpose, and the narrowing is counted rather than
 * assumed: the gate also refuses a grant type no exchange can run, which is
 * posted verbatim and refused — useless by hand, not destructive. Silencing the
 * reminder for that shape would withhold the one action that surfaces it.
 */
export function oauthFetchTokenWouldSwapDelegatedAccess(
  profile: {
    auth?: { oauth?: { grant_type?: string | undefined } | undefined } | undefined;
    oauth_grant?: { origin?: 'callback' | undefined } | undefined;
  },
  hasStoredRefreshToken: boolean,
): boolean {
  const grantType = profile.auth?.oauth?.grant_type;
  // Only an absent or explicit client-credentials grant POSTS one. Any other
  // value is posted verbatim and refused, which is useless rather than
  // destructive — and silencing the reminder for it would withhold the one
  // action that at least reports the real problem.
  if (grantType !== undefined && grantType !== 'client_credentials') return false;
  // A human was sent to a consent screen for this.
  if (profile.oauth_grant?.origin === 'callback') return true;
  // And the OTHER half of the gate's refused set, which the first version of
  // this predicate missed: a hand-configured profile holding a refresh token it
  // never declared. Its access token is a user's too — somebody pasted it — and
  // `fetch_token` would overwrite it with an app-level one. `grantType` is
  // necessarily absent here; an explicit `client_credentials` on such a profile
  // is a renewal the gate PERMITS, so discouraging the manual one would
  // contradict what the engine already does by itself.
  return grantType === undefined && hasStoredRefreshToken;
}

/**
 * What the vault holds in a profile's refresh slot, and WHOSE it is.
 *
 * Three values, not a boolean, because a token this engine wrote and recorded
 * belongs to a grant the engine has an opinion about, and one that merely sits
 * there was put there by somebody. The diagnosis below says which; it is a fact
 * about the profile that nothing else reports.
 *
 * Read through `recordedWrites` and not through `oauth_grant.written` directly.
 * That reader exists because a profile can arrive from `JSON.parse(raw) as
 * ApiProfile` with no schema check — `_admit` validates the id, the slot and the
 * host and says nothing about this field — so `written` can be a string, and
 * `(x ?? []).find` on a string is a TypeError. The attach is not inside a
 * try/catch, so that throw would fail EVERY request to such a profile, while the
 * delete path tolerated the same record in the same run. Two readers of one
 * field, one tolerant and one not, is the defect; there is now one reader.
 */
export function oauthRefreshSlotState(
  profile: ApiProfile,
  slot: string,
  storedValue: string | null,
): 'empty' | 'engine-written' | 'foreign' {
  if (storedValue === null || storedValue === '') return 'empty';
  const recorded = recordedWrites(profile).find((w) => w.name === slot);
  return recorded !== undefined && recorded.fp === tokenFingerprint(storedValue)
    ? 'engine-written'
    : 'foreign';
}

/**
 * What was refused and what is true about the profile — and deliberately NOT
 * what to do about it.
 *
 * ⚠ THIS IS THE FOURTH VERSION, AND THE FIRST THREE EACH PRESCRIBED A REMEDY
 * THAT WAS WRONG FOR A REACHABLE STATE. That history is the design, so it is
 * written down rather than summarised:
 *
 *   · V1 branched on `origin` and the grant type, and told a profile HOLDING a
 *     hand-stored refresh token that the provider had returned none.
 *   · V2 asked "is a token stored" first, and told the one shape the callback
 *     itself manufactures — second consent, no new refresh token, the dead first
 *     one still in the slot — to declare `grant_type: 'refresh_token'`, putting
 *     that dead token back into an unattended exchange.
 *   · V3 enumerated five shapes and five remedies. A review found two of them
 *     wrong: for a connected profile whose NAMED slot holds a usable token it
 *     said to remove the pointer to it — an executable instruction, to a model
 *     holding `api_setup update`, that disconnects the only working credential;
 *     and in the case it WAS written for, the remedy it promised cannot work,
 *     because the callback deletes `grant_type` for that same profile and no
 *     `api_setup update` of `refresh_token_key` restores it.
 *
 * The pattern across all three is one thing: **a remedy is a claim about the
 * NEXT state, and every version checked the current one.** "Remove this field
 * and the renewal will find the token" requires simulating what the gate says
 * afterwards. Three attempts got that wrong in three different places, which is
 * not a reason to write a fourth sentence — it is the measurement that says a
 * hand-written remedy per shape cannot be kept true here.
 *
 * So this function states FACTS and prescribes no profile edit. A fact cannot be
 * wrong about a state transition, because it makes no claim about one.
 *
 * It carries TWO imperatives, which an earlier version of this comment denied:
 * a negative one ("do not resolve this by running the exchange"), true for every
 * refused shape by construction because the refusal IS that; and a positive one
 * that escalates to a human rather than naming an edit. Both live in
 * `DECLINED_DIAGNOSIS_TAIL`, which is a constant precisely so a test can hold
 * the whole closing sentence rather than scan it for banned words.
 *
 * ⚠ If the per-shape remedy comes back, the sentence that must survive with it
 * is this one: **a remedy is a claim about the NEXT state, and all three earlier
 * versions checked the current one.** "Remove this field and the renewal will
 * find the token" requires simulating what the gate answers afterwards. It needs
 * the next state COMPUTED AND ASSERTED, not described. It is written here
 * because a comment that points elsewhere for its one load-bearing lesson points
 * into a file this function's next rewrite does not touch.
 */
/**
 * The closing sentence, as an exported CONSTANT and not a template.
 *
 * Exported because the test that keeps a remedy out of this line checks that the
 * emitted string ENDS with exactly this and that everything before it is a
 * clause from a closed set. A constant tail plus an allowlisted head is a
 * structure a prescription cannot be appended to; the first version of that test
 * was a list of four banned English phrases, and a review wrote a complete
 * destructive instruction in the JSON call form this file uses everywhere —
 * `api_setup({ action: "update", … })` — which contains none of the four and
 * passed all 376 tests. A blocklist of spellings was never the property.
 *
 * ⚠ It makes no per-shape claim, and an earlier version did: it said the
 * decision "depends on whether the stored token is still live at the provider",
 * which is false for every refusal whose slot is EMPTY — six of the twenty-five
 * refused shapes, including the one this whole piece exists for — and false
 * again for a grant type no exchange can run, where liveness decides nothing.
 * One register below the removed imperatives, the same defect.
 */
export const DECLINED_DIAGNOSIS_TAIL = 'Renewing it unattended is refused. Do NOT resolve this by calling api_setup fetch_token — that is the exchange being refused, and running it by hand runs it. Which change is right depends on facts this engine does not have, so put it in front of the person who owns the connection.';

/**
 * One fact about a refused profile, as DATA rather than as a sentence.
 *
 * ⚠ This indirection is the fifth attempt at one property, and the first four
 * failed the same way, so the reason is written here rather than inferred.
 *
 * The property: this line may state facts and must not prescribe a profile
 * edit, because a model holding `api_setup update` reads it. V1 banned four
 * English phrases — defeated by writing the prescription in this repo's JSON
 * call form. V2 allowlisted CLAUSE PATTERNS over a list of eight fixture shapes
 * — defeated three ways, one of them a clause keyed on `base_url`, a field the
 * fixtures never varied. V3 added `base_url` to the fixture axes — defeated by a
 * clause keyed on `token_url` instead.
 *
 * That is not a sequence of oversights, it is a loop that cannot terminate:
 * **the author of the next clause picks the condition, and a guard over inputs
 * can only cover the conditions somebody already thought of.** A profile has
 * `name`, `description`, `vault_keys`, `custom_endpoint_ack`, `rate_limit` and
 * more; every one is an axis, and enumerating them is a race against the next
 * edit.
 *
 * So the set being closed is the FACTS, not the inputs. `declinedFacts` may
 * return only members of this union, `renderDeclinedFact` is an exhaustive
 * switch over it, and **a free string cannot be pushed at all**. A new clause is
 * now a new `kind` — a typed, visible addition that the test's exhaustiveness
 * check and its kind-sequence assertion both see, rather than a `facts.push`
 * that has to be unlucky enough to fire inside somebody's fixture list.
 */
export type DeclinedFact =
  | { readonly kind: 'consent'; readonly authorized: boolean }
  | { readonly kind: 'grant'; readonly named: string | undefined; readonly runnable: boolean }
  | { readonly kind: 'slot'; readonly slot: string; readonly derived: string; readonly diverges: boolean }
  | {
      readonly kind: 'occupancy';
      readonly slot: string;
      /** False when `slot` is the engine-derived name, which is never hostile. */
      readonly diverges: boolean;
      readonly state: 'empty' | 'engine-written' | 'foreign';
      readonly recorded: 'no-refresh' | 'connected' | 'other';
    };

/** The facts of a refused renewal, in the order they are read out. */
export function declinedFacts(
  profile: ApiProfile,
  slotState: 'empty' | 'engine-written' | 'foreign',
): readonly DeclinedFact[] {
  const named = profile.auth?.oauth?.grant_type;
  const derived = refreshTokenKey(profile.id);
  const rawSlot: unknown = profile.auth?.oauth?.refresh_token_key;
  const slot = typeof rawSlot === 'string' ? rawSlot : derived;
  const state = profile.oauth_grant?.state;
  return [
    { kind: 'consent', authorized: profile.oauth_grant?.origin === 'callback' },
    { kind: 'grant', named, runnable: named === undefined || named === 'refresh_token' || named === 'client_credentials' },
    { kind: 'slot', slot, derived, diverges: slot !== derived },
    {
      kind: 'occupancy',
      slot,
      diverges: slot !== derived,
      state: slotState,
      // Only claimed when the slot the ENGINE writes is the slot being read;
      // otherwise the record says nothing about what is in this one.
      recorded: slot === derived && (state === 'no-refresh' || state === 'connected') ? state : 'other',
    },
  ];
}

/**
 * One fact as the operator reads it.
 *
 * The DERIVED name is printed unshaped and the PROFILE's name is shaped, and the
 * asymmetry is the point: the derived name is built by this engine from an id
 * that `_admit` pins, so it is never hostile — and shaping it was a regression,
 * because `refreshTokenKey` appends 14 characters, so any id over 50 characters
 * produced a name over the 64-character vault-key bound and the engine reported
 * its OWN slot as unprintable. `refresh_token_key` comes from the profile and
 * stays shaped.
 */
export function renderDeclinedFact(fact: DeclinedFact): string {
  switch (fact.kind) {
    case 'consent':
      return fact.authorized
        ? 'a user authorized it at the provider'
        : 'no consent flow is recorded behind it';
    case 'grant':
      if (fact.named === undefined) {
        return 'it declares no auth.oauth.grant_type, so an exchange here would post a client-credentials grant';
      }
      return fact.runnable
        ? `it declares auth.oauth.grant_type "${shapedForLog(fact.named, GRANT_TYPE_SHAPE, 40)}"`
        : `it declares auth.oauth.grant_type "${shapedForLog(fact.named, GRANT_TYPE_SHAPE, 40)}", which is neither "refresh_token" nor "client_credentials", so no exchange here can run it`;
    case 'slot':
      return fact.diverges
        ? `its refresh token is read from "${shapedForLog(fact.slot, VAULT_NAME_SHAPE, 80)}" while an exchange here stores one under "${shapedForLog(fact.derived, DERIVED_NAME_SHAPE, 80)}"`
        : `its refresh token is read from "${shapedForLog(fact.derived, DERIVED_NAME_SHAPE, 80)}"`;
    case 'occupancy': {
      const shown = fact.diverges
        ? shapedForLog(fact.slot, VAULT_NAME_SHAPE, 80)
        : shapedForLog(fact.slot, DERIVED_NAME_SHAPE, 80);
      if (fact.state === 'engine-written') return `"${shown}" holds a token this engine stored for an earlier exchange`;
      if (fact.state === 'foreign') return `"${shown}" holds a token this engine has no record of storing`;
      if (fact.recorded === 'no-refresh') return `"${shown}" is empty, and the record says the authorization returned no refresh token — a provider issues one only when the authorization asked for a scope that grants it, offline_access for example`;
      if (fact.recorded === 'connected') return `"${shown}" is empty although the record says an exchange stored a refresh token there, so the vault lost it or cannot be read`;
      return `"${shown}" is empty`;
    }
  }
}

export function oauthRenewalDeclinedDiagnosis(
  profile: ApiProfile,
  slotState: 'empty' | 'engine-written' | 'foreign',
): string {
  return `${declinedFacts(profile, slotState).map(renderDeclinedFact).join('; ')}. ${DECLINED_DIAGNOSIS_TAIL}`;
}

/**
 * One renewal per profile at a time.
 *
 * Not a nicety: `api_setup` has no in-flight guard of its own — the comment at
 * its concurrency re-read says so, and what it guarantees is that an overlapping
 * exchange cannot record a FALSE revocation, not that overlap does not happen.
 * Before this, N concurrent `http_request` calls against one expiring profile
 * started N exchanges, each presenting the same refresh token. A provider that
 * rotates rejects all but one; on a provider with reuse detection, the whole
 * grant dies. The in-repo precedent is `integrations/google/google-auth.ts ›
 * refreshInFlight`, and this is that shape.
 *
 * Keyed by profile id, so it bounds by the number of profiles. The entry is
 * removed when the renewal settles, which makes the map a coalescer and not a
 * cache: a later request renews again.
 */
const oauthRenewalsInFlight = new Map<string, Promise<void>>();

/**
 * How long a profile is held back after a failed renewal. Fixed, not doubling: the
 * renewal runs only inside a five-minute buffer before expiry, so a growing period
 * would soon reach past the expiry itself, and from then on every request goes out
 * with a dead token until a renewal succeeds. One minute bounds the posts to about
 * one a minute per profile and set of inputs in this process (the minute starts
 * when the exchange returns), and keeps a recovered provider at most a minute away.
 */
export const OAUTH_RENEWAL_BACKOFF_MS = 60 * 1000;

/**
 * Profiles held back, keyed by profile id: after a failed renewal, or after a
 * successful one that left the profile still due ({@link holdAfterSuccess}). An
 * entry is removed when a renewal succeeds and leaves the profile no longer due;
 * one whose period has passed stays until then, and only counts failures for the
 * log line.
 */
const oauthRenewalBackoff = new Map<string, {
  inputs: string;
  /** `failed`: the renewal failed. `still-due`: it succeeded, but the profile still reads as due. */
  reason: 'failed' | 'still-due';
  failures: number;
  until: number;
}>();

/**
 * What a renewal for this profile is made of, as one fingerprint: the profile's
 * whole `auth.oauth` block and the refresh token the attach already read. Two
 * renewals with the same fingerprint post the same exchange.
 *
 * `auth.oauth` carries `token_expires_at`, which every successful exchange and the
 * OAuth callback rewrite, so a new consent or a manual `fetch_token` changes the
 * fingerprint without this module having to be told. Taken from values the attach
 * holds anyway: no extra vault read, so no extra `secretAccess` event.
 */
export function oauthRenewalInputs(profile: ApiProfile, storedRefresh: string | null): string {
  return tokenFingerprint(`${JSON.stringify(profile.auth?.oauth ?? null)}\u0000${storedRefresh ?? ''}`);
}

/** How many profiles are held back right now. For tests of the map's size. */
export function oauthRenewalBackoffSizeForTests(): number {
  return oauthRenewalBackoff.size;
}

/** Forget every hold. The map is module state, so tests must not share it. */
export function resetOAuthRenewalBackoffForTests(): void {
  oauthRenewalBackoff.clear();
}

/** The two stores the attach already holds, handed to the renewal so it reads the same ones. */
interface OAuthRenewalStores {
  readonly apiStore: NonNullable<ToolContext['apiStore']>;
  readonly secretStore: NonNullable<import('../../types/index.js').IAgent['secretStore']>;
}

/**
 * After a renewal that SUCCEEDED: should the profile be held anyway?
 *
 * Yes when the profile still reads as due, because then the next request would
 * renew again, and the one after it, with nothing in between. It reads as due when
 * the exchange's new expiry never reached the profile (its save was refused), or
 * when the provider issues tokens that live less than the refresh buffer.
 *
 * The hold ends at least the longest fetch ({@link HTTP_HARD_CAP_MS} plus
 * {@link HTTP_WALL_GRACE_MS}) before the NEW token expires, so a request attached
 * while it holds is fetched on a valid token. Not covered: a request that waits for
 * a person after the attach and before it is sent (any prompt on that path, such as
 * a write confirmation or the check on a GET that looks like exfiltration); that
 * wait has no limit, and a token shorter-lived than it can expire meanwhile. The lifetime comes
 * from the exchange ({@link exchangedTokenExpiryFor}), not from the profile, which
 * in the refused-save case still describes the old token. Without a known lifetime
 * there is no bound, so there is no hold.
 *
 * The inputs are taken AFTER the renewal: the exchange may have stored a rotated
 * refresh token, and the next attach fingerprints what is there then.
 */
function holdAfterSuccess(
  profileId: string,
  stores: OAuthRenewalStores,
  newExpiry: number | 'unknown' | undefined,
): { inputs: string; ms: number } | null {
  const profile = stores.apiStore.get(profileId);
  const due = profile?.auth?.oauth?.token_expires_at;
  if (profile === undefined || typeof due !== 'number' || Date.now() < due - OAUTH_REFRESH_BUFFER_MS) return null;
  if (typeof newExpiry !== 'number') return null;
  const ms = Math.min(OAUTH_RENEWAL_BACKOFF_MS, newExpiry - HTTP_HARD_CAP_MS - HTTP_WALL_GRACE_MS - Date.now());
  if (ms <= 0) return null;
  const slot = profile.auth?.oauth?.refresh_token_key ?? refreshTokenKey(profile.id);
  return { inputs: oauthRenewalInputs(profile, stores.secretStore.resolve(slot)), ms };
}

/**
 * Renew an oauth2 access token that is about to expire, by running the SAME
 * exchange the `api_setup` tool runs — deliberately by calling that handler
 * rather than by extracting its body into a shared function.
 *
 * The exchange carries a guarantee this path must not re-implement: when two
 * exchanges for one profile overlap, the provider rejects the one that lost as
 * spent, and `api_setup` re-reads the slot before recording anything — "if the
 * slot no longer holds what went out, the rejection says nothing about what it
 * holds now, so it is no revocation". An extracted copy would be identical
 * today and would hold that line in one of two places tomorrow. A call IS the
 * same code.
 *
 * The import is dynamic because `api-setup.ts` imports this module, so a static
 * one is a cycle. That moves a load failure from build time to the first
 * refresh — which is why a test drives this path for real rather than mocking
 * the module.
 *
 * Returns nothing and throws nothing: a failed renewal leaves the vault as it
 * was and the caller attaches whatever is there. That is deliberate. The buffer
 * means the stored token is still valid at this moment, so a provider hiccup
 * must not turn into a refusal — and the existing 401 path already says what to
 * do if it really is dead. This path records no verdict of its own; the handler
 * it calls is the only thing that writes state, and it writes no revocation it
 * has not proven.
 *
 * After a failed renewal the profile is held back: no further renewal POST goes
 * out for it until a waiting period passes, as long as the renewal's inputs are
 * the same ({@link oauthRenewalInputs}). The period is one minute
 * ({@link OAUTH_RENEWAL_BACKOFF_MS} says why it does not grow). A change of input
 * lifts it at once: a new consent or a manual `fetch_token` rewrites
 * `token_expires_at`, and an edit to the profile's `auth.oauth` or a newly stored
 * refresh token changes the rest. What it does not see is a change outside those
 * inputs — any other profile field, a client
 * secret replaced in the vault, a setting fixed at the provider, a provider that
 * recovers. Those wait out the minute; reading the client credentials on every
 * request to see them would cost two vault reads, and two audit events, per call.
 *
 * Before this, a renewal that kept failing was retried on every request inside
 * the buffer, at up to sixteen seconds each, and a token endpoint that hangs is
 * never charged to the session budget, so nothing else bounded it.
 *
 * A successful renewal can hold too, when the profile still reads as due
 * afterwards; {@link holdAfterSuccess} sizes that hold by the new token's lifetime.
 *
 * The hold is a cost bound, not a verdict. It lives in this process only and
 * records nothing; the request still goes out with the stored token, exactly as
 * after a failed renewal; and a manual `fetch_token` is never held, so whoever
 * acts on the failure is not blocked by it.
 */
async function renewExpiringOAuthToken(
  profileId: string,
  agent: import('../../types/index.js').IAgent,
  inputs: string,
  stores: OAuthRenewalStores,
): Promise<void> {
  if (!mayRenewOAuthUnattended(agent)) {
    // Silent on purpose, and this is the one refusal that should be: it is the
    // ordinary state of a scoped caller, not a fault. The request goes out with
    // the stored token and the existing 401 path says what to do — which is what
    // happened before this renewal existed at all.
    return;
  }

  const running = oauthRenewalsInFlight.get(profileId);
  if (running !== undefined) return running;

  const held = oauthRenewalBackoff.get(profileId);
  if (held !== undefined && held.inputs === inputs && Date.now() < held.until) {
    const why = held.reason === 'failed'
      ? `${String(held.failures)} consecutive renewal(s) with these inputs failed`
      : 'the last renewal succeeded, but the profile still reads as due for renewal';
    process.stderr.write(
      `[lynox:http] oauth token renewal skipped for profile "${profileId}": ${why}; `
      + `the next is not attempted before ${new Date(held.until).toISOString()}. The stored token is attached unchanged.\n`,
    );
    return;
  }

  const run = runOAuthRenewal(profileId, agent).then((result) => {
    if (result.ok) {
      const after = holdAfterSuccess(profileId, stores, result.expiry);
      if (after === null) oauthRenewalBackoff.delete(profileId);
      else oauthRenewalBackoff.set(profileId, { inputs: after.inputs, reason: 'still-due', failures: 0, until: Date.now() + after.ms });
      return;
    }
    // Counted per input, for the log: a failure after the inputs changed starts again at one.
    const failures = (held !== undefined && held.reason === 'failed' && held.inputs === inputs ? held.failures : 0) + 1;
    oauthRenewalBackoff.set(profileId, { inputs, reason: 'failed', failures, until: Date.now() + OAUTH_RENEWAL_BACKOFF_MS });
  }).finally(() => {
    oauthRenewalsInFlight.delete(profileId);
  });
  oauthRenewalsInFlight.set(profileId, run);
  return run;
}

/**
 * The renewal itself. Never rejects — see the contract on the caller above.
 * `ok` only when the exchange answered `Token exchange OK`; `expiry` is then the
 * new token's expiry as the exchange computed it.
 */
async function runOAuthRenewal(
  profileId: string,
  agent: import('../../types/index.js').IAgent,
): Promise<{ ok: boolean; expiry?: number | 'unknown' | undefined }> {
  // TWO catches, not one, and the split is the point. A first draft wrapped both
  // steps together — which would have swallowed a failing import as if it were a
  // provider hiccup, leaving a packaging defect invisible for as long as nobody
  // looked. That is the same silent fallback that let a shipping gap live in this
  // repo for four months; it does not get rebuilt here.
  let mod: typeof import('./api-setup.js');
  try {
    mod = await import('./api-setup.js');
  } catch (err) {
    // A module that will not load is a build or packaging defect, not a
    // transient. It cannot be retried into working and it must not be quiet.
    process.stderr.write(
      `[lynox:http] oauth token renewal unavailable: api_setup did not load (${err instanceof Error ? err.message : String(err)}). `
      + `Profile "${profileId}" keeps its stored token until it expires; renew with api_setup fetch_token.
`,
    );
    return { ok: false };
  }

  // The RETURN VALUE is read, because almost every failure IS one. Discarding it
  // made every refusal silent while a comment claimed the two catches above
  // meant a non-transient failure "must not be quiet".
  //
  // ⚠ Two things that comment got wrong, both found by review rather than by a
  // measurement of mine:
  //
  //   · It said the branch "throws nowhere". It does: `secretStore.set` is
  //     called unguarded for the access token, and again for a rotated refresh
  //     token, in the `fetch_token` success path. The count behind the wrong
  //     claim was of `throw` STATEMENTS, which is not the same question as what
  //     can throw — and a failing vault write after the provider has already
  //     rotated is the worst outcome this path has, because the presented
  //     refresh token is spent and the new one was not stored. So the catch
  //     logs rather than swallowing.
  //   · It filtered on `Error:`, and nine of this branch's returns do not start
  //     that way — including every `Token exchange failed with HTTP …`, which is
  //     the provider rejecting the refresh token and therefore the LIKELIEST
  //     renewal failure of all. The success shape is the narrow one, so that is
  //     what gets matched instead.
  // The renewal posts to the provider and may rotate the refresh token there: an outward
  // write that runs inside this call, past the dispatch that records a mandate's writes. So
  // it is recorded here, the same way (`audit-log.ts`): no row, no renewal — the request
  // continues on the stored token.
  const trail = beginRenewalTrail(agent, profileId);
  if (trail === 'refused') {
    writeRenewalFailure(profileId, 'refused', 'the renewal could not be recorded in the instance log', agent);
    return { ok: false };
  }
  let ended = false; // one outcome per attempt, though a later step of the try can still throw
  const endTrail = (phase: AuditPhase): void => {
    if (trail === null || ended) return;
    ended = true;
    try { agent.toolContext?.auditLog?.record({ ...trail, phase }); } catch { /* the attempt row stands alone */ }
  };
  try {
    const answer = await mod.apiSetupTool.handler({ action: 'fetch_token', id: profileId }, agent);
    endTrail('returned');
    if (typeof answer !== 'string' || !answer.startsWith('Token exchange OK')) {
      // stderr, not a refusal to the model: the stored token is still valid for
      // at least the buffer, so the request continues. This is what lets an
      // operator tell a renewal that was refused from one that never ran.
      writeRenewalFailure(profileId, 'refused', typeof answer === 'string' ? answer : String(answer), agent);
      return { ok: false };
    }
    return { ok: true, expiry: mod.exchangedTokenExpiryFor(profileId) };
  } catch (err) {
    // A throw here is a vault write that failed, or something under the exchange
    // that it does not convert. Either way it must not be silent: the request
    // continues on the stored token, but the grant may now be broken in a way
    // only a log will show.
    endTrail('failed');
    writeRenewalFailure(profileId, 'threw', err instanceof Error ? err.message : String(err), agent);
    return { ok: false };
  }
}

/** The `attempt` row of a mandate's renewal, `null` for anyone else, `'refused'` when it
 *  cannot be written. Same action as the tool call it stands in for. */
function beginRenewalTrail(
  agent: import('../../types/index.js').IAgent,
  profileId: string,
): import('../../core/audit-log.js').AuditEntry | null | 'refused' {
  const principal = agent.principal;
  if (isOwnerPrincipal(principal)) return null;
  const log = agent.toolContext?.auditLog ?? null;
  if (log === null) return 'refused';
  const entry = {
    principal,
    action: 'api_setup:fetch_token',
    target: `api_setup renewal ${profileId}`,
    phase: 'attempt' as const,
    correlationId: newCorrelationId(),
    runId: agent.currentRunId,
  };
  try {
    log.record(entry);
  } catch {
    return 'refused';
  }
  return entry;
}

/**
 * One sink for a failed renewal, so the two shapes cannot drift apart.
 *
 * The detail is MASKED and stripped of control characters, and neither is
 * decoration:
 *   · `exchangeToken` puts the RAW `token_url` into its failure message, and
 *     `vetTokenEndpoint` in that same file says why that matters — "the raw
 *     value can hold anything somebody pasted, including a credential". Nothing
 *     masks `process.stderr.write`, so masking has to happen at the call.
 *   · the same string can carry a provider's own text, and a newline in it would
 *     forge a log line.
 */
function writeRenewalFailure(
  profileId: string,
  kind: 'refused' | 'threw',
  detail: string,
  agent: import('../../types/index.js').IAgent,
): void {
  let masked = detail;
  try {
    masked = agent.secretStore?.maskAll?.(detail) ?? detail;
  } catch {
    // A masker that throws must not turn a log line into a failed request; the
    // unmasked string is then NOT written, because the whole point of this step
    // is that the raw value may hold a credential.
    masked = '<detail withheld: masking failed>';
  }
  const oneLine = masked.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
  process.stderr.write(
    `[lynox:http] oauth token renewal ${kind} for profile "${profileId}": ${oneLine}\n`,
  );
}

/**
 * Keep the connection this call's host resolves to on the call's ledger row
 * (`core/call-connection.ts` says what the stamp does and does not mean). The same
 * synchronous lookup the attach below makes, done first and on its own so it holds
 * whether or not a credential is attached: a profile without engine-managed auth,
 * or an agent without a vault, still talks to that connection. Written before the
 * attach's own refusals and the handler's later ones, so those calls carry it too;
 * the handler's earlier refusals (rate limits, a CRLF header) come first and do not.
 * Nothing from the tool input but the URL's host reaches it,
 * and the host only selects among profiles the user saved. Outside a tool call (a
 * bulk run's worker effect) the note is a no-op.
 */
function stampResolvedConnection(url: string, apiStore: NonNullable<ToolContext['apiStore']>): void {
  let profile: ReturnType<NonNullable<ToolContext['apiStore']>['getByHostname']>;
  try {
    profile = apiStore.getByHostname(new URL(url).hostname);
  } catch {
    return;
  }
  if (!profile) return;
  // Observability must never break the request it observes: a store that cannot
  // answer `created_at` still yields the id, with the timestamp unknown.
  let createdAt: string | null = null;
  try {
    createdAt = apiStore.connectionCreatedAt(profile.id) ?? null;
  } catch {
    createdAt = null;
  }
  noteCallConnection({ id: profile.id, createdAt });
}

async function attachEngineManagedAuth(
  url: string,
  headers: Record<string, string>,
  toolContext: ToolContext | undefined,
  agent: import('../../types/index.js').IAgent,
): Promise<AttachedAuth> {
  const vault = agent.secretStore;
  const apiStore = toolContext?.apiStore;
  if (apiStore) stampResolvedConnection(url, apiStore);
  if (!apiStore || !vault) return {};

  let profile: ReturnType<NonNullable<ToolContext['apiStore']>['getByHostname']>;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
    profile = apiStore.getByHostname(hostname);
  } catch {
    return {}; // invalid URL — assertHostPolicy reports it downstream
  }
  if (!profile) {
    // Two profiles on one host — only the boot can leave that behind, since a
    // save of the second is refused. The engine used to attach whichever had
    // loaded last, silently. Now it attaches nothing and says why, but only when
    // a credential is at stake: two public (`none`) profiles on one host have
    // nothing to mix up, and blocking their requests would help no one.
    const conflict = apiStore.getHostConflict(hostname);
    const credentialed = conflict?.some((id) => {
      const type = apiStore.get(id)?.auth?.type;
      return type !== undefined && type !== 'none';
    });
    if (conflict && credentialed) {
      // The model cannot know which of the two is still wanted, so the text sends
      // it to the user rather than to a delete.
      return { refusal: `Error: more than one api_profile maps to ${hostname} (${conflict.join(', ')}), so the engine cannot tell which stored credential this request should carry, and it sends none. Ask the user which profile to keep; the other one then has to be deleted or given a different base_url.` };
    }
    return {};
  }
  const auth = profile.auth;
  if (!auth) return {};
  // Every read below, the renewal's included, goes through the profile's view: a profile a
  // mandate wrote does not get the environment's values or a preset account's credentials.
  const secretStore = secretsForProfile(vault, profile, apiStore);

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
    // A revoked grant is said so here, before a request goes out, rather than
    // after it comes back 401 — where the hint below would call it an expired
    // token and send the model to fetch_token, which cannot help. Only while the
    // vault still holds the token that was rejected (or none): a different one
    // is the way back, and it is also how a verdict another process reached on
    // a stale view of the vault steps aside once this one holds the newer token.
    // And only for a refresh-token profile — the only kind a revocation is ever
    // recorded for; one moved to client credentials since has no refresh token
    // to hand back, and the text would send the user after one.
    if (hasRevokedGrant(profile)) {
      const refreshKey = profile.auth?.oauth?.refresh_token_key ?? refreshTokenKey(profile.id);
      const current = secretStore.resolve(refreshKey);
      if (current === null || tokenFingerprint(current) === profile.oauth_grant?.revoked_fp) {
        // Both values are profile-controlled and this refusal is the model's to read,
        // outside the untrusted-data wrap: `revokedGrantMessage` shapes them, for this
        // caller and for `fetch_token` alike.
        return { refusal: revokedGrantMessage(
          profile.id,
          refreshKey,
          refreshTokenKey(profile.id),
          profile.oauth_grant?.revoked_at,
          OAUTH_PRESETS.get(profile.auth?.oauth?.preset_id ?? '') !== undefined,
        ) };
      }
    }
    // Profile drives — the agent should NOT have to remember which vault key holds
    // the current access_token. Prevents two failure modes: a stale key re-referenced
    // after api_setup recreated the profile (staging 2026-05-18: fetch_token had
    // written SHOPIFY_SEO_ACCESS_TOKEN, the agent kept reaching for
    // SHOPIFY_ACCESS_TOKEN → 401 forever), and rotation, where every later request
    // should pick up a freshly minted token automatically.
    // Renew before attaching, not after a 401 comes back. Two reasons it has to
    // be here rather than in a worker: a worker would have to know every profile
    // and guess a frequency, and it would keep alive connections nobody uses —
    // for a 24-hour token that is a daily exchange, and a daily secret write, for
    // a shop untouched for months. This runs only for a token about to be used.
    //
    // Ordered after the revoked-grant check, and that order is LOAD-BEARING:
    // it is least-secret-exposure. A path that is going to refuse must not read
    // the client secret.
    //
    // ⚠ The first draft of this comment claimed the opposite — that the order was
    // "a cost and clarity choice, not a correctness property" — on the strength of
    // a mutation that survived. The mutation survived because the test vault's
    // `resolve` is silent and publishes nothing, so the quantity the swap changes
    // was not one the instrument could report. Measured properly, by recording
    // what `resolveSecretRefs` is asked for: in this order a refused request
    // reads neither the client id nor the client secret; with the two swapped it
    // reads both.
    //
    // ⚠ NOT "resolves nothing", which an earlier wording claimed and this file's
    // own test contradicts — the revoked-grant check above reads the refresh key
    // itself, deliberately, to decide whether the recorded revocation still
    // applies. The property is about the CLIENT SECRET, and it is narrower than
    // the first wording: inside `fetch_token` several other refusals do come
    // after those reads, so this order buys the revoked case and not a general
    // rule.
    //
    // `fetch_token` does short-circuit on a revoked grant before it POSTs and
    // before any secret WRITE (`api-setup.ts`, "posting the very token the
    // provider already rejected only repeats the rejection"). What it does not sit
    // before is the READS: client_id and client_secret are resolved first, then
    // the refresh token, and only then does it return. Each resolve publishes a
    // `secretAccess` audit event in the real store, so the swap buys three vault
    // reads of a credential on a request that was never going to be sent.
    const expiresAt = profile.auth?.oauth?.token_expires_at;
    if (typeof expiresAt === 'number' && Date.now() >= expiresAt - OAUTH_REFRESH_BUFFER_MS) {
      // Asked HERE rather than inside the renewal because only this scope can
      // answer the second argument: whether the vault actually holds a refresh
      // token for this profile. The profile can NAME a slot that is empty.
      const refreshSlot = profile.auth?.oauth?.refresh_token_key ?? refreshTokenKey(profile.id);
      // ONE vault read, two questions. The gate needs only "is something there",
      // the diagnosis needs "and whose is it" — reading the slot twice would be
      // two `secretAccess` audit events for one answer.
      //
      // ⚠ The gate is handed `stored !== null`, NOT `slotState !== 'empty'`, and
      // the difference is one value: `oauthRefreshSlotState` reads an EMPTY
      // STRING as empty, while the expression this replaced counted it as a
      // stored token. Routing the gate through the three-valued state would have
      // flipped a hand-built profile with `''` in its slot from refused to
      // PERMITTED — a permissive change, in a security gate, as a side effect of
      // a logging refactor. `SecretStore.set` has no empty-value guard, so the
      // value is reachable. Whether `''` should mean "no token" is a real
      // question and not this change's to answer.
      const stored = secretStore.resolve(refreshSlot);
      const slotState = oauthRefreshSlotState(profile, refreshSlot, stored);
      if (oauthProfileMayBeRenewedUnattended(profile, stored !== null)) {
        await renewExpiringOAuthToken(profile.id, agent, oauthRenewalInputs(profile, stored), { apiStore, secretStore });
      } else {
        process.stderr.write(
          `[lynox:http] oauth token renewal declined for profile "${profile.id}": ${oauthRenewalDeclinedDiagnosis(profile, slotState)}\n`,
        );
      }
    }

    const tokenKey = accessTokenKey(profile.id);
    const resolved = secretStore.resolve(tokenKey);
    if (!resolved) {
      return { refusal: `Error: api_profile "${profile.id}" is oauth2 but the vault has no access_token under "${tokenKey}". Mint one first with: api_setup({ action: "fetch_token", id: "${profile.id}" }). Requires client_id + client_secret already stored under the keys configured in auth.oauth.` };
    }
    // Some APIs take the access token in a header of their own and answer
    // `Authorization: Bearer` with 401, so the grant succeeds and every request
    // after it fails. `header_name` names that header, and the token goes in raw,
    // as for a `header` profile. Unset, or set to Authorization itself, it stays
    // `Bearer`, which is what every profile saved before this sent.
    // Same name check as the `header` branch below: the name comes from the profile.
    // `typeof` first: a file-loaded profile is unvalidated, `.test(123)` passes on "123",
    // and `.toLowerCase()` below would then throw instead of refusing.
    if (auth.header_name !== undefined && (typeof auth.header_name !== 'string' || !HTTP_HEADER_NAME.test(auth.header_name))) {
      return { refusal: `Error: api_profile "${profile.id}" has an auth.header_name that is not a valid header name, so the access token was not attached. Fix it with api_setup action="update" (for example "X-Api-Key").` };
    }
    const ownHeader = auth.header_name !== undefined && auth.header_name.toLowerCase() !== 'authorization'
      ? auth.header_name
      : undefined;
    const oauthSlot = ownHeader ?? 'Authorization';
    const oauthValue = ownHeader !== undefined ? resolved : `Bearer ${resolved}`;
    // The vault value came back from a token endpoint; it enters a header here.
    if (/[\r\n\0]/.test(oauthValue)) {
      return { refusal: `Error: api_profile "${profile.id}" holds an access token containing CRLF/null — refusing to send it. Mint a new one with api_setup({ action: "fetch_token", id: "${profile.id}" }).` };
    }
    return put(oauthSlot, oauthValue);
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
      return { refusal: protectedKeyRefusal(profile.id, protectedKeys.map((k) => shapedForLog(k, VAULT_NAME_SHAPE, 80)).join(' + ')) };
    }
    const user = secretStore.resolve(userKey);
    const pass = secretStore.resolve(passKey);
    // Truthiness, not a null check: an EMPTY vault value would ship
    // `Basic base64("ck:")` — a half-credential that reads as an auth failure
    // rather than as a missing secret.
    if (!user || !pass) {
      const missing = [user ? null : userKey, pass ? null : passKey]
        .filter((k): k is string => typeof k === 'string')
        .map((k) => shapedForLog(k, VAULT_NAME_SHAPE, 80))
        .join(' + ');
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
      return { hint: () => `api_profile "${profile.id}" is auth.type="${auth.type}" but names no vault key, so the engine could not attach the credential. Set auth.vault_keys: ["YOUR_KEY_NAME"] via api_setup({ action: "update", ... }) and store the value with ask_secret.` };
    }
    // The same bound the oauth2 branch has, but the oauth2 branch gets it elsewhere:
    // its key is derived from the profile id, and the ApiStore admission gate refuses an
    // oauth2 profile whose derived slot is protected (`protectedDerivedSlot`), so
    // no such profile reaches this function. Deriving alone bounds nothing — the id
    // is the agent's too. This name comes from the PROFILE, which a prompt-injected agent can author:
    // without it, `vault_keys: ['ANTHROPIC_API_KEY']` hands the tenant's own provider
    // key to whatever host the profile names. `isProtectedSecretWrite`, not
    // `isInfraSecret` — the provider slots live in a separate set that
    // `isInfraSecret` does not cover, and they are exactly what such a profile wants.
    if (isProtectedSecretWrite(tokenKey)) {
      return { refusal: protectedKeyRefusal(profile.id, shapedForLog(tokenKey, VAULT_NAME_SHAPE, 80)) };
    }
    if (!hostVetted) {
      return { hint: () => `api_profile "${profile.id}" maps to ${hostname}, which is not a vetted sub-processor and carries no recorded acceptance, so the engine did not attach the stored credential. Re-save the profile via api_setup({ action: "update", ... }) and accept controller-responsibility when prompted.` };
    }
    if (!url.toLowerCase().startsWith('https://')) {
      return { hint: () => `api_profile "${profile.id}" uses a stored credential and the engine will not attach it over a non-HTTPS URL. Use https://.` };
    }
    const token = secretStore.resolve(tokenKey);
    // Truthiness, not a null check — an empty value would ship a bare `Bearer `,
    // which reads on the wire as a bad token rather than as a missing one.
    if (!token) {
      // `tokenKey` is `auth.vault_keys[0]` or a named slot — profile-controlled,
      // and this hint is appended outside the untrusted-data wrap. The comment
      // further down once claimed the filter went on "everything this file
      // prints, old hints included"; it did not go on this one.
      return { hint: () => `api_profile "${profile.id}" is auth.type="${auth.type}" but the vault has no usable value for ${shapedForLog(tokenKey, VAULT_NAME_SHAPE, 80)}. Ask the user for the credential with ask_secret, then retry.` };
    }
    // `header` names its own slot and carries the raw token; `bearer` is the
    // Authorization/`Bearer ` special case. The default matches what the profile
    // description shows the model (api-store.ts) and what bootstrap writes
    // (api-setup.ts) — defaulting to Authorization here would put the token in a
    // header the model was told is called something else, i.e. a silent 401.
    // A stored header_name that is not a header name (an empty string among them, which `??`
    // does not catch) is refused here rather than sent: the request would otherwise fail in
    // the HTTP layer with a message that does not name the profile.
    if (auth.type !== 'bearer' && auth.header_name !== undefined && (typeof auth.header_name !== 'string' || !HTTP_HEADER_NAME.test(auth.header_name))) {
      return { refusal: `Error: api_profile "${profile.id}" has an auth.header_name that is not a valid header name, so the credential was not attached. Fix it with api_setup action="update" (for example "X-Api-Key").` };
    }
    const slot = auth.type === 'bearer' ? 'Authorization' : (auth.header_name ?? 'X-Api-Key');
    const value = auth.type === 'bearer' ? `Bearer ${token}` : token;
    // The handler's CRLF check covers `input.headers` — the agent's own map. These
    // two come from the PROFILE and the VAULT and would otherwise enter having
    // passed nothing; `X-Key\r\nX-Evil: …` would smuggle a second header on a path
    // that exists precisely to bypass the agent.
    if (/[\r\n\0]/.test(slot) || /[\r\n\0]/.test(value)) {
      return { refusal: `Error: api_profile "${profile.id}" produced an auth header containing CRLF/null — refusing to send it. Check auth.header_name and the stored value of ${shapedForLog(tokenKey, VAULT_NAME_SHAPE, 80)}.` };
    }
    return put(slot, value);
  }

  // Everything that reaches here is a shape the engine does NOT attach. It still
  // gets a name — see modelOwnedAuthHint. `slotFilled` is read from the request as
  // it stood at attach time (nothing writes `headers` after this point: every `put`
  // returns immediately); the vault is not read until the 401 actually arrives.
  const filled = modelFilledSlot(auth, headers, url);
  return {
    hint: ctx => modelOwnedAuthHint({
      profileId: profile.id,
      auth,
      hostname,
      hostVetted,
      slotFilled: filled,
      crossOriginRedirect: ctx.crossOriginRedirect,
      secretStore,
    }),
  };
}

/**
 * Header, query-param and vault-key names come from the PROFILE, and a
 * prompt-injected agent can author one. `validateProfile` now shape-checks all of
 * them at create/update, but a profile loaded from a file is not validated, so these
 * names still reach this hint unchecked unless this file shapes them. The hint is
 * appended OUTSIDE the `untrusted_data` wrap on purpose — system guidance, which the
 * model is meant to trust — so a name carrying newlines could forge a reminder of its
 * own; `safeToken` below is what stops that here.
 *
 * ⚠ The sentence here used to end "so the filter goes on everything this file
 * prints, old hints included". **That was false when it was written and a review
 * proved it by enumeration**: `modelOwnedAuthHint` is consistently filtered, and
 * four refusals outside it printed a vault-key name raw — one of them fourteen
 * lines from a later fix that was looking for exactly this. A comment that
 * claims total coverage is worse than none, because it is the thing somebody
 * greps for instead of enumerating.
 *
 * So, as a map rather than a claim. This file has TWO filters, and the split is
 * by what is known about the value:
 *   · `safeToken` / `SAFE_PROFILE_TOKEN` — a general NAME filter, loose charset
 *     (`[A-Za-z0-9._-]`), length 64. For values whose shape is not pinned.
 *   · `shapedForLog(value, shape, max)` — for a value whose shape IS pinned, and
 *     the bound follows the value: `VAULT_NAME_SHAPE` mirrors
 *     `VAULT_KEY_PATTERN` for a model-authored key, `DERIVED_NAME_SHAPE` is
 *     wider because `refreshTokenKey` builds a 78-character name and admits a
 *     digit-leading id, `ISO_TIMESTAMP_SHAPE` for `revoked_at`.
 * Neither is applied by default. Any NEW interpolation of a profile value into a
 * model-facing string needs one of them chosen deliberately: `validateProfile` checks
 * the names on create, update and refine, but a profile loaded from a file never passes it.
 */
const SAFE_PROFILE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
function safeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE_PROFILE_TOKEN.test(value) ? value : '<name rejected: fix it via api_setup>';
}

/**
 * Did the MODEL already put the profile's credential where this auth shape wants it?
 *
 * Read off the outgoing request, never predicted: `headers` here is the agent's own
 * map, and for `query` the parameter is in the URL the agent composed. The caller
 * needs "nothing authenticated this request" apart from "a value went out and came
 * back rejected" — two different next steps that a 401 alone separates for nobody.
 *
 * Emptiness counts as absent on BOTH sides. `searchParams.has()` is true for a bare
 * `?api_key=`, which would have reported a half-credential as a sent one — the same
 * distinction the engine-owned branches make explicitly when they refuse an empty
 * vault value rather than shipping `Basic base64("ck:")`.
 */
function modelFilledSlot(
  auth: { type: string; header_name?: string | undefined; query_param?: string | undefined },
  headers: Record<string, string>,
  url: string,
): boolean {
  if (auth.type === 'query') {
    try {
      return (new URL(url).searchParams.get(auth.query_param ?? 'key') ?? '').trim() !== '';
    } catch {
      return false;
    }
  }
  return Object.entries(headers).some(([k, v]) => k.toLowerCase() === modelOwnedSlot(auth).toLowerCase() && v.trim() !== '');
}

/**
 * Which header this shape expects the model to fill.
 *
 * `basic` is `Authorization` by protocol — NOT `auth.header_name`. That field is
 * meant for `auth.type: 'header'`; `validateProfile` checks its shape but does not bind
 * it to a type, and reading it here produced `headers: { "X-Foo": "Basic secret:K" }`
 * for a profile that had set it: an instruction that cannot work, in the engine's
 * own trusted voice, at the moment the model is looking for one to follow.
 */
function modelOwnedSlot(auth: { type: string; header_name?: string | undefined }): string {
  if (auth.type === 'basic') return 'Authorization';
  return safeToken(auth.header_name) ?? 'Authorization';
}

/**
 * The 401-hint for the auth shapes the engine does NOT attach.
 *
 * `basic`+`pre_encoded_b64`, `basic` with no `basic_format`, and `query` are the
 * MODEL's to set, on purpose and test-pinned ("leaves pre_encoded_b64 alone — that
 * path is still the model's to set", "does NOT attach for a bare basic profile with
 * no basic_format", "SECURITY: a pre_encoded_b64 basic profile keeps the model-set
 * header"). Attaching them here would break integrations that work today and kill
 * that security test; refusing would stop them outright, which the docstring above
 * rules out for the same reason.
 *
 * What was missing is neither. It is a NAME for the failure. Every ENGINE-owned
 * shape that declines to attach says why, and the reason rides along on the 401.
 * The model-owned shapes returned an empty object, so a 401 there looked identical
 * whether the credential was rejected or never sent — and nothing in the response
 * separates those.
 *
 * Measured on a real thread (2026-09-02, engine 2.14.2, build 7e905219): a
 * `pre_encoded_b64` DataForSEO profile 401'd on a request carrying no Authorization
 * header. The agent read that as "the secret is missing or invalid", contradicting
 * its own answer one turn earlier, and asked the user to re-supply a credential the
 * vault already held. That is the loop the 401-hint was built to end — "three token
 * rotations against a request that carried no credential" — running in the half it
 * did not cover.
 *
 * ⚠ A WRONG name is worse than none: it carries the engine's authority into the
 * moment the model is deciding what to do. Every claim below is therefore either
 * read off this request or not made at all.
 */
function modelOwnedAuthHint(a: {
  profileId: string;
  auth: {
    type: string;
    basic_format?: string | undefined;
    header_name?: string | undefined;
    query_param?: string | undefined;
    username_key?: string | undefined;
    password_key?: string | undefined;
    vault_keys?: string[] | undefined;
  };
  hostname: string;
  hostVetted: boolean;
  slotFilled: boolean;
  crossOriginRedirect: boolean;
  secretStore: { resolve(key: string): string | null | undefined };
}): string {
  const { auth } = a;
  const slot = modelOwnedSlot(auth);

  // The acceptance the ENGINE-owned shapes check before attaching. It does not gate
  // this path — the model's own header was never blocked here, and that is what the
  // security test pins — but telling it to send a stored credential to a host with no
  // recorded acceptance, without saying so, is advice the engine would not take itself.
  const vetting = a.hostVetted
    ? ''
    : ` Note: ${a.hostname} is not a vetted sub-processor and carries no recorded acceptance — for the shapes the ENGINE attaches, that alone stops the attach. Re-save the profile via api_setup({ action: "update", id: "${a.profileId}" }) and accept controller-responsibility before sending a stored credential there.`;

  // `none` is not a model-owned shape — it is a profile claiming this API needs no
  // credential while the host says otherwise.
  if (auth.type === 'none') {
    return a.slotFilled
      ? `api_profile "${a.profileId}" declares auth.type="none" (no credentials required), yet this host answered 401 AND this request carried a ${slot} header you set. Both can be true: the profile may be wrong about this endpoint, or that credential may have been rejected. The engine cannot separate them — a "none" profile names no vault key to check. Correct the profile with api_setup({ action: "update", id: "${a.profileId}" }).${vetting}`
      : `api_profile "${a.profileId}" declares auth.type="none" (no credentials required), but this host answered 401 — the profile is wrong about this endpoint, not the credential. Correct it with api_setup({ action: "update", id: "${a.profileId}" }), then store the credential with ask_secret.${vetting}`;
  }

  // Key precedence mirrors the engine's own (`auth.username_key ?? auth.vault_keys[0]`).
  // Reading `vault_keys` alone told a profile that names username_key/password_key
  // that it "names no vault key", and sent the model to ask_secret for a credential
  // the vault already held — the very loop this hint exists to end.
  const userKey = auth.username_key ?? auth.vault_keys?.[0];
  const passKey = auth.password_key ?? auth.vault_keys?.[1];

  // A basic profile naming TWO keys is a SPLIT credential with the format field
  // missing, not a pre-encoded one. Naming `Basic secret:<username>` there is a
  // string that can never authenticate; the fix is the format field, and the engine
  // takes the header over once it is set.
  if (auth.type === 'basic' && auth.basic_format === undefined && userKey !== undefined && passKey !== undefined) {
    return `The engine did not attach a credential: api_profile "${a.profileId}" is auth.type="basic" with no basic_format recorded, and it names TWO vault keys (${safeToken(userKey) ?? '?'} + ${safeToken(passKey) ?? '?'}) — a split username/password credential whose format field is missing. Do NOT hand-build a header from one of them; Basic is base64(user:pass) and half of it never authenticates. Set auth.basic_format="user_pass_split" via api_setup({ action: "update", id: "${a.profileId}" }) and the ENGINE attaches it from both keys on every request.${vetting}`;
  }

  const key = auth.type === 'basic' ? userKey : auth.vault_keys?.[0];
  const label = safeToken(key);

  // The key NAME comes from the profile, so it can name a slot that belongs to the
  // platform or holds the tenant's own provider key. The engine-owned branches refuse
  // such a profile before resolving. Refusing HERE would block a request that works
  // today, so this declines to look it up instead: the value never entered the string
  // either way, but "the vault DOES hold a value under ANTHROPIC_API_KEY" is an
  // existence oracle over exactly the slots that refusal exists to fence off — and it
  // reaches `isInfraSecret` names too, which `listAgentVisibleNames` keeps out of the
  // agent's view on purpose.
  const vault = key === undefined
    ? `This profile names no vault key, so there is nothing to reference yet — add one via api_setup({ action: "update", id: "${a.profileId}" }) and store the value with ask_secret.`
    : isProtectedSecretWrite(key)
      ? `This profile names the protected secret "${label}" as its credential. Those belong to the platform or hold the tenant's own provider key, are never attached to an outbound request, and the engine will not look one up to tell you whether it is set. Use a credential the user supplied for this API.`
      : a.secretStore.resolve(key)
        ? `The vault DOES hold a value under "${label}" — do NOT ask the user to supply or re-paste it, reference it as \`secret:${label}\`.`
        : `The vault has NO value under "${label}" — collect it with ask_secret({ name: "${label}" }), then retry.`;

  // "deliberately" is a claim about intent and is only true for the three shapes the
  // engine excludes on purpose. An unknown type or a misspelled basic_format reaches
  // here through `loadFromDirectory`, which validates none of it — that is a broken
  // profile, and calling it deliberate would send the reader past the actual fault.
  const known = auth.type === 'query'
    || (auth.type === 'basic' && (auth.basic_format === undefined || auth.basic_format === 'pre_encoded_b64'));
  const shape = auth.type === 'basic'
    ? `auth.type="basic"${auth.basic_format === undefined ? ' with no basic_format recorded' : ` / basic_format="${safeToken(auth.basic_format) ?? '?'}"`}`
    : `auth.type="${safeToken(auth.type) ?? '?'}"`;
  const why = known
    ? 'which is the MODEL\'s to set — deliberately, so a working hand-set credential is never overwritten'
    : 'which the engine does not recognise, so it attached nothing. Check the profile: an unknown auth.type or a misspelled basic_format is a misconfiguration, not a design';

  if (auth.type === 'query') {
    const param = safeToken(auth.query_param) ?? 'key';
    const carried = a.slotFilled
      ? `This request already carried a non-empty "${param}" in the query string, so the 401 points at the value rather than at a missing parameter.`
      : `This request carried no usable "${param}" query parameter — nothing authenticated it.${key === undefined ? '' : ` Put it in the URL yourself: ?${param}=secret:${label ?? ''}.`}`;
    return `The engine did not attach this profile's credential: api_profile "${a.profileId}" is ${shape}, ${why}. ${carried} ${vault}${vetting}`;
  }

  // A cross-origin redirect strips Authorization/Cookie, so on that path the header
  // the model set did not reach the host that answered — asserting "you set it, so
  // the value was rejected" would send it to rotate a working credential.
  const carried = a.crossOriginRedirect
    ? `This request was redirected to a different origin, and ${slot} is stripped on such a hop — so a header you set did NOT reach the host that answered 401. Request the final URL directly before touching the credential.`
    : a.slotFilled
      ? `You set the ${slot} header on this request yourself; the engine neither added nor replaced it. Nothing here says the value is wrong — only that the engine is not the one supplying it.`
      : `This request carried no usable ${slot} header — nothing authenticated it.${key === undefined ? '' : ` Set it yourself: headers: { "${slot}": "${auth.type === 'basic' ? 'Basic ' : ''}secret:${label ?? ''}" }.`}`;
  return `The engine did not attach this profile's credential: api_profile "${a.profileId}" is ${shape}, ${why}. ${carried} ${vault}${vetting}`;
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
  // The classification itself lives at `undoClassFor`, which the two gates in the handler
  // read as well — see its docblock for why PUT/PATCH are restorable and POST/DELETE are
  // not. Declaring it here a second time is what let the two drift.
  undo: (input) => undoClassFor(input.method ?? 'GET'),
  // The effective method, overrides included; one that is not a method counts as a write.
  outwardWrite: (input) => {
    const method = effectiveWriteMethod(input.method ?? 'GET', input.headers ?? {}, input.url) ?? 'OVERRIDE';
    return method === 'GET' || method === 'HEAD' ? null : method;
  },
  definition: {
    name: 'http_request',
    // The cap is stated HERE because the model cannot plan around a limit it only
    // discovers by hitting it. Before this line it learned about the ceiling at
    // request 101 — mid-bulk, with no way to have batched differently.
    //   The escape used to be named in the same breath — save a workflow and fire
    // it per batch — and that sentence was REMOVED, not replaced: a workflow the
    // model saves is no longer allowed to run unattended on its own say-so, so the
    // route it described now stops at a consent step this text cannot grant. A
    // wrong instruction is worse than none; naming a new one is a decision about
    // who may give that consent, and that decision is not this file's to make.
    description: `Make an HTTP request to a specific API endpoint. Use for authenticated APIs, custom endpoints, or structured data fetching. For general web search or reading public pages, use web_research instead. Capped at ${MAX_REQUESTS_PER_SESSION} per conversation, shared with sub-agents (so splitting into sub-agents buys nothing).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        // This string is in the STATIC PREFIX: it ships on every turn of every session
        // that holds this tool — a role's `allowTools` or the user's `disabled_tools` can
        // leave it out — so a sentence here costs fleet-wide tokens. The caveat that
        // belongs with it and NOT in the prefix: many servers ignore or reject a body on
        // DELETE, so a DELETE body is sent and scanned but may not be read.
        body: { type: 'string', description: 'Request body (not for GET/HEAD)' },
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
        // A shared host HAS profiles — two of them — and a create there is refused,
        // so "create one" would be advice the model cannot follow.
        if (!toolContext.apiStore.getByHostname(reqHostname) && !toolContext.apiStore.getHostConflict(reqHostname)
            && !SKIP_PROFILE_CHECK.has(reqHostname)) {
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

    // The method this call is gated as: the strongest of the method and any override form the
    // request carries (`outbound-write.ts`). It is what is sent that stays `method`; every gate
    // below that asks "is this a write, and which one" reads `gatedMethod`.
    const effective = effectiveWriteMethod(method, headers, input.url);
    if (effective === null) {
      // The value is not repeated: it is whatever the request put there.
      blockedVerbatim('Blocked: the method, or a method override (an X-HTTP-Method-Override-style header or a `_method` query parameter), is not an HTTP method. Send the request with a method name, or without the override.');
    }
    const gatedMethod = effective;
    // The approval and the outbound-effect table are keyed by the URL's host. A header a
    // server or proxy routes on instead (`Host`, `X-Forwarded-Host`, `X-Original-URL`, …)
    // would send the write somewhere the question did not name.
    const retarget = isWriteMethod(gatedMethod) ? retargetingHeader(headers) : undefined;
    if (retarget !== undefined) {
      blockedVerbatim(`Blocked: ${gatedMethod} to ${new URL(input.url).hostname} sets a header that re-targets the request (${retarget.trim().toLowerCase()}), which a write may not do. Send it without one.`);
    }

    // A mandate's turn does not write to an account connected through a provider preset
    // (PRD customer-granted-operator-access §3.13). The consent prompt is no bar here: a
    // mandate answers its own session's prompts (each write there is asked on its own, see the
    // consent gate below). The write goes to the owner as a proposal instead. Checked before
    // the credential is attached (so a refused write renews no token) and before the
    // contract (so no grant opens it). Every profile on the host counts, a host two profiles
    // share included, and the host is read without trailing root dots, which name the same
    // host to DNS and a different key to the profile map.
    if (isWriteMethod(gatedMethod) && !isOwnerPrincipal(agent.principal)) {
      const apiStore = toolContext?.apiStore;
      const host = new URL(input.url).hostname.replace(/\.+$/, '');
      const onHost = !apiStore ? [] : (apiStore.getHostConflict(host) ?? [apiStore.getByHostname(host)?.id])
        .map((id) => (id === undefined ? undefined : apiStore.get(id)));
      if (onHost.some((p) => p?.auth?.oauth?.preset_id !== undefined)) {
        blockedVerbatim(
          `Blocked: ${gatedMethod} to ${host} writes to an account the owner connected, which this session may not do. ` +
          'Propose the change as a task instead (task_create); it runs once the owner approves it.',
        );
      }
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
    // Which of the refusal's three cases this host is in — decided here, from what
    // the attach did and whether a profile exists, so no profile text is needed.
    const profileState = (): EgressProfileState => {
      if (attachedAuthSlot !== undefined) return 'attached';
      let profile;
      try {
        profile = toolContext?.apiStore?.getByHostname(new URL(input.url).hostname);
      } catch { return 'none'; }
      if (!profile) return 'none';
      const a = profile.auth;
      // Auth types the engine attaches: when one reaches here unattached (no
      // recorded acceptance, no vault value — or no secret store on this agent,
      // which ends the attach before any branch), the profile needs checking.
      const engineAttached = a?.type === 'bearer' || a?.type === 'header' || a?.type === 'oauth2'
        || (a?.type === 'basic' && a.basic_format === 'user_pass_split');
      return engineAttached ? 'not-attached' : 'model-owned';
    };

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
        blockedVerbatim(egressSecretRefusal(`request header '${headerName}'`, headerMatch, profileState()));
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
      const urlSecretMatch = urlScanForms(input.url).map(detectSecretInContent).find((m) => m !== null) ?? null;
      if (urlSecretMatch) {
        blockedVerbatim(egressSecretRefusal('request URL', urlSecretMatch, profileState()));
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
        assertHostPolicy(input.url, { surface: 'full-control', ackHosts: guardedAckHosts }, toolContext);
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

    // Request body secret scanning. The question here is "does a body go out?", which is
    // NOT the consent gate's question ("does this change remote state?"). Over the schema
    // enum both answers coincide, so this is the right set today, and they are still two
    // different questions.
    //
    // They also differ on case: this predicate folds, and both spellings of "does a body leave"
    // — the `opts.body` gate below, which is the one that decides, and the `bodySent` term that
    // mirrors it for the repair — compare the RAW method. So a lowercase
    // read has its body sent and not scanned, and the GET-exfiltration check above is
    // skipped too — none of it reachable through the validated dispatch, which enforces
    // the enum case-sensitively.
    //
    // Worth stating because it is the opposite of what one would guess: the folding is what
    // CREATES the unscanned body. (The skipped exfiltration check is not its doing — that
    // comparison is raw on both sides of this change.) Unfolded, `'get'` is not a read, so
    // classified `none` and scanned. Folding stays because the declaration needs it — a
    // lowercase write must classify, and `undo-declaration.test.ts` pins that — so the cost
    // lands on one unreachable spelling and is paid knowingly.
    // ⚠ Does a body actually leave? The repair below reads THIS and not `input.body`, and that is
    // the entire behavioural content of this change: `opts.body` drops a body on GET/HEAD, so
    // repairing one there corrected a value that is then thrown away — and the note reported the
    // repair to the model anyway.
    //
    // ⛔ `opts.body` DELIBERATELY DOES NOT READ IT, and the reason is a measurement, not taste.
    // Folding the two was the obvious next step and it changed behaviour: this term narrows on
    // `typeof`, so a body that is present but not a string became `null`, no `body` key reached
    // `opts`, and a BODYLESS POST went out and returned 200 — an empty record on the remote with
    // nothing reporting it, where the condition below forwards the value and lets the transport
    // refuse it. Guarding that with a fifteenth refusal site was the next attempt and cost more
    // than it bought: this repo states the refusal count in three comments and fourteen test
    // names, all of which a new site falsifies at once. ⚠ Not because any check catches it — the
    // by-member list in the test file says of itself that it "does not notice a FIFTEENTH refusal
    // added as a plain `return`" and that "nothing cheap can". The cost is the fourteen names and
    // three sentences, and the risk is that they quietly stop being true, which is worse.
    //
    // So the predicate stays written twice, and the duplication is NOT cheap: the second spelling
    // is at `opts.body`, with the body-secret refusal and the whole write-consent gate between it
    // and this one. Nothing makes them agree. That is the known cost of not folding, stated
    // rather than dressed up.
    //
    // ⚠ NO LINE DISTANCE IS GIVEN, and that omission is deliberate. Two drafts of this sentence
    // carried one — "eleven lines", then "130 lines" — and the first was simply wrong while the
    // second was EXACT when written and went stale inside the very commit that wrote it, because
    // another hunk inserted six lines between the anchors. A measured number in a comment is a
    // claim with a maintenance cost that nothing pays. Name the anchor, not the distance.
    //
    // It holds the body rather than a boolean so the `typeof` narrowing survives to the call
    // below, which then needs no cast; a boolean would force one, because `input.body` is
    // `string | undefined`. That is `strictNullChecks`, not anything `strictest` adds, and a
    // non-null assertion would also work — this shape is preferred, not forced.
    //
    // ⚠ A THIRD spelling of the same question lives in the egress scan below —
    // `input.body && isWriteMethod(method)` — and `isWriteMethod` folds case where these two
    // compare raw. Over the schema enum all three agree on every member. Folding them is NOT
    // free, though, and an earlier draft of this paragraph said it was: the fold is what creates
    // the unscanned body for a lowercase `'get'`, so unifying them would stop sending it. That
    // is a real behaviour change on the one spelling the paragraph above calls out and pays for
    // knowingly. Named here because the next edit to the method set has to find three places for
    // THIS question — and four more on the same GET/HEAD-versus-rest axis that an enum change
    // touches: `shouldRewriteToGet` and the GET-exfiltration gate compare raw, `httpTimeoutMessage`
    // and `undoClassFor` fold. The two that FOLD are both pinned by tests; the two that compare
    // RAW are pinned by nothing, which is the half worth knowing. (An earlier draft said only
    // `undoClassFor` was pinned. False: `httpTimeoutMessage`'s fold is pinned by the
    // timeout-message test, which asserts a lowercase `head` gets the bare line.) Leaving one of
    // these out of a paragraph like this is how the compensation claim below went wrong.
    const bodySent: string | null =
      typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD'
        ? input.body
        : null;

    // ⚠ Repair a model's stray trailing close tag before `opts` is built, and ONLY when a body
    // leaves. The three conditions and the evidence live in `model-json-body.ts`; the short
    // version is that `minimax-m3` ends JSON bodies with a literal `</body>`, which makes every
    // POST through the API store fail at the far end with a misleading error, and the model then
    // repeats the identical call.
    //
    // ⚠ An earlier version of this comment justified the ordering by claiming the scan reads the
    // REPAIRED body. It was TRUE when written and went false two commits later, when the
    // direction was reversed, and it was a claim about security behaviour in a public repo. The
    // scan reads the ORIGINAL on purpose; the paragraph below says why.
    //
    // ⚠ The wrong sentence is deliberately NOT quoted here, not even as history — a test sweeps
    // this file for that exact sentence, and a sweep with an exception is a sweep somebody will
    // widen. Same rule as `scripts/gate-record.mjs` follows for its own refused format. What the
    // sweep CANNOT do is recognise the same claim in different words; it pins one spelling, and
    // its name says so.
    const repairedBody = bodySent === null ? null : repairStrayCloseTag(bodySent, headers);

    // ⚠ ONE string for the note, appended on the success path and on the timeout path. The
    // timeout half is the one that mattered: a timed-out call used to throw with the repair
    // invisible to the model, which then retried the identical broken body — the loop this
    // repair exists to end, one layer further out. Written twice the two would drift, and the
    // empty string when nothing was repaired keeps both call sites unconditional.
    //
    // ⛔ THREE CLAIMS WERE TAKEN OUT OF THIS SENTENCE, each because the code cannot support it.
    // The note is a privileged channel into the model's context, so a sentence in it is a claim
    // the engine makes, not decoration:
    //
    //   1. that the body REACHED THE NETWORK. Supportable on the success path, where a response
    //      proves it, and not on the timeout path this change adds: `timeout_ms` carries no
    //      schema minimum, the clamp floor is 1 ms, the abort timer is armed before the `try`,
    //      and `fetchPinned` resolves DNS before a byte leaves — so a 1 ms abort lands here with
    //      nothing on the wire. From in here the only observable fact is that `fetch` was CALLED,
    //      which is strictly weaker. For the six methods the schema admits, the message this
    //      note rides already carries the uncertainty ("may still have reached the server"), so
    //      dropping the clause took nothing away. ⚠ That compensation does NOT hold for a
    //      lowercase verb: `httpTimeoutMessage` folds case and returns the bare line for
    //      GET/HEAD, while this term compares raw and does send the body. Unreachable through the
    //      validated dispatch, and named because an earlier draft of this parenthetical asserted
    //      the compensation without the exception — on the one spelling the paragraph above
    //      spends its length defending.
    //   2. that the API WOULD HAVE REJECTED the call. `model-json-body.ts` measured the opposite
    //      on the API that produced this defect: HTTP 200 with an application-level
    //      "POST Data Is Empty". Accepted and misread is not rejected.
    //   3. that the rest was LEFT UNCHANGED. `withoutTrailingCloseTag` trims before and after
    //      cutting, deliberately — that second trim is what rescues a body ending in U+00A0 or
    //      U+FEFF — so trailing whitespace goes too. The sentence now says the tag was removed
    //      and claims nothing about the remainder.
    //
    // All three are REMOVED rather than gated. Gating (1) would mean classifying every exit as
    // sent or not-sent, a check per instance, which is the signature of a cut in the wrong place.
    // Same subtraction as the removed tag echo in `model-json-body.ts`: the first answer bounded
    // a symptom, the right one deleted the claim.
    //
    // Scope, and it is FIVE exits rather than the two an earlier draft of this paragraph named:
    // downstream of the repair, the body-secret refusal, both write-consent refusals, the
    // `Blocked:` translation and the raw re-throw all build their own messages and carry no note.
    // Folding them onto one append point is a change to the catch's shape and to the refusal
    // helpers, not to this constant.
    const repairNote = repairedBody === null
      ? ''
      : `\n\n**[Engine note \u2014 your request body was repaired]**\nIt had a closing tag at the end, which is not valid JSON. The engine removed that tag, and the whitespace around it, before using the body. Do not append a closing tag to a JSON body.`;

    // ⚠ The scan reads `input.body` — the ORIGINAL — and not the repaired one, which is the
    // opposite of what the first draft did under "scan what goes out". The repaired body is a
    // PREFIX of the original by construction, so scanning the original is a strict superset: it
    // catches a credential that sat in the part being removed as well. Its two failure
    // directions are not symmetric. Scanning the prefix fails OPEN on exactly the case worth
    // knowing about — a model, or a prompt injection reaching one, parking a resolved
    // `secret:NAME` in the trailing tag, which `agent.ts` substitutes before this handler sees
    // the body. Scanning the original can only over-report, on a value that is not sent.
    if (input.body && isWriteMethod(method)) {
      const secretMatch = detectSecretInContent(input.body);
      if (secretMatch) {
        blockedVerbatim(egressSecretRefusal('request body', secretMatch, profileState()));
      }
    }

    // First-use consent for outbound data requests: every method `undoClassFor`
    // classifies as a write. Named as the rule and not as a list, so that this heading
    // cannot be the copy that disagrees with the gate under it.
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
    // every unattended write (no `promptUser` in a background run).
    // Asked for writes only: a read is never gated by the contract here.
    //
    // 270: the approval is per (method, host) and holds only in the untrusted-content epoch it
    // was given in (`core/untrusted-epoch.ts`): content from a source the person did not
    // approve, which reached the conversation after the approval, makes the next write ask
    // again. Three kinds of write are never remembered and ask every time: a DELETE, a path
    // the outbound-effect table names (`core/outbound-write.ts`), and any write in a mandate's
    // session — there the person who set the mandate up gives each approval, and the approval
    // is what protects the account against an injected instruction (PRD
    // customer-granted-operator-access 4.11). A grant covers neither a table path nor, for a
    // mandate, anything H2b refused above.
    const governing = isWriteMethod(gatedMethod) ? agent.governingContract() : null;
    const contract = governing?.contract;
    const outboundEffect = isOutboundEffectWrite(input.url, gatedMethod);
    const contractGrantsWrite =
      contract !== undefined &&
      !outboundEffect &&
      contractGrants('http_request', { ...input, method: gatedMethod }, contract);
    const approvalHost = normalizeApprovalHost(new URL(input.url).hostname);
    const remembers = isWriteMethod(gatedMethod) && gatedMethod !== 'DELETE' && !outboundEffect && isOwnerPrincipal(agent.principal);
    if (isWriteMethod(gatedMethod) && !contractGrantsWrite) {
      const counters = agent.sessionCounters;
      const hostname = approvalHost;
      const key = approvalKey(gatedMethod, hostname);
      const epoch = agent.approvalEpoch?.() ?? currentEpoch(counters);
      const batch = agent.approvalBatch?.();
      if (!(remembers && isApproved(counters, key, epoch))) {
        if (!agent.promptUser) {
          blockedVerbatim(
            `Blocked: outbound ${gatedMethod} to ${hostname} requires user consent but no interactive prompt is available (autonomous/background mode).` +
            `\n${ungrantedWriteNote(gatedMethod, input.url, governing?.withheld === 'untrusted')}`,
          );
        }
        const promptUser = agent.promptUser;
        const mask = (text: string) => agent.secretStore?.maskSecrets(text) ?? text;
        const path = pathForQuestion(input.url, mask);
        const fields = bodyFieldNames(repairedBody?.body ?? input.body, mask);
        // Parallel calls of the same batch with the SAME question share one answer. Only within
        // the batch: a sub-agent shares the Session counters but not the parent's epoch, and an
        // answer given for the parent's epoch must not let the child's call through. Anything
        // that is asked every time is never shared: each such call shows its own target.
        const shareKey = remembers && batch !== undefined ? `${key}\u0000${path}\u0000${fields}` : undefined;
        let pendingMap = batch === undefined ? undefined : pendingInBatch.get(batch);
        if (batch !== undefined && !pendingMap) { pendingMap = new Map(); pendingInBatch.set(batch, pendingMap); }
        let pending = shareKey === undefined ? undefined : pendingMap?.get(shareKey);
        if (!pending) {
          pending = inSessionPromptChain(counters, async () => {
            // Re-read once it is this call's turn: the question before it may have answered it.
            if (remembers && isApproved(counters, key, epoch)) return true;
            if (remembers && batch !== undefined && deniedInBatch.get(batch)?.has(key)) {
              blockedVerbatim(`Blocked: outbound ${gatedMethod} to ${hostname} was not asked: the same write was denied earlier in this batch.`);
            }
            // A call that waited in the queue raises no prompt once the run is aborted: the
            // prompt would outlive the run as a pending row and block the Session's next one.
            if (agent.runSignal?.aborted) {
              blockedVerbatim(`Blocked: outbound ${gatedMethod} to ${hostname} was not asked: the run was stopped.`);
            }
            // Why this write is asked although the host may hold an approval. Engine text, so
            // spliced in as frame (a nested `pv`), never as a value.
            const note = remembers ? pv``
              : outboundEffect ? pv` This sends or issues something and is asked every time.`
                : gatedMethod === 'DELETE' ? pv` A DELETE is asked every time.`
                  : pv` In this session every write is asked.`;
            const answer = await promptUser(
              pv`⚠ http_request: ${gatedMethod} to ${hostname} ${path} (${fields}) — Allow outbound data?${note}`,
              ['Allow', 'Deny', '\x00'],
            );
            const allowed = ['y', 'yes', 'allow'].includes(answer.toLowerCase());
            if (remembers && allowed) recordApproval(counters, key, epoch);
            if (remembers && !allowed && batch !== undefined) {
              let denied = deniedInBatch.get(batch);
              if (!denied) { denied = new Set(); deniedInBatch.set(batch, denied); }
              denied.add(key);
            }
            return allowed;
          }).finally(() => { if (shareKey !== undefined) pendingMap?.delete(shareKey); });
          if (shareKey !== undefined) pendingMap?.set(shareKey, pending);
        }
        const allowed = await pending;
        if (!allowed) {
          blockedVerbatim(`Blocked: outbound ${gatedMethod} to ${hostname} denied by user.`);
        }
      }
    }

    const opts: RequestInit = { method, headers };
    // ⚠ UNCHANGED from before the repair landed, on purpose — see `bodySent` above for the
    // measured reason the two predicates are not folded into one.
    const outboundBody = repairedBody?.body ?? input.body;
    if (outboundBody && method !== 'GET' && method !== 'HEAD') {
      opts.body = outboundBody;
    }
    // Hard cap. The original 30s default + agent-overridable timeout meant a
    // hung Shopify endpoint locked cat's session for 28 min on 2026-05-19 —
    // the agent's run held the per-session mutex while readBodyLimited blocked
    // on a stalled response body. AbortController.signal propagates to fetch
    // but NOT to response.body.getReader() once headers have arrived, so a
    // chunked-transfer stall is invisible to the timeout below. Race below
    // is the wrap-around guarantee: no matter where in the pipeline things
    // hang, the fetch resolves within HARD_CAP plus HTTP_WALL_GRACE_MS of the timers starting.
    const requestedTimeout = input.timeout_ms ?? 30_000;
    const timeoutMs = Math.min(Math.max(1, requestedTimeout), HTTP_HARD_CAP_MS);
    const controller = new AbortController();
    // Which of OUR two limits fired, if any. The catch below decides on this, not on the error's
    // name: an abort after the headers arrived ends the body read with a plain `aborted` error
    // (the transport destroys the socket), which a name check took for an unrelated failure.
    let timedOut: 'abort' | 'wall' | null = null;
    let answeredStatus: string | undefined;
    const timeoutId = setTimeout(() => { timedOut ??= 'abort'; controller.abort(); }, timeoutMs);
    opts.signal = controller.signal;

    // Wall-clock timeout that wins even if the abort signal doesn't fire (e.g.
    // body-stream hang). Resolves with a thrown HttpTimeoutError so the catch
    // below can format the agent-visible message.
    let wallTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const wallTimeout = new Promise<never>((_, reject) => {
      wallTimeoutId = setTimeout(() => {
        timedOut = 'wall';
        controller.abort();
        reject(new Error(httpTimeoutMessage(timeoutMs, gatedMethod, true, answeredStatus)));
      }, timeoutMs + HTTP_WALL_GRACE_MS);
    });

    try {
      agent.sessionCounters.httpRequests++;
      // For a contract-governed write, re-validate every redirect hop against
      // the contract so a 307/308 can't carry the body past the host/path pin.
      //
      // An interactive write is followed only where the approval it had still covers the hop:
      // a hop that keeps a write method is refused when its target would need its own
      // question — another host, or another path for a write that is asked every time or for
      // a path of the outbound-effect table. Compared on the normalized form, so `/items`
      // redirected to `/items/` is followed. Headers ride along on a same-host hop, so the
      // hop's method is read with them.
      const askedPath = normalizeWritePath(new URL(input.url).pathname).path;
      const redirectGuard = (contractGrantsWrite && contract !== undefined)
        ? (nextUrl: string, redirectMethod: string): boolean => {
            // The hop's own method, with the override forms its target may carry: a
            // `?_method=` in a Location raises it like one in the request.
            const hop = effectiveWriteMethod(redirectMethod, headers, nextUrl);
            return hop !== null &&
              contractGrants('http_request', { url: nextUrl, method: hop }, contract) &&
              !isOutboundEffectWrite(nextUrl, hop);
          }
        : isWriteMethod(gatedMethod)
          ? (nextUrl: string, redirectMethod: string): true | 'consent' => {
              const hop = effectiveWriteMethod(redirectMethod, headers, nextUrl);
              if (hop === null) return 'consent';
              if (!isWriteMethod(hop)) return true;
              // Another write than the one asked (a Location with `?_method=DELETE`) needs
              // its own question, whatever the path.
              if (hop !== gatedMethod) return 'consent';
              const next = new URL(nextUrl);
              if (normalizeApprovalHost(next.hostname) !== approvalHost) return 'consent';
              const pathDiffers = normalizeWritePath(next.pathname).path !== askedPath;
              return pathDiffers && (!remembers || isOutboundEffectWrite(nextUrl, hop)) ? 'consent' : true;
            }
          : undefined;
      const { response, finalUrl: finalRequestUrl, hosts: answeredHosts } = await Promise.race([
        fetchWithValidatedRedirects(input.url, opts, { surface: 'full-control', ackHosts: guardedAckHosts }, toolContext, redirectGuard, attachedAuthSlot, (v) => agent.secretStore?.containsSecret(v) ?? false),
        wallTimeout,
      ]);
      // The hosts that answered, for the answer's untrusted marker: every hop on one host lets
      // the answer keep that host's write approvals; anything else makes it foreign content.
      for (const h of answeredHosts) noteAnsweredBy(normalizeApprovalHost(h));
      const status = `${response.status} ${response.statusText}`;
      answeredStatus = status;
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
      // Race the body read against the same wall-clock. The abort timer normally ends a
      // stalled body (the transport destroys the socket, and the read fails with a plain
      // `aborted`); the wall clock is the backstop for a stream that ignores even that.
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

      // ⚠ A repair that nobody can see is a defect that stops being reported. This call's result
      // says so, outside the untrusted_data wrap because it is engine guidance, not response
      // data. It lands in the run ledger (`run_tool_calls.output_json`) — there is no field that
      // records without also being read, so the MODEL sees this line too. That is a cost worth
      // naming and, here, also the useful half: the party that produced the broken argument is
      // the one being told. The user's chat is unaffected; tool results do not render as text.
      //
      // ⚠ And it quotes NOTHING from the body. An earlier version named the tag it removed; a
      // resolved `secret:NAME` can end up inside that tag, and this line is past the point where
      // either the egress scan or `maskSecrets` could catch it. `model-json-body.ts` has the
      // measurement. The model wrote the tag, so repeating it to the model adds nothing anyway.
      wrapped += repairNote;

      // Engine-managed-auth 401-hint. When the engine DECLINED to attach a
      // credential it did not fail the request — a profile that works today keeps
      // working — so the reason would otherwise be invisible and the 401 would
      // read as a bad token. That is the exact loop this whole change exists to
      // end: three token rotations against a request that carried no credential.
      // Outside the untrusted_data wrap: system guidance, not response data.
      if (response.status === 401 && auth.hint !== undefined) {
        // The hint is resolved HERE, not at attach time. Two facts it needs are only
        // settled now: whether a cross-origin hop stripped the credential header
        // (`redirectHopHeaders`), and — the reason this matters beyond wording —
        // whether the vault should be read at all. Built eagerly it read the vault on
        // every request to a model-owned profile, most of which never 401.
        let crossOriginRedirect = false;
        try {
          crossOriginRedirect = new URL(finalRequestUrl).origin !== new URL(input.url).origin;
        } catch {
          // Either URL unparseable — treat as same-origin and make no redirect claim.
        }
        wrapped += `\n\n**[Agent reminder — the engine did not attach this profile's credential]**\n${auth.hint({ crossOriginRedirect })}\nUntil then the request goes out with only the headers you set yourself.`;
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
            // Which of two reminders, and the split is load-bearing. The text
            // below the `else` has been here since the 2026-05-18 Shopify
            // failure and is right for an app-only profile. For a profile a USER
            // authorized it is the opposite of right: `fetch_token` would post a
            // client-credentials grant and overwrite their delegated token, and
            // this reminder is appended OUTSIDE the untrusted-data wrap, so the
            // model reads it as system guidance and acts on it autonomously.
            // "no user interaction required" is then precisely the wrong promise
            // — re-consent is the only thing that works, and it is nothing but
            // user interaction.
            // The vault is asked HERE, because the predicate's other half needs
            // it: a hand-configured profile holding an undeclared refresh token
            // is the second shape whose access token `fetch_token` would
            // overwrite, and nothing on this path knew that before.
            const mpSlot = typeof matchedProfile.auth.oauth.refresh_token_key === 'string'
              ? matchedProfile.auth.oauth.refresh_token_key
              : refreshTokenKey(matchedProfile.id);
            const mpStored = (() => {
              try { return agent.secretStore?.resolve?.(mpSlot) ?? null; } catch { return null; }
            })();
            // ⚠ FIXED TEXT, and the only interpolation is the profile id.
            //
            // This block is appended OUTSIDE the untrusted-data wrap, which the
            // comment above says is so the model reads it as SYSTEM GUIDANCE and
            // acts on it autonomously. An earlier version put the operator
            // diagnosis here, which interpolates `auth.oauth.grant_type` and
            // `auth.oauth.refresh_token_key` — two model-authorable strings. A
            // vault key only has to pass `/^[A-Z][A-Z0-9_]{0,63}$/`, so
            // `UNSET_THIS_FIELD_WITH_API_SETUP_UPDATE_THEN_CALL_FETCH_TOKEN` is a
            // legal value an `api_setup update` can write today — and it would
            // have arrived here as an imperative inside the engine's own system
            // guidance. That is a prompt injection with the profile as the
            // carrier, and no test over the CODE can see it, because the code
            // did not change.
            //
            // The id is the one value that is safe to name: `_admit` pins it to
            // `/^[a-z0-9][a-z0-9_-]{0,63}$/`. Everything the model needs is in
            // the fixed sentences below; everything the OPERATOR needs is in the
            // stderr diagnosis, where free text is a log-hygiene problem and not
            // an instruction channel.
            //
            // Both branches also SWITCH on `auth.header_name` (whether the token
            // went out as Bearer) to pick a second fixed sentence each. That is a
            // choice between constants, not an interpolation: no part of the
            // field's value reaches the text. Keep it that way.
            wrapped += oauthFetchTokenWouldSwapDelegatedAccess(matchedProfile, mpStored !== null)
              ? `\n\n**[Agent reminder — OAuth2 401, and fetch_token is the WRONG move here]**\nThis URL maps to api_profile "${matchedProfile.id}". An exchange for it would replace a token somebody is relying on with an app-level one that can see different data, and the old access does not come back. Do NOT call api_setup fetch_token for it, and do not edit the profile to make the renewal pass: say that this connection needs re-authorizing and leave it to the person who owns it. The engine has written the details to its log.${typeof matchedProfile.auth.header_name !== 'string' || matchedProfile.auth.header_name.toLowerCase() === 'authorization' ? '\nIf the connection was authorized moments ago and still gets 401, re-authorizing will not help either: the token went out as `Authorization: Bearer`, and some APIs want it in a header of their own (Shopify\'s Admin API: `X-Shopify-Access-Token`). Then the profile needs `auth.header_name`; say so rather than setting it yourself.' : ''}`
              : `\n\n**[Agent reminder — OAuth2 401 on a managed-OAuth api_profile]**\nThis URL maps to api_profile "${matchedProfile.id}" (auth.type=oauth2 with token_url configured). The vault's access_token is almost certainly expired. Recover with:\n  api_setup({ action: "fetch_token", id: "${matchedProfile.id}" })\nThat uses the stored client_id + client_secret to mint a fresh access_token via the OAuth grant — no user interaction required. Do NOT walk the user through "re-paste a token from the provider admin UI" — 2026-era providers (Shopify Dev Dashboard, TikTok, etc.) don't expose long-lived tokens there anymore.${typeof matchedProfile.auth.header_name !== 'string' || matchedProfile.auth.header_name.toLowerCase() === 'authorization' ? '\nIf fetch_token already succeeded moments ago and this request still got 401, minting again will not help: the token went out as `Authorization: Bearer`, and some APIs want it in a header of their own (Shopify\'s Admin API: `X-Shopify-Access-Token`). Check the API\'s docs and set `auth.header_name` on this profile.' : ''}`;
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
      // No refusal site is inside this try today — all fourteen precede it. (This line
      // used to say "above line 900"; the count was right and the LINE number had long
      // since moved, so it names the region instead. The count stays — it is checkable.)
      // This exists because `blockedFriendly`'s doc comment tells the next
      // person to throw rather than return, and following that rule HERE would
      // otherwise be the trap. A rule that is safe only outside one region of
      // the file needs the region to enforce it, not the reader to remember.
      if (err instanceof ToolSoftFailure) throw err;
      // Ahead of `friendlyBlockMessage`, whose rewrite would turn this into a generic
      // refusal: here the write was sent and answered, and only its redirect was refused.
      if (err instanceof RedirectRefusedAfterWrite) blockedVerbatim(err.message);
      if (timedOut !== null) {
        // The note rides the timeout too — see `repairNote` above for why the silent path is
        // the one that matters here.
        throw new Error(httpTimeoutMessage(timeoutMs, gatedMethod, timedOut === 'wall', answeredStatus) + repairNote);
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

/**
 * The engine-managed credential attach for a caller with no agent — a bulk run's
 * worker effect (`core/bulk-external.ts`). It is a CALL of the decision
 * `http_request` makes, not a copy: the attach reads only the profile store and the
 * vault, and both are the engine's own objects on either path.
 *
 * Only an attached credential counts. A `refusal`, a `hint` and no profile at all
 * are one answer here — the bulk path has no model header to fall back on, so any
 * of them would send the request without the credential the run was planned with.
 * No text is returned: the caller reports a fixed reason, never a profile's wording.
 */
export async function attachStoredCredential(
  url: string,
  headers: Record<string, string>,
  stores: { apiStore: NonNullable<ToolContext['apiStore']>; secretStore: NonNullable<import('../../types/index.js').IAgent['secretStore']> },
): Promise<boolean> {
  const auth = await attachEngineManagedAuth(
    url,
    headers,
    { apiStore: stores.apiStore } as Pick<ToolContext, 'apiStore'> as ToolContext,
    { secretStore: stores.secretStore } as Pick<import('../../types/index.js').IAgent, 'secretStore'> as import('../../types/index.js').IAgent,
  );
  return auth.slot !== undefined && auth.refusal === undefined;
}
