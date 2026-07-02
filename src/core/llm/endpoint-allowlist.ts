/**
 * Endpoint allowlist for BYOK / custom-LLM-provider configurations.
 *
 * Context (Wave 5d, HN-launch hardening 2026-05-25):
 *   lynox supports user-configured `base_url` values (custom OpenAI-compatible
 *   proxies, self-hosted LiteLLM, vendor APIs not yet in our catalog). lynox
 *   cannot enumerate every endpoint a customer might configure in its DPA /
 *   sub-processor list (Prighter requires explicit listing), so a non-vetted
 *   URL would arguably make lynox a controller-side party to the third-party
 *   data-processing relationship.
 *
 *   This module is the single source of truth for "is this endpoint already
 *   on lynox's vetted sub-processor list?". Three call sites enforce it:
 *     1. Settings UI    — modal with disclosure + accept checkbox before save
 *     2. `api_setup`    — returns REQUIRES_USER_CONFIRMATION until the agent
 *                         re-calls with confirm_custom_endpoint=true
 *     3. Engine boot    — refuses to start when env-driven custom endpoint
 *                         is not accompanied by LYNOX_CUSTOM_ENDPOINT_ACCEPTED
 *
 *   For non-allowlisted endpoints, captured user acceptance shifts the
 *   controller-responsibility for the third-party endpoint to the customer.
 *
 *   Critical timing window: zero custom endpoints are configured in production
 *   at landing time, so this is the clean implementation window — no existing
 *   users get broken.
 */

/**
 * Exact-match allowlist of vetted endpoints. These are providers lynox has
 * either contracted with directly (DPA in place) or are private-LAN /
 * localhost addresses where lynox bears no third-party-processor exposure.
 */
const ALLOWLISTED_HOSTS: ReadonlySet<string> = new Set<string>([
  'api.mistral.ai',
  'api.anthropic.com',
  'api.openai.com',
  'api.groq.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'aiplatform.googleapis.com',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
]);

/**
 * Hostname patterns that vouch for a class of endpoints rather than a single
 * host: Azure OpenAI deployments, RFC1918 private LAN, mDNS.
 *
 * NOTE: there is deliberately NO `*.amazonaws.com` entry. It was added to vouch
 * for AWS Bedrock, but Bedrock was removed as a provider and the apex pattern
 * over-vouched — it silently allowlisted ANY self-hosted model behind a default
 * AWS hostname (`ec2-*.compute-*.amazonaws.com`, SageMaker), letting a BYOK
 * customer point the engine at an uncensored cloud model WITHOUT triggering the
 * controller-shift disclosure. Such endpoints now correctly fall through to the
 * disclosure gate like any other customer-configured endpoint.
 *
 * IMPORTANT: each pattern is suffix-anchored (`$`) or prefix-anchored (`^`)
 * to defeat suffix-spoof attacks like `evil.openai.azure.com.attacker.com`,
 * which would still match a naive `.openai.azure.com` substring check.
 */
const ALLOWLISTED_PATTERNS: readonly RegExp[] = [
  /\.openai\.azure\.com$/,
  // RFC1918 — IP-octet form only. The numeric-octet anchors prevent a public
  // DNS name like `10.example.com` from being mistaken for the 10.0.0.0/8
  // block. `\d{1,3}` is bounded by the dotted-quad terminator (`$`) so we
  // don't accept `10.0.0.0.evil.com` either.
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/,
  /\.local$/,
  /\.lan$/,
  /\.intranet$/,
];

/**
 * Returns true iff the given URL points at a vetted endpoint that lynox can
 * already cover under its existing DPA / sub-processor list, OR is a
 * private-LAN / localhost address with no third-party exposure.
 *
 * Returns false for any host outside the allowlist AND for malformed URLs
 * (so callers get a fail-closed default — non-URL inputs must trigger
 * disclosure / refusal at the call site, never silent-allow).
 *
 * Only http/https protocols are accepted; ftp/file/javascript URLs short-
 * circuit to false even if the host would otherwise match.
 */
