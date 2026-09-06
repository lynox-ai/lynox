/**
 * The broker start token — SINGLE SOURCE OF TRUTH for its format.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); the private
 * control plane compiles a byte-identical vendored copy. A change here is a
 * WIRE-CONTRACT change: the engine MINTS this token and the control plane
 * VERIFIES it, so the two must derive the bytes from the same code.
 *
 * Why it exists: `GET /oauth/google/start` on the control plane is
 * unauthenticated, so anything that can reach it can begin a Google consent
 * flow naming any instance. Stage 1 binds the START to an authenticated user of
 * the tenant — the smallest form that closes it, rather than an auth system on
 * a route that is entered by top-level navigation.
 *
 * ⚠ WHAT IS DELIBERATELY NOT HERE: the HMAC. This directory is dependency-free
 * (`README.md`) and `node:crypto` is a dependency, so each side computes
 *
 *     sig = HMAC-SHA256(key = HMAC-SHA256(secret, BROKER_START_PURPOSE), payload)
 *
 * in its own code, with its own timing-safe compare. ⚠ The golden fixture
 * `fixtures/broker-start-token.json` that pins those bytes across the repo
 * boundary does NOT exist yet: a fixture is generated from a real serializer
 * (`fixtures/README.md`), and the serializer is the minting route, which lands
 * with the engine half of this wave. Until then the only thing pinning the
 * format is the literal in `tests/contract-broker-start.test.ts`, which binds
 * ONE side. Saying so beats a comment that describes a pair test nobody wrote.
 * The split is not
 * cosmetic: what both sides MUST agree on byte-for-byte is the payload and the
 * framing, and that is what this file fixes. A shared HMAC helper would fix the
 * same bytes and drag a runtime dependency into a directory two repos compile
 * standalone.
 *
 * The derivation follows the domain-separated family already in the control
 * plane (`middleware/customer-auth.ts` › `deriveAdminSessionSecret` and its
 * siblings): key the HMAC on a per-instance secret and separate uses by a
 * domain label. It deliberately does not reuse `deriveOAuthStateSecret`, which
 * keys on the CP-wide admin token rather than a per-instance secret.
 *
 * This file must stay DEPENDENCY-FREE (pure literals, types, and functions).
 */

/** Framing version. A token that does not open with this is not ours. */
export const BROKER_START_VERSION = 'v1';

/**
 * How long a minted start token is accepted, in seconds.
 *
 * Five minutes is the consent round-trip with room for a slow chooser, not a
 * session: the token authorises STARTING a flow, and the claim that follows has
 * its own one-time row.
 */
export const BROKER_START_TTL_SEC = 300;

/**
 * Allowance for clock skew between engine and control plane, in seconds.
 *
 * Applied to the FUTURE side as well: a token minted by an engine whose clock
 * runs ahead is otherwise refused for the whole offset, which looks to the user
 * like a broken Connect button and to the operator like nothing at all.
 */
export const BROKER_START_SKEW_SEC = 60;

/**
 * The domain label the signing key is derived under.
 *
 * Separates this signature from every other use of the same instance secret —
 * without it, a token minted for one purpose verifies for another.
 */
export const BROKER_START_PURPOSE = 'lynox-broker-start-v1';

/** Byte length of the nonce, before hex encoding. */
export const BROKER_START_NONCE_BYTES = 16;

/** The parts of a start token, after framing is stripped and validated. */
export interface BrokerStartToken {
  /** Unix seconds at minting. */
  ts: number;
  /** Hex-encoded nonce, `BROKER_START_NONCE_BYTES` bytes. */
  nonce: string;
  /** Hex-encoded HMAC over {@link brokerStartPayload}. */
  sig: string;
}

/**
 * The exact bytes both sides sign. Order and separator are the contract.
 *
 * `instanceId` is inside the payload rather than only in the query string: the
 * signature must bind the token to the instance it was minted for, or a token
 * from one tenant starts a flow naming another.
 */
export function brokerStartPayload(parts: { instanceId: string; ts: number; nonce: string }): string {
  // The instance id is OPAQUE by contract (`env-registry.ts`), so it may contain
  // the separator and this function must not assume otherwise. What makes the
  // decomposition unique anyway is that the two fields AFTER it are constrained:
  // `nonce` is fixed-length hex and `ts` is digits only, so a reader taking the
  // last two dot-separated fields recovers all three parts whatever the id holds.
  //
  // That argument fails the moment `ts` can carry a dot — `{id: 'tenant.5', ts: 3}`
  // and `{id: 'tenant', ts: 5.3}` produce the SAME bytes, and one tenant's token
  // then verifies for another. Rejecting a non-integer here is what keeps the
  // uniqueness claim true; it throws rather than coercing because the only caller
  // is a minting site of ours, where a fractional timestamp is a bug to see now,
  // not a value to round.
  if (!Number.isInteger(parts.ts) || parts.ts < 0) {
    throw new Error('brokerStartPayload: ts must be a non-negative integer (unix seconds)');
  }
  return `${BROKER_START_VERSION}.${parts.instanceId}.${parts.ts}.${parts.nonce}`;
}

/**
 * Split a token into its parts, or `null` if the framing is wrong.
 *
 * Framing only — this cannot and must not judge the signature or the age. It
 * returns `null` rather than throwing because every caller is on a path that
 * answers with a redirect, and a thrown error there becomes a 500 instead of a
 * named decline.
 */
export function parseBrokerStartToken(token: string): BrokerStartToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, ts, nonce, sig] = parts as [string, string, string, string];
  if (version !== BROKER_START_VERSION) return null;
  if (!/^\d+$/.test(ts)) return null;
  if (nonce.length !== BROKER_START_NONCE_BYTES * 2 || !/^[0-9a-f]+$/.test(nonce)) return null;
  // Pinned to the hex length of HMAC-SHA256 on purpose: a truncated signature is
  // a FRAMING error, and catching it here is cheaper than in a verifier that has
  // already derived a key. The version field is what a future algorithm changes.
  if (sig.length !== 64 || !/^[0-9a-f]+$/.test(sig)) return null;
  return { ts: Number(ts), nonce, sig };
}

/** Assemble a token from its parts and a signature computed by the caller. */
export function formatBrokerStartToken(parts: BrokerStartToken): string {
  return `${BROKER_START_VERSION}.${parts.ts}.${parts.nonce}.${parts.sig}`;
}
