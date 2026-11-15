import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n.svelte.js';
import { LoadFailedError, ensureOk, loadFailedText } from './load-failed.js';

describe('the sentence for a failed load', () => {
	it('names the rate limit for a 429, in each form a page holds it', () => {
		for (const cause of [new LoadFailedError(429), new Response('', { status: 429 }), 429]) {
			expect(loadFailedText(cause)).toBe(t('common.rate_limited'));
		}
	});

	it('keeps the general sentence for every other failure', () => {
		for (const cause of [new LoadFailedError(500), new LoadFailedError(404), new Response('', { status: 503 }), 502, new TypeError('Failed to fetch'), new Error(), undefined]) {
			expect(loadFailedText(cause)).toBe(t('common.load_failed'));
		}
	});

	it('passes an ok response and throws its status otherwise', () => {
		const ok = new Response('{}', { status: 200 });
		expect(ensureOk(ok)).toBe(ok);
		expect(() => ensureOk(new Response('', { status: 429 }))).toThrow(LoadFailedError);
		try { ensureOk(new Response('', { status: 429 })); } catch (e) { expect((e as LoadFailedError).status).toBe(429); }
	});

	// A component that writes the general sentence itself would say "Is the engine reachable?"
	// to a 429 again. Every one goes through loadFailedText.
	it('is the only way a component writes the general sentence', () => {
		const dir = join(__dirname, 'components');
		const direct = readdirSync(dir, { recursive: true, encoding: 'utf8' })
			.filter((f) => f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts')))
			.filter((f) => readFileSync(join(dir, f), 'utf8').includes("t('common.load_failed')"));
		expect(direct).toEqual([]);
	});
});
