/**
 * Passkey API proxy — forwards WebAuthn requests to the control plane.
 *
 * Registration endpoints are session-protected (post-login).
 * Authentication endpoints are pre-session (used for login).
 * Status endpoint is pre-session (checks if passkeys exist).
 */

import type { RequestHandler } from './$types.js';
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { verifySessionToken } from '$lib/server/auth.js';

function getManagedConfig() {
	const instanceId = env.LYNOX_MANAGED_INSTANCE_ID;
	const controlPlaneUrl = env.LYNOX_MANAGED_CONTROL_PLANE_URL;
	const customerEmail = env.LYNOX_MANAGED_CUSTOMER_EMAIL;
	if (instanceId && controlPlaneUrl) {
		return { instanceId, controlPlaneUrl, customerEmail };
	}
	return null;
}

/** Proxy a request to the control plane WebAuthn endpoint. */
async function proxyToControlPlane(
	managed: NonNullable<ReturnType<typeof getManagedConfig>>,
	path: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<Response> {
	const secret = env.LYNOX_HTTP_SECRET;
	if (!secret) return json({ error: 'Not configured' }, { status: 500 });

	const res = await fetch(`${managed.controlPlaneUrl}/internal/auth/webauthn/${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-instance-secret': secret,
			...headers,
		},
		body: JSON.stringify({
			...body,
			instanceId: managed.instanceId,
			email: managed.customerEmail,
		}),
	});

	const data = await res.json();
	return json(data, { status: res.status });
}

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const managed = getManagedConfig();
	if (!managed) return json({ supported: false });

	const body = await request.json() as { action?: string; [key: string]: unknown };
	const action = body.action;

	if (!action) return json({ error: 'Missing action' }, { status: 400 });

	// Registration requires an active session
	if (action === 'register/start' || action === 'register/complete') {
		const secret = env.LYNOX_HTTP_SECRET;
		const sessionToken = cookies.get('lynox_session');
		if (!secret || !sessionToken || !verifySessionToken(sessionToken, secret)) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}
	}

	try {
		switch (action) {
			case 'status':
				return proxyToControlPlane(managed, 'status', {});
			case 'register/start':
				return proxyToControlPlane(managed, 'register/start', {});
			case 'register/complete':
				return proxyToControlPlane(managed, 'register/complete', {
					response: body.response,
					deviceName: body.deviceName,
				});
			case 'authenticate/start':
				return proxyToControlPlane(managed, 'authenticate/start', {});
			case 'authenticate/complete':
				return proxyToControlPlane(managed, 'authenticate/complete', {
					response: body.response,
				}, {
					'x-login-user-agent': request.headers.get('user-agent') ?? '',
					'x-login-ip': request.headers.get('x-forwarded-for') ?? '',
				});
			default:
				return json({ error: 'Unknown action' }, { status: 400 });
		}
	} catch {
		return json({ error: 'Could not reach the control plane' }, { status: 502 });
	}
};
