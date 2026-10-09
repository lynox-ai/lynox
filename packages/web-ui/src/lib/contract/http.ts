/**
 * Cross-repo HTTP wire shapes (money + health + auth + OAuth) — SINGLE SOURCE
 * OF TRUTH.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); the private
 * control plane compiles a byte-identical vendored copy. Changes here are
 * WIRE-CONTRACT changes: each shape below crosses the engine↔control-plane
 * HTTP boundary and both sides must agree on every field name.
 *
 * Golden fixtures for every shape live in `src/contract/fixtures/` — generated
 * from the REAL serializers (never hand-edited; generator refs in
 * `fixtures/README.md`). Both repos' pair tests drive their real
 * serializer/parser against the same fixture bytes, so a field rename fails on
 * both sides before it ships.
 *
 * Mismatch discipline is parse-tolerant-first: when a shape gains a field, the
 * PARSING side lands tolerance before the emitting side starts sending it.
 *
 * This file must stay DEPENDENCY-FREE (pure literals, types, and functions) —
 * consumers compile it standalone.
 */

// === Usage flush — POST /internal/usage/:instanceId (engine → CP) ===

/** One run's cost report inside a usage flush batch. */
export interface UsageReportRun {
  run_id: string;
  /**
   * Deliberately `string`, not `vocab.ts` ModelTier: the parse side treats it
   * as an opaque label (unknown values are legal on the wire) even though
   * today's emit site sends a ModelTier.
   */
  model: string;
  /** Whole USD cents; the engine carries sub-cent remainders locally. */
  cost_cents: number;
}

export interface UsageFlushRequest {
  runs: UsageReportRun[];
}

export interface UsageFlushResponse {
  /** How many of the batch's runs were newly debited (dedup skips excluded). */
  accepted: number;
  balance_cents: number;
  allowed: boolean;
}

// === Provider incident — POST /internal/usage/:instanceId/incident (engine → CP) ===

/**
 * The engine reports a PROVIDER-LEVEL failure the control plane cannot see any
 * other way: on managed hosting the CP pays the LLM bill, so a suspended or
 * credit-exhausted provider account is a full chat outage for every tenant on
 * that provider — and it surfaces only as a per-request error while `/api/health`
 * stays green. The CP raises an operator alert naming the provider on the FIRST
 * such report, not a fleet-wide pattern.
 *
 * `kind` is the literal `'provider_billing'` — the only kind the engine emits
 * today. The CP parses it tolerantly (an unrecognised future kind is ignored, not
 * an error), which is why a widened union here would stay backward-compatible.
 * `provider_host` is the host the failing call targeted (e.g. `api.fireworks.ai`),
 * which the CP maps to a display label. `status` is the HTTP status that carried
 * the signal. No secrets, no run content — a class signal, not a payload.
 */
export interface ProviderIncidentRequest {
  kind: 'provider_billing';
  provider_host: string;
  status: number;
}

// === Usage status — GET /internal/usage/:instanceId/status (engine ← CP) ===

/**
 * What the control plane states about this account's spend gate. The engine's
 * local balance mirror acts on this token and never on `balance_cents` alone.
 *
 *  - `'balance'`  — the control plane funds this instance and gates it by
 *    balance: `balance_cents` is a number, the engine anchors its mirror on it.
 *  - `'none'`     — the control plane funds this instance and states that it is
 *    NOT balance-gated (a comp account: metered, never refused for money). The
 *    engine clears its mirror. The control plane must emit this only where it
 *    is the key supplier — never for an instance it merely does not fund.
 *  - `'unfunded'` — the control plane does not fund this instance's spend
 *    (BYOK/hosted) and makes no statement about a gate. The engine reads it
 *    exactly like an absent or unrecognised value: a numeric `balance_cents`
 *    beside it would still anchor (the CP never sends that pair), a `null`
 *    leaves the mirror as it was.
 *
 * Why a token and not the absence of a number: `balance_cents: null` only says
 * there is nothing to report on this branch; it says nothing about the gate,
 * and a `null` can arise by accident (`JSON.stringify(NaN)` emits it) where a
 * token cannot.
 */
export type SpendGate = 'balance' | 'none' | 'unfunded';

/**
 * High-frequency liveness/credit poll. `balance_cents` is `null` when the
 * control plane has no balance to report on this branch (BYOK/hosted); the
 * gate is stated by `spend_gate`, never inferred from that null. The engine
 * dereferences `allowed`, `balance_cents` and `spend_gate`, parse-tolerant: a
 * response without `spend_gate` comes from an older control plane and is read
 * as if no statement were made — a numeric `balance_cents` still anchors the
 * mirror, a `null` leaves it as it was.
 */
