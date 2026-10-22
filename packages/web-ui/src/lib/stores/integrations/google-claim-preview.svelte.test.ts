import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimConfirmCopy } from './google-claim-confirm.js';
import { setLocale, t, tf } from '../../i18n.svelte.js';

/**
 * The dialog that asks before a parked Google claim is taken names the account
 * when it can. Two halves, both needed:
 *
 * - the lookup (`previewManagedGoogleClaim`) turns every answer that is not a
 *   200 with an address into `null`, so the dialog never waits on it and never
 *   shows an empty name;
 * - the copy (`claimConfirmCopy`) names the account only when there is one, and
 *   otherwise keeps the text that says it cannot.
 */

const calls: Array<{ url: string; init?: RequestInit }> = [];
let answer: () => Promise<Response>;

beforeEach(() => {
	calls.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		calls.push({ url: String(input), ...(init ? { init } : {}) });
		return answer();
	}));
});
afterEach(() => { vi.unstubAllGlobals(); });

const json = (status: number, body: unknown): Promise<Response> =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

async function preview(nonce = 'nonce-1'): Promise<string | null> {
	const { previewManagedGoogleClaim } = await import('./google.svelte.js');
	return previewManagedGoogleClaim(nonce);
}

describe('previewManagedGoogleClaim', () => {
	it('asks the preview route with the nonce, and returns the address', async () => {
		answer = () => json(200, { email: 'owner@example.com' });
		await expect(preview('nonce-7')).resolves.toBe('owner@example.com');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toMatch(/\/google\/claim-managed\/preview$/);
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ claim_nonce: 'nonce-7' });
	});

	it('is null for every answer that does not name an account', async () => {
		for (const a of [
			() => json(200, {}),
			() => json(200, { email: '' }),
			() => json(200, { email: 42 }),
			() => json(404, { error: 'Not found' }),
			() => json(500, { email: 'owner@example.com' }),
			() => Promise.reject(new TypeError('Failed to fetch')),
		]) {
			answer = a;
			await expect(preview()).resolves.toBeNull();
		}
	});
});

describe('claimConfirmCopy', () => {
	beforeEach(() => { setLocale('en'); });

	it('names the account when there is one', () => {
		const copy = claimConfirmCopy('owner@example.com');
		expect(tf(copy.key, copy.vars)).toBe('The Google account owner@example.com is waiting to be connected to this instance. Connect it?');
		expect(t(copy.hintKey)).toMatch(/^Only confirm if this is your account/);
	});

	it('keeps the text that says it cannot name the account when there is none', () => {
		for (const email of [null, '']) {
			const copy = claimConfirmCopy(email);
			expect(tf(copy.key, copy.vars)).toBe('A Google account is waiting to be connected to this instance. Connect it?');
			expect(t(copy.hintKey)).toMatch(/We cannot show you which account it is/);
		}
	});

	it('has both texts in both languages', () => {
		for (const locale of ['de', 'en'] as const) {
			setLocale(locale);
			for (const key of ['settings.google.claim_confirm_named', 'settings.google.claim_confirm_named_hint']) {
				expect(t(key)).not.toBe(key);
			}
			expect(tf('settings.google.claim_confirm_named', { email: 'a@b.example' })).toContain('a@b.example');
		}
	});
});
