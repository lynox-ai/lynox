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
}

// There is deliberately NO type here for the success body. The control plane
// answers `{valid: true}`, but the engine branches on `res.ok` and never reads
// the field — so the wire does not depend on the two sides agreeing about it,
// which is the membership test in `README.md`. Pinning it would have looked
// thorough and quietly widened the contract to cover something no one parses.

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
   * that uses the handle, this field goes — DEF-retire-raw-refresh-token.
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
