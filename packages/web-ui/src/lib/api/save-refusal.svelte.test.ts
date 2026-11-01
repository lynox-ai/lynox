import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '../i18n.svelte.js';
import { SaveRefused, saveFailedText, shownReason, throwIfRefused } from './save-refusal.js';

const OWNER_ONLY = 'Only the owner of this instance can change the configuration.';
const LOCKED = 'Managed instance: cannot change provider';

async function failedText(res: Response, fallback = 'Save failed'): Promise<string> {
	try {
		await throwIfRefused(res);
	} catch (e) {
		return saveFailedText(e, fallback);
	}
	return 'NOT REFUSED';
}

afterEach(() => setLocale('de'));

describe('throwIfRefused + saveFailedText — the sentence a refused save shows (ux U-102)', () => {
	it('shows the server\'s sentence behind the translated lead, in both languages', async () => {
		setLocale('de');
		expect(await failedText(Response.json({ error: OWNER_ONLY }, { status: 403 }))).toBe(`Nicht gespeichert: ${OWNER_ONLY}`);
		setLocale('en');
		expect(await failedText(Response.json({ error: OWNER_ONLY }, { status: 403 }))).toBe(`Not saved: ${OWNER_ONLY}`);
	});

	it('shows the sentence of any other refusal, a locked field or a failed validation', async () => {
		setLocale('en');
		expect(await failedText(Response.json({ error: LOCKED }, { status: 403 }))).toBe(`Not saved: ${LOCKED}`);
		expect(await failedText(Response.json({ error: "provider:'openai' requires openai_model_id" }, { status: 400 })))
			.toBe("Not saved: provider:'openai' requires openai_model_id");
	});

	it('falls back to the page\'s own text when the server sent no sentence', async () => {
		expect(await failedText(new Response('<html>bad gateway</html>', { status: 502 }))).toBe('Save failed');
		expect(await failedText(Response.json({ error: '   ' }, { status: 400 }))).toBe('Save failed');
		expect(await failedText(Response.json({ error: { code: 'x' } }, { status: 400 }))).toBe('Save failed');
		expect(await failedText(Response.json(null, { status: 500 }))).toBe('Save failed');
	});

	it('keeps the status in the error message when there is no sentence, for a page that shows the message itself', async () => {
		const err = await throwIfRefused(new Response('', { status: 403 })).then(() => null, (e: unknown) => e);
		expect(err).toBeInstanceOf(SaveRefused);
		expect((err as SaveRefused).message).toBe('HTTP 403');
		expect((err as SaveRefused).status).toBe(403);
		setLocale('en');
		const named = await throwIfRefused(Response.json({ error: OWNER_ONLY }, { status: 403 })).then(() => null, (e: unknown) => e);
		expect((named as SaveRefused).message).toBe(`Not saved: ${OWNER_ONLY}`);
	});

	it('lets an ok answer through, and gives any other failure the fallback', async () => {
		await expect(throwIfRefused(Response.json({ ok: true }, { status: 200 }))).resolves.toBeUndefined();
		expect(saveFailedText(new TypeError('Failed to fetch'), 'Save failed')).toBe('Save failed');
		expect(saveFailedText('weird', 'Save failed')).toBe('Save failed');
	});
});

