import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimConfirmCopy } from './google-claim-confirm.js';
import { setLocale, t } from '../../i18n.svelte.js';
import type { ClaimPreview } from './google.svelte.js';

/**
 * The dialog that asks before a parked Google claim is taken names the account
 * when it can. Two halves, both needed:
 *
 * - the lookup (`previewManagedGoogleClaim`) sorts the engine's answer into
 *   named, unnamed (the grant names no account) and unknown (no answer to go by,
 *   timeout included), so the dialog never waits on it and never shows an empty
 *   name;
 * - the copy (`claimConfirmCopy`) offers Connect for a named account and, as a
 *   fallback, for an unknown one; never while looking, never for an unnamed one.
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

async function preview(nonce = 'nonce-1'): Promise<ClaimPreview> {
	const { previewManagedGoogleClaim } = await import('./google.svelte.js');
	return previewManagedGoogleClaim(nonce);
}

describe('previewManagedGoogleClaim', () => {
	it('asks the preview route with the nonce, and returns the address', async () => {
		answer = () => json(200, { email: 'owner@example.com' });
		await expect(preview('nonce-7')).resolves.toEqual({ kind: 'named', email: 'owner@example.com' });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toMatch(/\/google\/claim-managed\/preview$/);
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ claim_nonce: 'nonce-7' });
	});

	it('is unnamed only when the engine says so', async () => {
		answer = () => json(200, { unnamed: true });
		await expect(preview()).resolves.toEqual({ kind: 'unnamed' });
	});

	it('is unknown for every other answer', async () => {
		for (const a of [
			() => json(200, {}),
			() => json(200, { email: '' }),
			() => json(200, { email: '   ' }),
			() => json(200, { email: 'not-an-address' }),
			() => json(200, { email: 42 }),
			() => json(200, null),
			() => json(200, { unnamed: 'yes' }),
			() => json(404, { error: 'Not found' }),
			() => json(500, { email: 'owner@example.com' }),
			() => json(500, { unnamed: true }),
			() => Promise.reject(new TypeError('Failed to fetch')),
		]) {
			answer = a;
			await expect(preview()).resolves.toEqual({ kind: 'unknown' });
		}
	});
});

describe('previewManagedGoogleClaim when the engine does not answer', () => {
	it('gives up after its timeout, so the dialog is never stuck', async () => {
		vi.stubGlobal('fetch', vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error); });
		})));
		const { previewManagedGoogleClaim } = await import('./google.svelte.js');
		await expect(previewManagedGoogleClaim('nonce-1', 20)).resolves.toEqual({ kind: 'unknown' });
	});
});

describe('claimConfirmCopy', () => {
	beforeEach(() => { setLocale('en'); });
	const sentence = (c: ReturnType<typeof claimConfirmCopy>): string => `${c.before}${c.email ?? ''}${c.after}`;

	it('waits, with Connect held, while the account is looked up', () => {
		const copy = claimConfirmCopy(null, t);
		expect(sentence(copy)).toMatch(/Checking which one it is/);
		expect(copy.confirm).toBe('disabled');
	});

	it('names the account, set apart from the sentence, and offers Connect', () => {
		const copy = claimConfirmCopy({ kind: 'named', email: 'owner@example.com' }, t);
		expect(copy.email).toBe('owner@example.com');
		expect(sentence(copy)).toBe('The Google account owner@example.com is waiting to be connected to this instance. Connect it?');
		expect(t(copy.hintKey)).toMatch(/^Only confirm if this is your account/);
		expect(copy.confirm).toBe('enabled');
	});

	it('does not offer Connect when the grant names no account', () => {
		const copy = claimConfirmCopy({ kind: 'unnamed' }, t);
		expect(copy.email).toBeNull();
		expect(sentence(copy)).toMatch(/We could not confirm which one it is, so it cannot be connected here/);
		expect(copy.confirm).toBe('hidden');
	});

	it('falls back to saying it cannot name the account when there is no answer', () => {
		const copy = claimConfirmCopy({ kind: 'unknown' }, t);
		expect(sentence(copy)).toBe('A Google account is waiting to be connected to this instance. Connect it?');
		expect(t(copy.hintKey)).toMatch(/We cannot show you which account it is/);
		expect(copy.confirm).toBe('enabled');
	});

	it('has every text in both languages, and the named one has its slot', () => {
		for (const locale of ['de', 'en'] as const) {
			setLocale(locale);
			for (const key of ['settings.google.claim_looking', 'settings.google.claim_confirm_named', 'settings.google.claim_confirm_named_hint', 'settings.google.claim_unnamed', 'settings.google.claim_unnamed_hint']) {
				expect(t(key)).not.toBe(key);
			}
			expect(t('settings.google.claim_confirm_named').split('{email}')).toHaveLength(2);
		}
	});
});