export interface UsageStatusResponse {
  allowed: boolean;
  balance_cents: number | null;
  /** Absent on the non-managed branch. */
  included_budget_cents?: number | undefined;
  /**
   * Deliberately `string`, not `vocab.ts` BillingTier: the emit site falls
   * back to the raw stored tier when normalization fails, so non-canonical
   * values are legal on the wire.
   */
  tier: string;
  /**
   * The control plane must state it on every branch. The engine treats an
   * absent or unrecognised value as no statement and keeps its current mirror.
   */
  spend_gate: SpendGate;
}

// === Usage summary — GET /internal/usage/:instanceId/summary (engine ← CP) ===

export interface UsageSummaryPeriod {
  start_iso: string;
  end_iso: string;
  source: 'stripe-billing';
}

/**
 * Dashboard-friendly budget view. Non-managed providers get `{ managed: false }`
 * with every other field absent; the engine then falls back to its local
 * budget view (all fields optional on the parse side for exactly that reason).
 */
export interface UsageSummaryResponse {
  managed: boolean;
  /** Raw stored tier (not normalized) — same tolerance as UsageStatusResponse.tier. */
  tier?: string | undefined;
  /** Included (subscription) budget this period. */
  budget_cents?: number | undefined;
  /** Genuine top-ups (credit packs) granted this period. */
  topup_cents?: number | undefined;
  /** included budget + top-ups — the denominator the dashboard sizes against. */
  available_cents?: number | undefined;
  used_cents?: number | undefined;
  balance_cents?: number | undefined;
  period?: UsageSummaryPeriod | null | undefined;
}

// === Health — GET /api/health (CP ← engine) ===

/**
 * The engine's health body. The control plane's rollout gate reads `version`
 * and `build_sha`; its health monitor reads the metrics blocks.
 */
export interface HealthBody {
  status: string;
  version: string;
  /**
   * Git SHA baked into the production image via build-arg; `null` in dev
   * images and locally-built containers (= version-only rollout verification).
   */
  build_sha: string | null;
  uptime_s: number;
  process: {
    memory_used_mb: number;
    memory_rss_mb: number;
    cpu_user_ms: number;
    cpu_system_ms: number;
  };
  system: {
    memory_total_mb: number;
    memory_free_mb: number;
    load_avg_1m: number;
    load_avg_5m: number;
    disk_total_gb?: number | undefined;
    disk_used_gb?: number | undefined;
  };
  engine: {
    active_sessions: number;
    total_threads: number;
  };
}

// === Magic-link verify — POST /internal/auth/verify-magic (engine → CP) ===

/**
 * Body the engine's `/auth/magic` callback posts to the control plane.
 *
 * Note the casing: `instanceId` here, `instance_id` on the OAuth claim below.
 * The inconsistency is real and predates the contract; it is pinned rather than
 * fixed because renaming either key is a wire change and both sides currently
 * agree. A shape that is ugly and pinned costs nothing; a shape that is tidy on
 * one side only costs a login path.
 */
export interface MagicLinkVerifyRequest {
  token: string;
  instanceId: string;
  /** See `LOGIN_PRINCIPAL_VERSION`. Absent on a caller that predates it. */
  principal_version?: typeof LOGIN_PRINCIPAL_VERSION | undefined;
}

// === Login principal — /internal/auth/request, /verify, /verify-magic ===

/**
 * The login-principal exchange a caller understands.
 *
 * A login can now be the owner's or a mandate recipient's: a person the owner
 * let in for a bounded time. Only a caller that reads the principal in the
 * success body can tell them apart. A caller that predates the field reads
 * any success as the owner, so the control plane admits a mandate recipient
 * only when the request carries a version it accepts. The version names
 * everything the caller does with a principal, not only that it reads one:
 * it is raised whenever that grows, and the control plane admits recipients
 * only to callers of a version that does all of it. Sent on all three auth
 * requests: the code request too, so that no code is mailed for a login the
 * caller could not carry.
 */
export const LOGIN_PRINCIPAL_VERSION = 1;

/** Body of `POST /internal/auth/request`. */
export interface AuthCodeRequest {
  email: string;
  instanceId: string;
  principal_version?: typeof LOGIN_PRINCIPAL_VERSION | undefined;
}

/** Body of `POST /internal/auth/verify`. */
export interface AuthCodeVerifyRequest {
  email: string;
  code: string;
  instanceId: string;
  principal_version?: typeof LOGIN_PRINCIPAL_VERSION | undefined;
}

