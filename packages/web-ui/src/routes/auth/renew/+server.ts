/**
 * `POST /auth/renew`: the browser asks shortly before a mandate session's `exp` (see
 * `$lib/utils/mandate-renew-timer.ts`). Thin shell around `renewMandateSession`; this file owns the
 * env reads, the cookie, and who may ask.
 *
 * Only this instance's own pages may ask. The engine's check of where a write comes from covers
 * `/api/*` only; this path reaches the Web UI before it, and a page on a sibling host is same-site,
 * so the browser would attach the Lax cookie to its request.
 */
import type { RequestHandler } from './$types.js';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isHttpsRequest, readSessionToken } from '$lib/server/auth.js';
import { foreignRequest, renewMandateSession } from '$lib/server/mandate-renew.js';
import { SESSION_COOKIE, setSessionCookie } from '$lib/server/session-cookie.js';

const throttle = new Map<string, number>();

const NO_STORE = { 'Cache-Control': 'no-store' };

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (foreignRequest(request, url.origin)) return json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE });

	// The hook passes everything when there is no secret; without one there is no session to renew.
	const secret = env.LYNOX_HTTP_SECRET;
	const token = cookies.get(SESSION_COOKIE);
	const session = secret && token ? readSessionToken(token, secret) : null;
	if (!secret || session === null) return json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });

	const instanceId = env.LYNOX_MANAGED_INSTANCE_ID;
	const controlPlaneUrl = env.LYNOX_MANAGED_CONTROL_PLANE_URL;
	const outcome = await renewMandateSession({
		principal: session.principal,
		secret,
		managed: instanceId && controlPlaneUrl ? { instanceId, controlPlaneUrl } : null,
		nowS: Math.floor(Date.now() / 1000),
		fetchImpl: fetch,
		throttle,
	});
	if (outcome.kind === 'owner') return json({ kind: 'owner' }, { headers: NO_STORE });
	if (outcome.renewed) setSessionCookie(cookies, outcome.session, isHttpsRequest(url, request));
	return json({ kind: 'mandate', exp: outcome.exp, renewed: outcome.renewed }, { headers: NO_STORE });
};
