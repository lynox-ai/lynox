/**
 * PKCE (RFC 7636) for the profile authorization-code flow.
 *
 * ── Why a public-client mechanism on a flow that has a client secret ───────
 *
 * PKCE exists for clients that cannot keep a secret. This flow can: the secret
 * lives in the vault and the exchange happens server-side. So PKCE is not what
 * makes the exchange safe here — it is a second binding on top of it.
 *
 * What it buys is narrow and worth naming instead of implying: the callback is
 * unauthenticated by construction, so the authorization CODE travels through a
 * browser this engine does not control. The state cookie binds the callback to
 * the browser that started the flow; PKCE binds the code to the same start.
 * A code lifted out of a redirect — a shared machine, a referrer, a proxy log —
 * cannot be exchanged without the verifier, which never leaves this engine's
 * signed cookie.
 *
 * ⚠ **Not measured against a real provider, because there is none yet.** The
 * preset register ships empty, so no authorize URL exists to send these
 * parameters to. RFC 7636 §4.4 says a server that does not support PKCE
 * ignores the parameters, but "the specification says so" is not the same as
 * "this provider does", and the first preset that lands is where that gets
 * checked. Written now rather than retrofitted because the verifier is a field
 * of the signed state cookie: adding it later changes a format that is already
 * minted, and a format change during a live flow invalidates every round-trip
 * in progress.
 */

import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_BYTES = 64; // base64url of 64 bytes → 86 chars, inside the range

export interface PkcePair {
  /** Kept by this engine, in the signed state cookie. Never sent to the provider. */
  readonly verifier: string;
  /** Sent to the provider on the authorize URL. */
  readonly challenge: string;
  /** Always `S256`; `plain` is offered by the RFC and is not offered here. */
  readonly method: 'S256';
}

/**
 * A fresh pair.
 *
 * `base64url` rather than `base64` + three replacements: the encoding is what
 * the RFC names, and hand-rewriting `+/=` is the step where one of the three
 * gets forgotten. Node has had `base64url` since 14.
 *
 * The RFC also allows `plain`, where the challenge IS the verifier. It is not
 * offered here and there is no parameter to select it: a code interceptor who
 * can read the redirect can read a `plain` challenge out of the authorize URL
 * too, so the mechanism protects nothing in the case it exists for.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  return { verifier, challenge: deriveChallenge(verifier), method: 'S256' };
}

/**
 * The S256 challenge for a verifier.
 *
 * Exported separately so the exchange side can be tested against a verifier it
 * did not generate — and so a provider's echoed challenge can be compared
 * without re-running the generator.
 */
export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