/**
 * Who a mandate login is, as the control plane verified it. The control plane
 * folds `email` (lower case) and `display` (one line) when the mandate is
 * granted; the reader refuses rather than repairs a value that is not.
 */
export interface MandateLoginPrincipal {
  kind: 'mandate';
  email: string;
  display: string;
  mandate_id: string;
  /** When the mandate ends, ISO 8601. A session never outlives it. */
  mandate_expires_at: string;
}

/**
 * Success body of `/internal/auth/verify` and `/internal/auth/verify-magic`.
 * No `principal` means the owner; that is also how every success body read
 * before the principal existed.
 */
export interface AuthLoginSuccessBody {
  valid: true;
  principal?: MandateLoginPrincipal | undefined;
}

export const LOGIN_PRINCIPAL_EMAIL_MAX = 254;
export const LOGIN_PRINCIPAL_DISPLAY_MAX = 200;
export const LOGIN_PRINCIPAL_ID_MAX = 64;

// Control and format characters, including line and paragraph separators and
// the bidi controls: a value carrying one is refused, not folded.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

/**
 * Read the principal off a success body. `null` is the owner (no principal);
 * `'invalid'` is a principal that is present but not one this reader knows,
 * and the only safe reading of that is to refuse the login: treating it as
 * the owner would hand an unknown login the owner's session.
 */
export function readLoginPrincipal(body: unknown): MandateLoginPrincipal | null | 'invalid' {
  if (body === null || typeof body !== 'object') return 'invalid';
  const principal = (body as { principal?: unknown }).principal;
  if (principal === undefined) return null;
  if (principal === null || typeof principal !== 'object') return 'invalid';
  const p = principal as Record<string, unknown>;
  if (p['kind'] !== 'mandate') return 'invalid';
  const email = p['email'];
  if (!isSafeText(email, LOGIN_PRINCIPAL_EMAIL_MAX) || email !== email.toLowerCase() || !email.includes('@')) return 'invalid';
  if (!isSafeText(p['display'], LOGIN_PRINCIPAL_DISPLAY_MAX)) return 'invalid';
  if (!isSafeText(p['mandate_id'], LOGIN_PRINCIPAL_ID_MAX)) return 'invalid';
  const expires = p['mandate_expires_at'];
  if (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires))) return 'invalid';
  return {
    kind: 'mandate',
    email,
    display: p['display'],
    mandate_id: p['mandate_id'],
    mandate_expires_at: expires,
  };
}

/**
 * Reasons the control plane can refuse a magic link, as sent on the wire.
 *
 * This is the CLOSED set of `error_code` values `/internal/auth/verify-magic`
 * emits. The engine translates each one into a user-visible reason; a value
 * outside this set means the engine is talking to a control plane it does not
 * understand, and the safe reading of that is "could not reach a CP I know",
 * not "your link is invalid" — so unknown maps to the engine's `cp_unreachable`
 * and the user is told to retry rather than to request a new link.
 *
 * The engine's own reason union is WIDER (it adds locally-decided outcomes like
 * a missing token, a self-hosted instance, and the unreachable case itself).
 * Only the values that actually cross the wire belong here.
 */
export const MAGIC_LINK_ERROR_CODES = ['rate_limited', 'expired', 'replay', 'invalid'] as const;

export type MagicLinkErrorCode = (typeof MAGIC_LINK_ERROR_CODES)[number];