export function isAllowlistedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (ALLOWLISTED_HOSTS.has(u.hostname)) return true;
    return ALLOWLISTED_PATTERNS.some((p) => p.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Persisted record that a user accepted controller-responsibility for the
 * non-allowlisted egress hosts a profile can drive a credentialed request to.
 *
 * The save-time gate (`api_setup` create/update) captures acceptance via the
 * transient `confirm_custom_endpoint` tool input, but that signal is consumed
 * at save and is NOT otherwise durable. A profile can re-enter the store WITHOUT
 * passing that gate — `ApiStore.loadFromDirectory` at boot, or a JSON written
 * into the apis dir — at which point nothing distinguishes "user accepted this
 * endpoint" from "this endpoint was never accepted". Persisting acceptance onto
 * the profile lets the runtime egress paths (`fetch_token`, `http_request`
 * OAuth2 attach) refuse fail-closed on an un-accepted profile without
 * re-prompting a legit user.
 *
 * `hosts` is bound to the SPECIFIC accepted hostnames (not a blanket boolean),
 * so swapping a profile's `token_url`/`base_url` to a DIFFERENT non-allowlisted
 * host after acceptance does not inherit the old ack — the swap re-gates.
 *
 * Trust boundary: the ack is trusted as loaded from disk. It closes the
 * un-accepted-profile re-entry case; it does NOT defend against an adversary who
 * can already WRITE the apis dir — such a writer could forge a matching ack.
 * That write boundary is the filesystem: workspace isolation keeps the agent out
 * of the apis dir, and self-hosted single-user mode relies on OS permissions.
 * (Migration transfer does NOT carry api profiles — only whitelisted DBs +
 * config + artifacts + vault — so it is not a re-entry vector here.)
 */
export interface CustomEndpointAck {
  /** Always `true` when present; absence means "no acceptance recorded". */
  accepted: true;
  /** Non-allowlisted hostnames the user accepted controller-responsibility for. */
  hosts: string[];
  /** ISO-8601 timestamp of acceptance. */
  accepted_at: string;
}

/**
 * True iff `ack` records acceptance covering the host of `url`. Fail-closed:
 * a missing/incomplete ack, a host not in the accepted set, or a malformed URL
 * all return false. Callers gate a credentialed egress on
 * `isAllowlistedEndpoint(url) || isEndpointAcked(ack, url)`.
 *
 * Structural in its input (takes the ack object, not the whole ApiProfile) so
 * this module stays free of an `api-store` import — no dependency cycle.
 */
export function isEndpointAcked(ack: CustomEndpointAck | undefined, url: string): boolean {
  if (!ack || ack.accepted !== true) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ack.hosts.includes(host);
}

/**
 * Build the disclosure text shown to the user / agent when a non-allowlisted
 * endpoint is configured. Single source of truth — Settings UI, `api_setup`
 * tool, and engine boot all read the same wording so the customer sees a
 * consistent claim about what they're accepting.
 *
 * Falls back to a malformed-URL error message when the input doesn't parse.
 */
export function describeDisclosure(url: string): string {
  try {
    const u = new URL(url);
    return `Custom endpoint outside lynox's listed sub-processors: ${u.hostname}. By saving this configuration, you accept controller responsibility for the data-processing relationship with ${u.hostname}. lynox's DPA does not cover third-party endpoints you configure. See Terms — Customer-Configured Endpoints.`;
  } catch {
    return `Custom endpoint URL is malformed: ${url}`;
  }
}

/**
 * Outcome of evaluating a configured `api_base_url` at engine boot.
 *
 *   - 'allowlisted'        — vetted endpoint, boot proceeds silently
 *   - 'accepted'           — non-allowlisted but operator set
 *                            LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true, boot proceeds
 *                            with a stderr WARNING
 *   - 'refuse'             — non-allowlisted and no acceptance flag, boot
 *                            must abort with a clear stderr error
 *   - 'skip'               — no `api_base_url` set, no action needed
 */
export type EndpointBootDecision = 'allowlisted' | 'accepted' | 'refuse' | 'skip';

/**
 * Pure decision function for the engine-boot allowlist gate. Split out from
 * the side-effectful caller so it can be unit-tested without spinning up an
 * Engine and intercepting stderr/process.exit.
 */
export function evaluateEndpointBootGate(
  baseUrl: string | null | undefined,
  acceptedFlag: string | undefined,
): EndpointBootDecision {
  if (!baseUrl || baseUrl.trim().length === 0) return 'skip';
  if (isAllowlistedEndpoint(baseUrl)) return 'allowlisted';
  if (acceptedFlag === 'true') return 'accepted';
  return 'refuse';
}

/**
 * Build the stderr refusal text emitted when the boot gate fires `refuse`.
 * Public so unit tests can pin the exact wording (the message is also the
 * audit-log evidence on engine startup failure).
 */
export function buildBootRefusalMessage(baseUrl: string): string {
  let host = baseUrl;
  try { host = new URL(baseUrl).hostname; } catch { /* keep raw value */ }
  return `[lynox] Refusing to boot: custom endpoint ${host} is not on lynox's vetted sub-processor list. Set LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true to proceed and accept controller-responsibility for this endpoint. See Terms — Customer-Configured Endpoints.`;
}

/**
 * Build the stderr WARNING text emitted on `accepted` — visible audit-trail
 * for operators who opted in via the env flag.
 */
export function buildBootAcceptedWarning(baseUrl: string): string {
  let host = baseUrl;
  try { host = new URL(baseUrl).hostname; } catch { /* keep raw */ }
  return `[lynox] WARNING: custom endpoint ${host} accepted via LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true. ${describeDisclosure(baseUrl)}`;
}
