/**
 * The control-plane half of the managed code login (`/login`, verifyOtp).
 *
 * Extracted from the route so what the CP's answer turns into is unit-testable
 * without SvelteKit, like `magic-link.ts`. The route reads the form, sets the
 * cookie this returns, and redirects; it decides nothing about who logs in.
 */
import { LOGIN_PRINCIPAL_VERSION, type AuthCodeVerifyRequest } from '../contract/http.js';
import { loginSessionFromBody } from './auth.js';

export interface CodeLoginDeps {
	controlPlaneUrl: string;
	instanceId: string;
	/** LYNOX_HTTP_SECRET: authenticates the instance to the CP and signs the session. */
	secret: string;
	email: string;
	code: string;
	clientIp: string;
	userAgent: string;
	/** Stubbed in tests; production uses globalThis.fetch. */
	fetchImpl: typeof fetch;
}

export type CodeLoginOutcome =
	| { type: 'session'; session: { token: string; maxAge: number } }
	/** `failedLogin` counts toward the IP's rate limit. */
	| { type: 'fail'; status: number; error: string; failedLogin: boolean };

const UNREACHABLE = 'Could not reach the control plane. Please try again.';

export async function verifyCodeLogin(deps: CodeLoginDeps): Promise<CodeLoginOutcome> {
	let res: Response;
	try {
		res = await deps.fetchImpl(`${deps.controlPlaneUrl}/internal/auth/verify`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-instance-secret': deps.secret,
				'x-login-user-agent': deps.userAgent,
				'x-login-ip': deps.clientIp,
			},
			body: JSON.stringify({
				email: deps.email,
				code: deps.code,
				instanceId: deps.instanceId,
				principal_version: LOGIN_PRINCIPAL_VERSION,
			} satisfies AuthCodeVerifyRequest),
		});
	} catch {
		return { type: 'fail', status: 502, error: UNREACHABLE, failedLogin: false };
	}

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: 'Verification failed' })) as { error?: string };
		return { type: 'fail', status: res.status, error: body.error ?? 'Invalid code.', failedLogin: true };
	}

	// Code valid: the owner's session, or the mandate session for the login the
	// CP verified. A principal this reader does not know is refused, never read
	// as the owner.
	const session = loginSessionFromBody(deps.secret, await res.json().catch(() => null));
	if (session === 'unknown_principal') return { type: 'fail', status: 502, error: UNREACHABLE, failedLogin: false };
	if (session === 'ended') return { type: 'fail', status: 403, error: 'This access has ended.', failedLogin: false };
	return { type: 'session', session };
}
