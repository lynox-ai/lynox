import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/auth.js', async () => await import('../../../lib/server/auth.js'));

const { POST } = await import('./+server.js');
const { createSessionToken, MANDATE_SESSION_MAX_S } = await import('../../../lib/server/auth.js');

const SECRET = 'a'.repeat(64);

function ownerCookie(): string {
	return createSessionToken(SECRET);
}

function mandateCookie(): string {
	const nowS = Math.floor(Date.now() / 1000);
	return createSessionToken(SECRET, {
		v: 1, kind: 'mandate', email: 'recipient@example.test', display: 'TEST-DISPLAY',
		mandate_id: 'TEST-MANDATE-1', exp: nowS + MANDATE_SESSION_MAX_S,
	});
}

/** Every request the route sends to the control plane, by path. */
let cpCalls: string[] = [];

beforeEach(() => {
	env['LYNOX_HTTP_SECRET'] = SECRET;
	env['LYNOX_MANAGED_INSTANCE_ID'] = 'inst_test';
	env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.example.test';
	env['LYNOX_MANAGED_CUSTOMER_EMAIL'] = 'owner@example.test';
	cpCalls = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		cpCalls.push(new URL(url).pathname);
		return new Response(JSON.stringify({ hasPasskeys: false, options: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function post(action: string, cookie?: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const cookies = { get: (name: string) => (name === 'lynox_session' ? cookie : undefined) } as unknown as Cookies;
	const request = new Request('https://inst.example.test/auth/passkey', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, response: {}, deviceName: 'TEST-DEVICE' }),
	});
	const res = await POST({ request, cookies } as Parameters<typeof POST>[0]);
	return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('POST /auth/passkey — only the owner adds a passkey', () => {
	for (const action of ['register/start', 'register/complete']) {
		it(`${action}: the owner's session reaches the control plane`, async () => {
			const r = await post(action, ownerCookie());
			expect(r.status).toBe(200);
			expect(cpCalls).toEqual([`/internal/auth/webauthn/${action}`]);
		});

		it(`${action}: a mandate session is refused with 403 and nothing reaches the control plane`, async () => {
			const r = await post(action, mandateCookie());
			expect(r.status).toBe(403);
			expect(r.body).toEqual({ error: 'Only the account owner can add a passkey.' });
			expect(cpCalls).toEqual([]);
		});

		it(`${action}: no session is 401, as before`, async () => {
			const r = await post(action);
			expect(r.status).toBe(401);
			expect(cpCalls).toEqual([]);
		});
	}

	it('status tells the owner\'s session it may register', async () => {
		const r = await post('status', ownerCookie());
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ hasPasskeys: false, options: {}, canRegister: true });
	});

	it('status tells a mandate session it may not register', async () => {
		const r = await post('status', mandateCookie());
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ hasPasskeys: false, options: {}, canRegister: false });
	});

	it('status without a session says it may not register', async () => {
		const r = await post('status');
		expect(r.body['canRegister']).toBe(false);
	});

	it('authenticate/start stays open before any session, for the login itself', async () => {
		const r = await post('authenticate/start');
		expect(r.status).toBe(200);
		expect(cpCalls).toEqual(['/internal/auth/webauthn/authenticate/start']);
	});
});