describe('shownReason — what of the server\'s sentence a toast may show', () => {
	it('drops a URL\'s credentials, query and fragment, and keeps where it points', () => {
		// The managed provider check quotes the api_base_url it refused.
		expect(shownReason("Managed instance: cannot set api_base_url to 'https://user:pw@api.example.com/v1?key=abc123#x' — only the curated endpoints are allowed."))
			.toBe("Managed instance: cannot set api_base_url to 'https://api.example.com/v1' — only the curated endpoints are allowed.");
	});

	it('drops the credentials of a URL in any scheme', () => {
		expect(shownReason("api_base_url 'postgres://u:pw@db.example.com/x' is not a curated endpoint"))
			.toBe("api_base_url 'postgres://db.example.com/x' is not a curated endpoint");
	});

	it('drops credentials and a query from a URL without a scheme, as a tier slot may hold one', () => {
		expect(shownReason("tier_set slot 'fast' api_base_url 'u:pw@api.example.com/v1?key=abc' is not a curated endpoint."))
			.toBe("tier_set slot 'fast' api_base_url 'api.example.com/v1' is not a curated endpoint.");
		// No dot, no path, a slash, an @ or an apostrophe in the password: the server's own words bound the value.
		for (const [entered, kept] of [['localhost:3000/v1?key=abc', 'localhost:3000/v1'], ['h.example.com?key=abc', 'h.example.com'], ['u:p/w@localhost/v1', 'localhost/v1'], ['u:pw@h#frag', 'h'], ['u:p@ss@h.example.com/v1', 'h.example.com/v1'], ["https://u:p'w@evil.example/v1?k=1", 'https://evil.example/v1']]) {
			expect(shownReason(`api_base_url '${entered}' does not belong to provider 'anthropic'.`)).toBe(`api_base_url '${kept}' does not belong to provider 'anthropic'.`);
		}
	});

	it('cleans every lead the server quotes an endpoint after, and nothing else in quotes', () => {
		expect(shownReason("Managed instance: provider 'openai' is only allowed with the curated Mistral preset api_base_url; got 'u:pw@h.example.com/v1?k=1'."))
			.toBe("Managed instance: provider 'openai' is only allowed with the curated Mistral preset api_base_url; got 'h.example.com/v1'.");
		expect(shownReason("Managed instance: cannot set api_base_url to 'localhost:3000/v1?key=abc' — only the curated endpoints are allowed."))
			.toBe("Managed instance: cannot set api_base_url to 'localhost:3000/v1' — only the curated endpoints are allowed.");
		expect(shownReason("Managed instance: tier_preset 'eu' slot 'fast' routes to 'u:pw@h#frag', which is not a curated endpoint"))
			.toBe("Managed instance: tier_preset 'eu' slot 'fast' routes to 'h', which is not a curated endpoint");
		// A model id and a slot name are not endpoints: an @ in them stays.
		const model = "Managed instance: tier_set slot 'a@b' model 'claude-x@20250101' is not available on this instance (operator model blocklist).";
		expect(shownReason(model)).toBe(model);
	});

	it('cleans a URL outside the quotes too, in any scheme', () => {
		// No lead names it: only the URL rule stands between such a sentence and the toast.
		expect(shownReason('see postgres://u:pw@db.example.com/x for details')).toBe('see postgres://db.example.com/x for details');
	});

	it('keeps the punctuation that ends the sentence after a query', () => {
		expect(shownReason('see https://docs.example.com/a?b=1.')).toBe('see https://docs.example.com/a.');
		expect(shownReason('(see https://a.example.com/x?q=1) ok')).toBe('(see https://a.example.com/x) ok');
	});

	it('masks the sentence a refused save carries, not only the helper\'s answer', async () => {
		setLocale('en');
		const refused = Response.json({ error: "Managed instance: api_base_url 'https://u:pw@h.example.com/v1?key=abc' does not belong to provider 'anthropic'." }, { status: 403 });
		expect(await failedText(refused)).toBe("Not saved: Managed instance: api_base_url 'https://h.example.com/v1' does not belong to provider 'anthropic'.");
	});

	it('leaves an ordinary sentence as it is, model ids and field names included', () => {
		for (const s of [
			OWNER_ONLY, LOCKED, "provider:'openai' requires openai_model_id", "Unknown tier_preset 'eu-fast'.", 'Invalid config: Unrecognized key: "extra"',
			// Ids the person needs to read, longer than any token rule would let through.
			"Managed instance: tier_set slot 'fast' model 'accounts/fireworks/models/deepseek-v4p1-flash-1017' is not available on this instance (operator model blocklist).",
			'background_model "3f2b6c1e-8a4d-4f7b-9c2e-1d5a6b7c8e9f" cannot run on this instance',
		]) {
			expect(shownReason(s)).toBe(s);
		}
	});

	it('ends a sentence over 200 characters in "…"', () => {
		const long = `Invalid config: ${'expected one of "a"|"b", '.repeat(20)}`;
		const shown = shownReason(long);
		expect(shown).toHaveLength(200);
		expect(shown.endsWith('…')).toBe(true);
		const exactly = `${'ab '.repeat(66)}ab`;
		expect(exactly).toHaveLength(200);
		expect(shownReason(exactly)).toBe(exactly);
	});
});
