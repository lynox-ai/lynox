/**
 * Renewal of a mandate session (`POST /auth/renew`, PRD customer-granted-operator-access piece D).
 *
 * A mandate session ends at its signed `exp`, at most 15 minutes after it was minted. Shortly
 * before that the browser asks here; this asks the control plane whether the mandate is still
 * live for this instance's account and, when it is, mints the next session. The owner's session
 * is never touched, and nothing here can turn a mandate session into the owner's.
 *
 * Every doubt ends in no renewal: the control plane unreachable, slow, refusing, answering with
 * something this does not read, or naming another mandate. The session then ends at its `exp`,
 * as it did before renewal existed. Extracted from the route so it is unit-testable without
 * SvelteKit, like `code-login.ts`.
 */
import {
	LOGIN_PRINCIPAL_VERSION,
	MANDATE_RENEW_PATH,
	readRenewedPrincipal,
	type MandateRenewRequest,
} from '../contract/http.js';
import { MANDATE_RENEW_MAX_S, createSessionToken, mandateSessionPrincipal, type MandateSessionPrincipal } from './auth.js';

/** The control plane is asked only this close to the session's end. */
export const RENEW_WINDOW_S = 5 * 60;
/** At most one control-plane call per mandate this often, whatever the number of tabs. */
export const RENEW_THROTTLE_S = 30;
/** A control plane slower than this counts as unreachable. */
export const RENEW_TIMEOUT_MS = 5_000;
/** Entries the throttle keeps; the oldest goes first. */
const THROTTLE_MAX_ENTRIES = 1_000;

/**
 * Whether a request to `/auth/renew` came from somewhere other than this instance's own pages. A
 * browser says so in `Sec-Fetch-Site` (over HTTPS) or in `Origin`; a request with neither is not
 * a browser's, and whoever sends it holds the cookie already.
 */
export function foreignRequest(request: Request, ownOrigin: string): boolean {
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== null) return fetchSite !== 'same-origin';
	const origin = request.headers.get('origin');
	return origin !== null && origin !== ownOrigin;
}

export interface RenewDeps {
	/** The session's principal, read from a correctly signed cookie; `null` is the owner. */
	principal: MandateSessionPrincipal | null;
	/** LYNOX_HTTP_SECRET: authenticates the instance to the control plane and signs the session. */
	secret: string;
	/** Both set only on an instance the control plane provisioned. */
	managed: { instanceId: string; controlPlaneUrl: string } | null;
	nowS: number;
	/** Stubbed in tests; production uses globalThis.fetch. */
	fetchImpl: typeof fetch;
	/** When each mandate last asked the control plane, in Unix seconds. */
	throttle: Map<string, number>;
}

export type RenewOutcome =
	| { kind: 'owner' }
	| { kind: 'mandate'; exp: number; renewed: false }
	| { kind: 'mandate'; exp: number; renewed: true; session: { token: string; maxAge: number } };

export async function renewMandateSession(deps: RenewDeps): Promise<RenewOutcome> {
	const current = deps.principal;
	if (current === null) return { kind: 'owner' };
	const unchanged = { kind: 'mandate', exp: current.exp, renewed: false } as const;

	// A cookie from before `auth_time` existed is not renewed: its login time is unknown.
	const authTime = current.auth_time;
	if (authTime === undefined || deps.nowS - authTime >= MANDATE_RENEW_MAX_S) return unchanged;
	if (deps.managed === null) return unchanged;
	if (current.exp - deps.nowS > RENEW_WINDOW_S) return unchanged;

	// Taken before the call, so two tabs asking at once make one call, not two.
	const last = deps.throttle.get(current.mandate_id);
	if (last !== undefined && deps.nowS - last < RENEW_THROTTLE_S) return unchanged;
	remember(deps.throttle, current.mandate_id, deps.nowS);

	let res: Response;
	try {
		res = await deps.fetchImpl(`${deps.managed.controlPlaneUrl}${MANDATE_RENEW_PATH}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-instance-secret': deps.secret },
			body: JSON.stringify({
				instanceId: deps.managed.instanceId,
				mandate_id: current.mandate_id,
				email: current.email,
				principal_version: LOGIN_PRINCIPAL_VERSION,
			} satisfies MandateRenewRequest),
			redirect: 'error',
			signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
		});
	} catch {
		return unchanged;
	}
	if (res.status !== 200) {
		await res.body?.cancel().catch(() => { /* nothing to read */ });
		return unchanged;
	}
	const body: unknown = await res.json().catch(() => null);
	const renewed = readRenewedPrincipal(body, { mandate_id: current.mandate_id, email: current.email });
	if (renewed === null) return unchanged;

	const next = mandateSessionPrincipal(renewed, deps.nowS, authTime);
	// Only a later end is a renewal; the same end again would only repeat the call.
	if (next === null || next.exp <= current.exp) return unchanged;
	return {
		kind: 'mandate',
		exp: next.exp,
		renewed: true,
		session: { token: createSessionToken(deps.secret, next), maxAge: next.exp - deps.nowS },
	};
}

function remember(throttle: Map<string, number>, mandateId: string, nowS: number): void {
	throttle.delete(mandateId);
	throttle.set(mandateId, nowS);
	if (throttle.size > THROTTLE_MAX_ENTRIES) {
		const oldest = throttle.keys().next().value;
		if (oldest !== undefined) throttle.delete(oldest);
	}
}
