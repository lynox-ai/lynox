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
 * in its own code, with its own timing-safe compare.
 *
 * ⚠ What is meant to keep the two HMACs agreeing is ONE golden vector, here
 * ({@link BROKER_START_GOLDEN}), for both repos to drive: the engine's minter
 * must PRODUCE its token, the control plane's verifier must ACCEPT it. It is
 * meant to replace one vector per repo, each picked independently, which agree
 * by arithmetic rather than by construction — a derivation change on one side
 * re-picks that side's vector and goes unseen until a tenant clicks Connect.
 * This repo drives it from the start; the control plane's side switches over in
 * its own change, once this file has reached its vendored copy.
 *
 * What it catches, once both sides drive it: a derivation change on EITHER side
 * fails that side's own test against these bytes, because neither side can
 * re-pick them locally — the vector is contract. Re-picking it is an edit here,
 * which fails the other side's test when its vendored copy syncs.
 *
 * It is a literal in this file rather than `fixtures/broker-start-token.json`
 * (which this comment once promised) because that directory is built for JSON
 * wire shapes: a typed mirror against an `http.ts` shape, and string leaves
 * that are "obviously fake" (S4), which the mechanical check reads as 40-hex
 * SHAs — a 64-hex signature fails it on length. The hand-written lane
 * (`magic-link-verify-request.json`, which pins a key set) does not help either:
 * a hand-written token would fail S4 the same way unless S4 were widened for
 * it, and it would pin the framing, not the arithmetic — the part that drifts.
 * A literal here needs neither and stays dependency-free.
 *
 * The split is not cosmetic: what both sides MUST agree on byte-for-byte is the
 * payload and the framing, and that is what this file fixes. A shared HMAC
 * helper would fix the same bytes and drag a runtime dependency into a
 * directory two repos compile standalone.
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

/**
 * The one golden start token for both repos to check — the arithmetic, not only
 * the framing.
 *
 * Every field is an obviously fake choice except `token`'s signature, which is
 * computed, and that is the point: the engine's minter must produce exactly
 * `token` from the other fields, and the control plane's verifier must accept
 * it for `instanceId` under `signingKey`. Neither side may re-pick it. Changing
 * it is a wire change like any other here — edit this file, sync downstream.
 * `signingKey` stands in for the instance secret the key is derived from.
 *
 * It ships in `dist/` with the rest of the contract, as `fixtures/mirrors.ts`
 * does: a fake key and a 2023 timestamp, nothing a runtime could mistake for a
 * credential.
 */
export const BROKER_START_GOLDEN = {
  instanceId: 'inst_TEST',
  signingKey: 'TEST-SIGNING-KEY',
  ts: 1700000000,
  nonce: '00112233445566778899aabbccddeeff',
  payload: 'v1.inst_TEST.1700000000.00112233445566778899aabbccddeeff',
  token:
    'v1.1700000000.00112233445566778899aabbccddeeff.' +
    'de2dbbc230477eb6d6f2d5371045165091c39fae9e12b08fcb3fa8f7a0cb9e08',
} as const;

// === v2 — the start token bound to a provider (row 1224) ===
//
// v1 names no provider: neither its payload nor its key does. Once a second
// broker start route exists (Microsoft), a v1 token the engine minted for a
// Google start would verify at the Microsoft start of the same instance. v2
// puts the provider INSIDE the signed payload, and the control plane verifies
// with the provider of the ROUTE the token arrived at — so a token minted for
// one provider fails the signature at the other. The provider is deliberately
// not in the token's framing: what it is signed for is the route's business,
// and a field the caller can read is a field a verifier might be tempted to
// trust instead of the route.
//
// Rolled out expand/contract, like the env renames before it:
//   1. this contract adds v2 next to v1; the control plane accepts v2 at every
//      start route and v1 ONLY at the Google start (where every v1 token in the
//      field came from) — so the gap is closed for Microsoft from the first day
//      its route is mounted;
//   2. the engine mints v2 once a control plane that accepts it is on prod;
//   3. v1 acceptance, and the v1 symbols here, go after the fleet rollout.
//
// Same key derivation as v1 (`BROKER_START_PURPOSE`): the payloads open with
// different version fields, so no v1 signature can be a v2 signature. The
// `-v1` in that label names the KEY derivation, not the token version — it
// stays as it is for v2 on purpose, and changing it breaks every v2 vector.
//
// A token minted for the wrong provider fails as a plain bad signature; the
// control plane cannot tell it from a forgery, and that is accepted. The
// provider the verifier uses must be the provider of the ROUTE handler, never
// a query parameter or anything else the caller sends.

/** Framing version of the provider-bound token. */
export const BROKER_START_VERSION_V2 = 'v2';

/** The providers a broker start route exists or is planned for. Closed set. */
export const BROKER_START_PROVIDERS = ['google', 'microsoft'] as const;

/** One of {@link BROKER_START_PROVIDERS}. */
export type BrokerStartProvider = (typeof BROKER_START_PROVIDERS)[number];

