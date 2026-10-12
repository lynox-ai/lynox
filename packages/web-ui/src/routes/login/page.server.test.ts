import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/auth.js', async () => await import('../../lib/server/auth.js'));
vi.mock('$lib/contract/http.js', async () => await import('../../lib/contract/http.js'));
vi.mock('$lib/server/code-login.js', async () => await import('../../lib/server/code-login.js'));

const { load } = await import('./+page.server.js');
const { createSessionToken, createLinkCode, consumeLinkCode, readSessionToken, MANDATE_SESSION_MAX_S } = await import('../../lib/server/auth.js');

const SECRET = 'a'.repeat(64);
const ONBOARDING = 'TEST-ONBOARDING-TOKEN';
// The onboarding token marks itself used by writing a file; keep it out of the real home.
const dataDir = mkdtempSync(join(tmpdir(), 'lynox-login-test-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function mandateCookie(): string {
	const nowS = Math.floor(Date.now() / 1000);
	return createSessionToken(SECRET, {
		v: 1, kind: 'mandate', email: 'recipient@example.test', display: 'TEST-DISPLAY',
		mandate_id: 'TEST-MANDATE-1', exp: nowS + MANDATE_SESSION_MAX_S,
	});
}

beforeEach(() => {
	env['LYNOX_HTTP_SECRET'] = SECRET;
	env['LYNOX_DATA_DIR'] = dataDir;
	env['LYNOX_ONBOARDING_TOKEN'] = ONBOARDING;
	rmSync(join(dataDir, '.onboarding-consumed'), { force: true });
});

/** Run the login page's load; report the cookie it set and where it redirected. */
async function visit(query: string, cookie?: string): Promise<{ set: string | null; redirectedTo: string | null }> {
	let set: string | null = null;
	const cookies = {
		get: (name: string) => (name === 'lynox_session' ? cookie : undefined),
		set: (name: string, value: string) => { if (name === 'lynox_session') set = value; },
	} as unknown as Cookies;
	const url = new URL(`https://inst.example.test/login${query}`);
	try {
		await load({
			cookies, url, request: new Request(url), getClientAddress: () => '203.0.113.7', setHeaders: () => {},
		} as unknown as Parameters<typeof load>[0]);
		return { set, redirectedTo: null };
	} catch (thrown) {
		const location = thrown && typeof thrown === 'object' && 'location' in thrown ? (thrown as { location: string }).location : null;
		return { set, redirectedTo: location };
	}
}

describe('login page — a mandate session is sent on before any owner login runs', () => {
	it('a link code without a session logs in as the owner', async () => {
		const r = await visit(`?code=${createLinkCode()}`);
		expect(r.redirectedTo).toBe('/app');
		expect(r.set).not.toBeNull();
		expect(readSessionToken(r.set!, SECRET)?.principal).toBeNull();
	});

	it('a link code with a mandate session mints nothing and leaves the code unused', async () => {
		const code = createLinkCode();
		const r = await visit(`?code=${code}`, mandateCookie());
		expect(r).toEqual({ set: null, redirectedTo: '/app' });
		expect(consumeLinkCode(code)).toBe(true);
	});

	it('the onboarding token without a session logs in as the owner', async () => {
		const r = await visit(`?token=${ONBOARDING}`);
		expect(r.redirectedTo).toBe('/app');
		expect(readSessionToken(r.set!, SECRET)?.principal).toBeNull();
		expect(existsSync(join(dataDir, '.onboarding-consumed'))).toBe(true);
	});

	it('the onboarding token with a mandate session mints nothing and stays unused', async () => {
		const r = await visit(`?token=${ONBOARDING}`, mandateCookie());
		expect(r).toEqual({ set: null, redirectedTo: '/app' });
		expect(existsSync(join(dataDir, '.onboarding-consumed'))).toBe(false);
	});
});
