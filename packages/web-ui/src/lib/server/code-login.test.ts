import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyCodeLogin, type CodeLoginDeps } from './code-login.js';
import { readSessionToken, MANDATE_SESSION_MAX_S, SESSION_MAX_AGE_S } from './auth.js';

// The golden body the control plane sends for a mandate login (core src/contract/fixtures).
const MANDATE_FIXTURE = fileURLToPath(new URL('../../../../../src/contract/fixtures/auth-login-success.mandate.json', import.meta.url));
const SECRET = 'engine-secret';

function deps(res: Response | (() => never), overrides: Partial<CodeLoginDeps> = {}): CodeLoginDeps {
	return {
		controlPlaneUrl: 'https://cp.example.invalid',
		instanceId: 'inst-1',
		secret: SECRET,
		email: 'owner@example.invalid',
		code: '123456',
		clientIp: '203.0.113.1',
		userAgent: 'test-agent',
		fetchImpl: vi.fn(async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch,
		...overrides,
	};
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('verifyCodeLogin', () => {
	it('sends the code with principal_version, so the CP may answer with a mandate', async () => {
		const d = deps(ok({ valid: true }));
		await verifyCodeLogin(d);
		const [url, init] = (d.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
		expect(url).toBe('https://cp.example.invalid/internal/auth/verify');
		expect(JSON.parse(init.body as string)).toEqual({ email: 'owner@example.invalid', code: '123456', instanceId: 'inst-1', principal_version: 1 });
		expect((init.headers as Record<string, string>)['x-instance-secret']).toBe(SECRET);
	});

	it('gives the owner the principal-less 30-day session for a body without a principal', async () => {
		const out = await verifyCodeLogin(deps(ok({ valid: true })));
		if (out.type !== 'session') throw new Error(JSON.stringify(out));
		expect(readSessionToken(out.session.token, SECRET)?.principal).toBeNull();
		expect(out.session.maxAge).toBe(SESSION_MAX_AGE_S);
	});

	it('gives the mandate session for the mandate the CP verified', async () => {
		const body = JSON.parse(readFileSync(MANDATE_FIXTURE, 'utf8')) as { principal: { mandate_id: string } };
		const out = await verifyCodeLogin(deps(ok(body)));
		if (out.type !== 'session') throw new Error(JSON.stringify(out));
		expect(readSessionToken(out.session.token, SECRET)?.principal?.mandate_id).toBe(body.principal.mandate_id);
		expect(out.session.maxAge).toBe(MANDATE_SESSION_MAX_S);
	});

	it('refuses a principal it does not know, and a body that is not JSON, instead of logging in the owner', async () => {
		expect(await verifyCodeLogin(deps(ok({ valid: true, principal: { kind: 'member' } }))))
			.toMatchObject({ type: 'fail', status: 502, failedLogin: false });
		expect(await verifyCodeLogin(deps(new Response('ok', { status: 200 }))))
			.toMatchObject({ type: 'fail', status: 502 });
	});

	it('gives no session when the mandate has already ended', async () => {
		const body = JSON.parse(readFileSync(MANDATE_FIXTURE, 'utf8')) as { principal: Record<string, unknown> };
		body.principal['mandate_expires_at'] = '2000-01-01T00:00:00.000Z';
		expect(await verifyCodeLogin(deps(ok(body)))).toMatchObject({ type: 'fail', status: 403 });
	});

	it('passes the CP refusal through and counts it as a failed login', async () => {
		const out = await verifyCodeLogin(deps(new Response(JSON.stringify({ error: 'Invalid code. Please try again.' }), { status: 401 })));
		expect(out).toEqual({ type: 'fail', status: 401, error: 'Invalid code. Please try again.', failedLogin: true });
	});

	it('reports an unreachable CP without counting it against the IP', async () => {
		const out = await verifyCodeLogin(deps(() => { throw new TypeError('fetch failed'); }));
		expect(out).toMatchObject({ type: 'fail', status: 502, failedLogin: false });
	});
});
