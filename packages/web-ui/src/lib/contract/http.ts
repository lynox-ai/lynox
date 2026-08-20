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

// === Usage status — GET /internal/usage/:instanceId/status (engine ← CP) ===

/**
 * How the control plane gates this account's spend — the POSITIVE statement
 * the engine's local balance mirror acts on. Never inferred from
 * `balance_cents`.
 *
 *  - `'balance'` — the account is balance-gated: `balance_cents` is a number
 *    and the engine anchors its mirror on it.
 *  - `'none'`    — the control plane states that this account is NOT
 *    balance-gated: a comp account (metered, never refused for money) or a
 *    provider the control plane does not fund at all. The engine clears its
 *    mirror.
 *
 * Why a token and not the absence of a number: `balance_cents: null` is a
 * PROVIDER-TYPE fact ("nothing to report on this branch"), not an entitlement
 * fact. Two earlier attempts read an entitlement out of that null and were
 * both wrong in opposite directions — one froze the mirror, the other
 * disarmed it on a container that still held the pooled key. A `null` can
 * also arise by accident (`JSON.stringify(NaN)` emits it); a token cannot.
 */
export type SpendGate = 'balance' | 'none';

/**
 * High-frequency liveness/credit poll. `balance_cents` is `null` when the
 * control plane has no balance to report on this branch (BYOK/hosted). That
 * is a provider-type fact and says NOTHING about whether the account is
 * gated — `spend_gate` does. The engine dereferences `allowed`,
 * `balance_cents` and `spend_gate`, parse-tolerant: a response without
 * `spend_gate` comes from an older control plane and leaves the mirror as it
 * was — a legacy `null` does not clear it.
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
   * Required on the emit side — every branch states it. The engine treats an
   * absent or unrecognised value as "unknown" and keeps its current mirror.
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
  refresh_token: string;
  /** Absolute expiry, epoch milliseconds (not a TTL, not seconds). */
  expires_at: number;
  scopes: string[];
}
