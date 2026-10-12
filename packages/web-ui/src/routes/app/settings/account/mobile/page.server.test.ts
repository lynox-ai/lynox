import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/auth.js', async () => await import('../../../../../lib/server/auth.js'));

const { load } = await import('./+page.server.js');
const { createSessionToken, consumeLinkCode, MANDATE_SESSION_MAX_S } = await import('../../../../../lib/server/auth.js');

const SECRET = 'a'.repeat(64);

function mandateCookie(): string {
	const nowS = Math.floor(Date.now() / 1000);
	return createSessionToken(SECRET, {
		v: 1, kind: 'mandate', email: 'recipient@example.test', display: 'TEST-DISPLAY',
		mandate_id: 'TEST-MANDATE-1', exp: nowS + MANDATE_SESSION_MAX_S,
	});
}

async function loadWith(cookie: string | undefined): Promise<{ hasSecret: boolean; linkCode: string; ownerOnly: boolean }> {
	const cookies = { get: (name: string) => (name === 'lynox_session' ? cookie : undefined) } as unknown as Cookies;
	return await load({ cookies } as Parameters<typeof load>[0]) as { hasSecret: boolean; linkCode: string; ownerOnly: boolean };
}

beforeEach(() => {
	env['LYNOX_HTTP_SECRET'] = SECRET;
});

describe('mobile access page — a link code only for the owner', () => {
	it('gives the owner\'s session a code the login accepts', async () => {
		const data = await loadWith(createSessionToken(SECRET));
		expect(data.ownerOnly).toBe(false);
		expect(data.linkCode).not.toBe('');
		expect(consumeLinkCode(data.linkCode)).toBe(true);
	});

	it('gives a mandate session no code and says it is the owner\'s', async () => {
		const data = await loadWith(mandateCookie());
		expect(data).toEqual({ hasSecret: true, linkCode: '', ownerOnly: true });
	});

	it('without a secret there is no code and no owner note, as before', async () => {
		env['LYNOX_HTTP_SECRET'] = undefined;
		const data = await loadWith(undefined);
		expect(data).toEqual({ hasSecret: false, linkCode: '', ownerOnly: false });
	});
});
