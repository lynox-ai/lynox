import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLocale } from '../../i18n.svelte.js';

const toasts: Array<{ text: string; kind: string }> = [];
vi.mock('../toast.svelte.js', () => ({
	addToast: (text: string, kind: string) => { toasts.push({ text, kind }); },
}));

/**
 * A claim the engine could not read (`code: 'google_claim_invalid'`) is worded for the owner
 * with a next step; the engine's own text for it never reaches the toast.
 */
beforeEach(() => {
	toasts.length = 0;
	vi.stubGlobal('fetch', vi.fn(async () => new Response(
		JSON.stringify({ error: 'Google could not be connected', code: 'google_claim_invalid' }),
		{ status: 500, headers: { 'content-type': 'application/json' } },
	)));
});
afterEach(() => { vi.unstubAllGlobals(); setLocale('de'); });

async function claim(): Promise<string> {
	const { claimManagedGoogleTokens } = await import('./google.svelte.js');
	return claimManagedGoogleTokens('nonce-1');
}

describe('a claim answer the engine could not read', () => {
	it('shows the German text with a next step', async () => {
		setLocale('de');
		await claim();
		expect(toasts).toEqual([{ text: 'Google liess sich gerade nicht verbinden. Versuch es später noch einmal; bleibt es so, schreib an support@lynox.ai.', kind: 'error' }]);
	});

	it('shows the English text with a next step', async () => {
		setLocale('en');
		await claim();
		expect(toasts).toEqual([{ text: "Google couldn't be connected right now. Try again later; if it keeps happening, write to support@lynox.ai.", kind: 'error' }]);
	});

	it('still shows the engine text for any other refusal', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Missing claim_nonce' }), { status: 400 })));
		await claim();
		expect(toasts).toEqual([{ text: 'Missing claim_nonce', kind: 'error' }]);
	});
});
