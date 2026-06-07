/**
 * BYOK custom-endpoint allowlist + disclosure (Web UI side).
 *
 * Web-UI mirror of the engine-side `core/src/core/llm/endpoint-allowlist.ts`
 * single-source-of-truth. The web-ui package architecture forbids direct
 * core imports (avoids dist/ rebuild churn — see the catalog.ts twin pattern),
 * so we keep both copies in lockstep. The pure-TS twin has the unit-test
 * coverage; this twin powers the Settings modal.
 *
 * Wave 5d (HN-launch hardening 2026-05-25): non-allowlisted endpoint save
 * attempts must surface a disclosure modal before the PUT to /api/config so
 * the user explicitly accepts controller-responsibility for the third-party
 * endpoint (the engine's DPA / sub-processor list cannot cover unknown
 * customer-configured endpoints).
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

const ALLOWLISTED_PATTERNS: readonly RegExp[] = [
  /\.openai\.azure\.com$/,
  // NOTE: deliberately NO `*.amazonaws.com` — kept in sync with the engine
  // twin (src/core/llm/endpoint-allowlist.ts), which dropped it in core #691
  // (a too-broad suffix vouched for any AWS host / Bedrock proxy). Without
  // this sync the client would skip the disclosure modal for an amazonaws
  // host while the server still 400s it → a dead-end save the user can't accept.
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/,
  /\.local$/,
  /\.lan$/,
  /\.intranet$/,
];

/**
 * Returns true iff the given URL is on lynox's vetted sub-processor list
 * (or a private-LAN / localhost address). Pure mirror of the engine-side
 * `isAllowlistedEndpoint`.
 *
 * Empty/whitespace input returns true (no decision to make — the save-button
 * itself is the gate). Only well-formed non-allowlisted URLs trip the modal.
 */
export function isAllowlistedEndpoint(url: string | null | undefined): boolean {
  if (!url || url.trim().length === 0) return true;
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
 * Extract just the hostname for use as a `{hostname}` interpolation in the
 * i18n disclosure body. Falls back to the raw URL when parsing fails so the
 * user still sees what they typed.
 */
export function disclosureHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