/** Narrowing for a value read off a route or a config. */
export function isBrokerStartProvider(value: unknown): value is BrokerStartProvider {
  return typeof value === 'string' && (BROKER_START_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The exact bytes both sides sign for a v2 token. Order and separator are the
 * contract: `v2.<provider>.<instanceId>.<ts>.<nonce>`.
 *
 * Uniqueness holds for the reason {@link brokerStartPayload} gives, and the
 * provider does not weaken it: it comes from a closed vocabulary without the
 * separator and sits BEFORE the opaque instance id, so the first field after
 * the version is always the whole provider.
 */
export function brokerStartPayloadV2(parts: {
  provider: BrokerStartProvider;
  instanceId: string;
  ts: number;
  nonce: string;
}): string {
  if (!isBrokerStartProvider(parts.provider)) {
    throw new Error('brokerStartPayloadV2: provider must be one of BROKER_START_PROVIDERS');
  }
  // Safe integers only: from 1e21 on, `${ts}` renders with an exponent and a dot,
  // which breaks the "ts is digits only" premise the uniqueness argument rests on.
  if (!Number.isSafeInteger(parts.ts) || parts.ts < 0) {
    throw new Error('brokerStartPayloadV2: ts must be a non-negative integer (unix seconds)');
  }
  // The other half of that argument: the nonce is fixed-length hex. v1 relies on
  // its callers for this; v2 checks it, since a dotted nonce shifts the fields.
  if (parts.nonce.length !== BROKER_START_NONCE_BYTES * 2 || !/^[0-9a-f]+$/.test(parts.nonce)) {
    throw new Error('brokerStartPayloadV2: nonce must be BROKER_START_NONCE_BYTES bytes of lower-case hex');
  }
  return `${BROKER_START_VERSION_V2}.${parts.provider}.${parts.instanceId}.${parts.ts}.${parts.nonce}`;
}

/**
 * Split a v2 token into its parts, or `null` if the framing is wrong. Framing
 * only, like {@link parseBrokerStartToken}; a v1 token is `null` here.
 */
export function parseBrokerStartTokenV2(token: string): BrokerStartToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, ts, nonce, sig] = parts as [string, string, string, string];
  if (version !== BROKER_START_VERSION_V2) return null;
  // No leading zeros, so one signature has exactly one token string, and within
  // the safe-integer range for the reason `brokerStartPayloadV2` gives.
  if (!/^(0|[1-9]\d*)$/.test(ts) || !Number.isSafeInteger(Number(ts))) return null;
  if (nonce.length !== BROKER_START_NONCE_BYTES * 2 || !/^[0-9a-f]+$/.test(nonce)) return null;
  if (sig.length !== 64 || !/^[0-9a-f]+$/.test(sig)) return null;
  return { ts: Number(ts), nonce, sig };
}

/** The token versions a control plane may meet during the rollout. */
export type BrokerStartVersion = typeof BROKER_START_VERSION | typeof BROKER_START_VERSION_V2;

/**
 * Parse either version and SAY which one parsed — the verifier needs it, because
 * the version decides both the payload it recomputes and whether the route may
 * accept the token at all ({@link brokerStartAcceptsVersion}). Parsing with the
 * two functions above and `??` loses exactly that.
 */
export function parseAnyBrokerStartToken(token: string): (BrokerStartToken & { version: BrokerStartVersion }) | null {
  const v2 = parseBrokerStartTokenV2(token);
  if (v2) return { ...v2, version: BROKER_START_VERSION_V2 };
  const v1 = parseBrokerStartToken(token);
  if (v1) return { ...v1, version: BROKER_START_VERSION };
  return null;
}

/**
 * The acceptance rule of the rollout, in one place for both repos: v2 at every
 * start route, v1 only at the Google start — every v1 token in the field was
 * minted for Google, and a v1 token at any other route is the row-1224 gap.
 * The contract step of the rollout deletes the v1 branch.
 */
export function brokerStartAcceptsVersion(provider: BrokerStartProvider, version: BrokerStartVersion): boolean {
  if (version === BROKER_START_VERSION_V2) return true;
  // Fail closed: only an explicit v1 at the Google start, never "anything else".
  return version === BROKER_START_VERSION && provider === 'google';
}

/** Assemble a v2 token from its parts and a signature computed by the caller. */
export function formatBrokerStartTokenV2(parts: BrokerStartToken): string {
  return `${BROKER_START_VERSION_V2}.${parts.ts}.${parts.nonce}.${parts.sig}`;
}

/**
 * The golden v2 vectors, one per provider, from the same fake fields and key as
 * {@link BROKER_START_GOLDEN}. The engine's minter must produce `token` for its
 * provider; the control plane's verifier must accept each token at its own
 * provider's route and refuse it at the other's. That refusal is what row 1224
 * asks for, and the pair is what lets both repos test it on the same bytes.
 */
export const BROKER_START_GOLDEN_V2 = {
  instanceId: 'inst_TEST',
  signingKey: 'TEST-SIGNING-KEY',
  ts: 1700000000,
  nonce: '00112233445566778899aabbccddeeff',
  google: {
    payload: 'v2.google.inst_TEST.1700000000.00112233445566778899aabbccddeeff',
    token:
      'v2.1700000000.00112233445566778899aabbccddeeff.' +
      '79b7e314dba58dc76a0fdd0372e26d40d63413be68107b4e3f55b1f13a48a838',
  },
  microsoft: {
    payload: 'v2.microsoft.inst_TEST.1700000000.00112233445566778899aabbccddeeff',
    token:
      'v2.1700000000.00112233445566778899aabbccddeeff.' +
      '66fe9d89cd8a2ed728d28f898da0251dc2546b26bf30652e62a5ba27dd2d9b5c',
  },
} as const;
