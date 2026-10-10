import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/auth.js', async () => await import('../lib/server/auth.js'));
vi.mock('$lib/server/demo-mode.js', async () => await import('../lib/server/demo-mode.js'));

const { load } = await import('./+page.server.js');
const { createSessionToken, readSessionToken, MANDATE_SESSION_MAX_S } = await import('../lib/server/auth.js');

const SECRET = 'a'.repeat(64);

function mandateCookie(): string {
	const nowS = Math.floor(Date.now() / 1000);
	return createSessionToken(SECRET, {
		v: 1, kind: 'mandate', email: 'recipient@example.test', display: 'TEST-DISPLAY',
		mandate_id: 'TEST-MANDATE-1', exp: nowS + MANDATE_SESSION_MAX_S,
	});
}

beforeEach(() => {
	env['LYNOX_HTTP_SECRET'] = SECRET;
	env['LYNOX_DEMO_MODE'] = 'true';
});

async function visit(cookie?: string): Promise<{ set: string | null; redirectedTo: string | null }> {
	let set: string | null = null;
	const cookies = {
		get: (name: string) => (name === 'lynox_session' ? cookie : undefined),
		set: (name: string, value: string) => { if (name === 'lynox_session') set = value; },
	} as unknown as Cookies;
	try {
		await load({
			cookies, url: new URL('https://demo.example.test/'), getClientAddress: () => '203.0.113.8', setHeaders: () => {},
		} as unknown as Parameters<typeof load>[0]);
		return { set, redirectedTo: null };
	} catch (thrown) {
		const location = thrown && typeof thrown === 'object' && 'location' in thrown ? (thrown as { location: string }).location : null;
		return { set, redirectedTo: location };
	}
}

describe('root page in demo mode — a mandate session keeps its own session', () => {
	it('an anonymous visitor gets a demo session', async () => {
		const r = await visit();
		expect(r.redirectedTo).toBe('/app');
		expect(readSessionToken(r.set!, SECRET)?.principal).toBeNull();
	});

	it('a mandate session is sent on and gets no new session', async () => {
		const r = await visit(mandateCookie());
		expect(r).toEqual({ set: null, redirectedTo: '/app' });
	});
});