/** Runtime membership test for a value parsed off the wire. */
export function isMagicLinkErrorCode(value: unknown): value is MagicLinkErrorCode {
  return typeof value === 'string' && (MAGIC_LINK_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Error body for the auth endpoints. `error` is human-readable and NOT part of
 * the contract (it is copy, and it changes); `error_code` is. It is optional
 * because the status code remains the fallback when it is absent.
 */
export interface AuthErrorBody {
  error: string;
  error_code?: MagicLinkErrorCode | undefined;
}

// === OAuth claim — POST /internal/oauth/google/claim (engine → CP) ===

/** One-time claim of the Google tokens the CP holds after the redirect dance. */
export interface OAuthClaimRequest {
  instance_id: string;
  claim_nonce: string;
}

/**
 * The live credential handoff. Every field is dereferenced by the engine, so a
 * rename on either side breaks Google integrations with no error at the seam —
 * the claim succeeds, the tokens land as `undefined`, and the failure surfaces
 * later as an unrelated auth error against Google.
 */
export interface OAuthClaimResponse {
  access_token: string;
  /**
   * The raw Google refresh token.
   *
   * ⚠ BEING RETIRED. It is here for engines that predate `refresh_handle` and
   * still refresh against Google themselves. Once the fleet is past the release
   * that uses the handle, this field goes.
   *
   * Handing it down is what the CP-exchange decision (2026-08-26) removes: an
   * engine holding it needs lynox's client secret to use it, which is why the
   * secret was going to be emitted to every tenant in the first place.
   */
  refresh_token: string;
  /**
   * The same refresh token, sealed to THIS instance by the control plane.
   *
   * Optional so an older engine is unaffected — it simply keeps using
   * `refresh_token`. A newer engine prefers this and never learns the raw
   * value: it presents the handle to `POST /internal/oauth/google/refresh`,
   * which unseals it with the instance's own key and does the Google call
   * control-plane-side. A handle lifted from one tenant is inert at another,
   * because unsealing uses the key of the instance that authenticated.
   *
   * Opaque by contract. Its format is the control plane's business and may
   * change without a wire change; nothing outside the CP may parse it.
   */
  refresh_handle?: string;
  /** Absolute expiry, epoch milliseconds (not a TTL, not seconds). */
  expires_at: number;
  scopes: string[];
  /**
   * The Google account the grant belongs to, so the card can say WHOSE it is.
   *
   * Optional, and the optionality is the contract rather than caution: the
   * control plane learns the address from the `openid email` scopes at consent,
   * and a grant made before Stage 1 requested them has none. Absent therefore
   * means UNKNOWN — never "no account" — and the card falls back to naming the
   * connection without an address rather than showing an empty one.
   *
   * ⚠ It is NOT an identifier. Google addresses change, and two grants for the
   * same mailbox can differ in case and dots; nothing may key on this. The one
   * thing that identifies a connection is the connection row itself (§3.10).
   *
   * ⚠ DELIBERATELY ABSENT FROM `fixtures/oauth-claim-response.json` until the
   * control plane emits it (wave W6). The fixture's serializer IS the control
   * plane (`fixtures/README.md`), so a fixture carrying a field the CP does not
   * yet produce is hand-written — the one thing that file forbids. It also
   * breaks the CP's own pair test, which asserts the key set whole: an added
   * key is drift, and the engine's parser would not know to expect it.
   */
  email?: string;
}

// === OAuth refresh — POST /internal/oauth/google/refresh (engine → CP) ===

/**
 * Refresh on behalf of an instance, so lynox's client secret never leaves the
 * control plane.
 *
 * Authenticated exactly like the claim: `x-instance-secret`, matched against
 * `instances.instanceSecret` in constant time. The handle is bound on top of
 * that — presenting someone else's handle fails at the unseal, not at a lookup,
 * so this endpoint cannot be used as an oracle that redeems arbitrary refresh
 * tokens.
 */
export interface OAuthRefreshRequest {
  instance_id: string;
  /** The `refresh_handle` from the claim, or from a previous refresh. */
  refresh_handle: string;
}

/**
 * A fresh access token, and nothing the caller did not already have.
 *
 * ⚠ The engine MUST cache `access_token` until `expires_at`. That is not an
 * optimisation: with the refresh path routed through the control plane, an
 * uncached engine reaches for the CP on every expiry and the CP becomes a
 * runtime dependency of every Google call rather than of the refresh.
 */
export interface OAuthRefreshResponse {
  access_token: string;
  /** Absolute expiry, epoch milliseconds (not a TTL, not seconds). */
  expires_at: number;
  /**
   * Present only when Google rotated the refresh token, which it may do on any
   * refresh. The engine must replace its stored handle when this appears, or
   * the next refresh presents a handle Google has already invalidated.
   */
  refresh_handle?: string;
}

// === OAuth revoke — POST /internal/oauth/google/revoke (engine → CP) ===

/**
 * Revoke the grant behind a refresh handle at Google, on behalf of the instance
 * that holds it.
 *
 * A brokered instance holds only the sealed handle, never the refresh token, so
 * once its access token has expired it cannot revoke at Google itself. The
 * control plane can open the handle and can.
 *
 * Authenticated exactly like the refresh: `x-instance-secret`, matched against
 * `instances.instanceSecret` in constant time, and the handle must unseal under
 * that instance's key.
 */
export interface OAuthRevokeRequest {
  instance_id: string;
  /** The handle the instance holds — the one it is about to drop. */
  refresh_handle: string;
}

/**
 * `revoked: true` only when Google confirmed the grant is gone: it answered the
 * revoke with success, or reported the token as already invalid. Every other
 * outcome is an error status, never `revoked: false` with a 200 — the engine
 * reports "not confirmed at Google" for anything but this exact answer.
 */
export interface OAuthRevokeResponse {
  revoked: true;
}
