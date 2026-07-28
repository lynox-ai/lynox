/**
 * Pure policy for the /auth/magic callback (Settings v3 PR 4.5 companion).
 *
 * Extracted from the +server.ts route so the decision tree is unit-testable
 * without spinning up SvelteKit. The route is a thin wrapper that reads env,
 * mints the cookie on success, and turns the returned outcome into a redirect.
 *
 * The wire half of this route — the request body and the `error_code`
 * vocabulary — comes from the vendored wire contract (`$lib/contract/http.js`),
 * not from local re-declarations.
 */
import {
	isMagicLinkErrorCode,
	type MagicLinkErrorCode,
	type MagicLinkVerifyRequest,
	type AuthErrorBody,
} from '../contract/http.js';

/**
 * Reason codes surfaced to the user on /login?error=magic_<reason>.
 *
 * The union is the control plane's wire codes (`MagicLinkErrorCode`, owned by
 * the contract) PLUS the outcomes this route decides on its own and that never
 * cross the wire. Spelling the wire half out again here is what let the two
 * drift before.
 *
 * Deriving it does NOT give a compile-time gate: widening the wire union widens
 * this one too, and `isMagicLinkErrorCode` then forwards the new value without
 * anything failing. What deriving buys is that the two can no longer disagree
 * about WHICH codes exist. The set itself is pinned by a hand-written golden
 * assertion in the test, because that is the part a derivation cannot check.
 */
export type MagicLinkReason =
	| MagicLinkErrorCode
	| 'missing_token'
	| 'unmanaged'
	| 'cp_unreachable';

export type MagicLinkOutcome =
	| { type: 'already_logged_in' }
	| { type: 'success' }
	| { type: 'redirect_login'; reason: MagicLinkReason };

export interface MagicLinkDeps {
	url: URL;
	hasValidSession: boolean;
	rateLimited: boolean;
	managed: { instanceId: string; controlPlaneUrl: string } | null;
	instanceSecret: string;
	clientIp: string;
	/** Stubbed in tests; production uses globalThis.fetch. */
	fetchImpl: typeof fetch;
	/** Stubbed in tests; lets the route observe failed-credentials signals. */
	onFailedLogin: () => void;
}

/** Minimum + maximum plausible magic-link token length. */
const TOKEN_MIN_LEN = 100; // see customer-auth.ts: base64url(JSON{..}) ≥ ~95 + dot + 43-char sig
const TOKEN_MAX_LEN = 4096;
const CP_FETCH_TIMEOUT_MS = 5000;

/**
 * Decide what /auth/magic should do given its inputs. Side effects (cookie
 * writes, throwing redirects, mutating rate-limit state) happen in the
 * route; this function only routes the outcome.
 */
export async function decideMagicLinkOutcome(deps: MagicLinkDeps): Promise<MagicLinkOutcome> {
	if (deps.hasValidSession) return { type: 'already_logged_in' };

	const token = deps.url.searchParams.get('token');
	if (!token || token.length < TOKEN_MIN_LEN || token.length > TOKEN_MAX_LEN) {
		return { type: 'redirect_login', reason: 'missing_token' };
	}

	if (!deps.managed) {
		// Self-host instances don't have a CP — magic-link is managed-only.
		return { type: 'redirect_login', reason: 'unmanaged' };
	}

	if (deps.rateLimited) {
		return { type: 'redirect_login', reason: 'rate_limited' };
	}

	let res: Response;
	try {
		res = await deps.fetchImpl(`${deps.managed.controlPlaneUrl}/internal/auth/verify-magic`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-instance-secret': deps.instanceSecret,
				'x-login-ip': deps.clientIp,
			},
			body: JSON.stringify({
				token,
				instanceId: deps.managed.instanceId,
			} satisfies MagicLinkVerifyRequest),
			signal: AbortSignal.timeout(CP_FETCH_TIMEOUT_MS),
		});
	} catch {
		return { type: 'redirect_login', reason: 'cp_unreachable' };
	}

	if (res.ok) return { type: 'success' };

	deps.onFailedLogin();

	// Translate the CP's error_code to a user-visible reason. Membership is
	// tested against the contract's closed set, so a code the CP starts sending
	// without the engine learning about it stays an UNKNOWN and takes the
	// conservative branch below rather than being silently accepted.
	const body = await res.json().catch(() => null) as Partial<AuthErrorBody> | null;
	if (isMagicLinkErrorCode(body?.error_code)) {
		return { type: 'redirect_login', reason: body.error_code };
	}
	// Status code is the fallback when error_code is missing or unrecognised
	// (older CPs, non-JSON 5xx, a newer CP's widened vocabulary).
	if (res.status === 410) return { type: 'redirect_login', reason: 'expired' };
	if (res.status === 401 || res.status === 403) return { type: 'redirect_login', reason: 'invalid' };
	if (res.status === 429) return { type: 'redirect_login', reason: 'rate_limited' };
	// Anything else — including a status the CP has newly started using — is
	// reported as "could not reach a control plane I understand". Telling the
	// user their link is invalid would be a guess, and the wrong guess sends
	// them to request a replacement for a link that was fine.
	return { type: 'redirect_login', reason: 'cp_unreachable' };
}
