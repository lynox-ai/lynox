/**
 * Pure policy for the /auth/magic callback (Settings v3 PR 4.5 companion).
 *
 * Extracted from the +server.ts route so the decision tree is unit-testable
 * without spinning up SvelteKit. The route is a thin wrapper that reads env,
 * mints the cookie on success, and turns the returned outcome into a redirect.
 *
 * Cross-ref: `lynox-ai/lynox-pro#149` for the CP's verify-magic endpoint.
 */

/** Reason codes surfaced to the user on /login?error=magic_<reason>. */
export type MagicLinkReason =
	| 'missing_token'
	| 'rate_limited'
	| 'unmanaged'
	| 'cp_unreachable'
	| 'invalid'
	| 'expired'
	| 'replay';

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
			body: JSON.stringify({ token, instanceId: deps.managed.instanceId }),
			signal: AbortSignal.timeout(CP_FETCH_TIMEOUT_MS),
		});
	} catch {
		return { type: 'redirect_login', reason: 'cp_unreachable' };
	}

	if (res.ok) return { type: 'success' };

	deps.onFailedLogin();

	// Translate CP error_code to user-visible reason. The Pro side returns
	// a structured `{error, error_code}` body per its verify-magic contract
	// (lynox-ai/lynox-pro#149). Status code is the fallback when error_code
	// is missing (older CPs / non-JSON 5xx).
	const body = await res.json().catch(() => null) as { error_code?: string } | null;
	const code = body?.error_code;
	if (code === 'expired' || code === 'replay' || code === 'invalid' || code === 'rate_limited') {
		return { type: 'redirect_login', reason: code };
	}
	if (res.status === 410) return { type: 'redirect_login', reason: 'expired' };
	if (res.status === 401 || res.status === 403) return { type: 'redirect_login', reason: 'invalid' };
	if (res.status === 429) return { type: 'redirect_login', reason: 'rate_limited' };
	return { type: 'redirect_login', reason: 'cp_unreachable' };
}
