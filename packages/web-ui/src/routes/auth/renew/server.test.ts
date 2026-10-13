import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/auth.js', async () => await import('../../../lib/server/auth.js'));
vi.mock('$lib/server/mandate-renew.js', async () => await import('../../../lib/server/mandate-renew.js'));
vi.mock('$lib/server/session-cookie.js', async () => await import('../../../lib/server/session-cookie.js'));

const { POST } = await import('./+server.js');
const { createSessionToken, loginSession, readSessionToken } = await import('../../../lib/server/auth.js');

const SECRET = 'a'.repeat(64);
const ORIGIN = 'https://tenant.example.invalid';
const ANSWER = {
	valid: true,
	principal: { kind: 'mandate', email: 'recipient@example.invalid', display: 'TEST-DISPLAY', mandate_expires_at: '2100-01-01T00:00:00.000Z' },
};

// The route's throttle lives as long as the module; each test uses its own mandate.
let mandateSeq = 0;
let mandateId = '';

/** A mandate cookie logged in an hour ago, ending in two minutes: inside the renewal window. */
function mandateCookie(): string {
	const nowS = Math.floor(Date.now() / 1000);
	return createSessionToken(SECRET, {
		v: 1, kind: 'mandate', email: ANSWER.principal.email, display: 'TEST-DISPLAY',
		mandate_id: mandateId, exp: nowS + 120, auth_time: nowS - 3600,
	});
}

const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ...ANSWER, principal: { ...ANSWER.principal, mandate_id: mandateId } }), { status: 200 }));

beforeEach(() => {
	mandateId = `TEST-MANDATE-R${++mandateSeq}`;
	env['LYNOX_HTTP_SECRET'] = SECRET;
	env['LYNOX_MANAGED_INSTANCE_ID'] = 'TEST-INSTANCE-1';
	env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.example.invalid';
	fetchStub.mockClear();
	vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function renew(opts: { cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown; set: { value: string; options: Record<string, unknown> } | null; cacheControl: string | null }> {
	let set: { value: string; options: Record<string, unknown> } | null = null;
	const cookies = {
		get: (name: string) => (name === 'lynox_session' ? opts.cookie : undefined),
		set: (name: string, value: string, options: Record<string, unknown>) => { if (name === 'lynox_session') set = { value, options }; },
	} as unknown as Cookies;
	const url = new URL(`${ORIGIN}/auth/renew`);
	const request = new Request(url, { method: 'POST', headers: opts.headers ?? { 'sec-fetch-site': 'same-origin' } });
	const res = await POST({ request, cookies, url } as unknown as Parameters<typeof POST>[0]);
	return { status: res.status, body: await res.json(), set, cacheControl: res.headers.get('cache-control') };
}

describe('POST /auth/renew', () => {
	it('refuses a request from another site, before reading the session', async () => {
		const foreign: Array<Record<string, string>> = [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'https://sibling.example.invalid' }];
		for (const headers of foreign) {
			const r = await renew({ cookie: mandateCookie(), headers });
			expect(r.status, JSON.stringify(headers)).toBe(403);
			expect(r.set).toBeNull();
		}
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it('answers 401 without a session, with a session it cannot read, or without a secret', async () => {
		expect((await renew()).status).toBe(401);
		expect((await renew({ cookie: 'not-a-token' })).status).toBe(401);
		const cookie = mandateCookie();
		env['LYNOX_HTTP_SECRET'] = undefined;
		expect((await renew({ cookie })).status).toBe(401);
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it('answers owner for the owner and sets no cookie', async () => {
		const r = await renew({ cookie: loginSession(SECRET, null)!.token });
		expect(r).toMatchObject({ status: 200, body: { kind: 'owner' }, set: null, cacheControl: 'no-store' });
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it('renews a mandate session and sets the next cookie, httpOnly and Lax', async () => {
		const r = await renew({ cookie: mandateCookie() });
		expect(r.status).toBe(200);
		expect(r.cacheControl).toBe('no-store');
		expect(r.body).toMatchObject({ kind: 'mandate', renewed: true });
		expect(r.set).not.toBeNull();
		expect(r.set!.options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
		expect(readSessionToken(r.set!.value, SECRET)?.principal?.mandate_id).toBe(mandateId);
		expect((r.body as { exp: number }).exp).toBe(readSessionToken(r.set!.value, SECRET)?.principal?.exp);
	});

	it('sets no cookie when the control plane refuses', async () => {
		fetchStub.mockResolvedValueOnce(new Response('{}', { status: 403 }));
		const r = await renew({ cookie: mandateCookie() });
		expect(r).toMatchObject({ status: 200, body: { kind: 'mandate', renewed: false }, set: null });
	});

	it('does not ask the control plane on an instance it did not provision', async () => {
		env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = undefined;
		const r = await renew({ cookie: mandateCookie() });
		expect(r).toMatchObject({ status: 200, body: { renewed: false }, set: null });
		expect(fetchStub).not.toHaveBeenCalled();
	});
});
