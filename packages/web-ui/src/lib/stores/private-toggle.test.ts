import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateToggleFailure } from './private-toggle.js';

describe('privateToggleFailure — the page shows the state the server holds', () => {
	it('purge failed after the flag was stored: private mode stays ON, and the message says so', () => {
		// Rolling back here would show private mode OFF while it is on.
		expect(privateToggleFailure(false, { error: 'x', skip_extraction: true })).toEqual({
			skip: true,
			messageKey: 'threads.private_purge_incomplete',
		});
	});

	it('the server names a stored false: that wins over the previous value', () => {
		expect(privateToggleFailure(true, { skip_extraction: false })).toEqual({
			skip: false,
			messageKey: 'threads.error_extraction',
		});
	});

	it('no stored state in the answer (or no body at all): back to the previous value', () => {
		expect(privateToggleFailure(true, { error: 'Thread not found' })).toEqual({ skip: true, messageKey: 'threads.error_extraction' });
		expect(privateToggleFailure(false, null)).toEqual({ skip: false, messageKey: 'threads.error_extraction' });
		expect(privateToggleFailure(false, 'not json')).toEqual({ skip: false, messageKey: 'threads.error_extraction' });
	});

	it('both toggles use it, and both messages exist in both languages', () => {
		const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
		for (const store of ['./chat.svelte.ts', './threads.svelte.ts']) {
			expect(read(store)).toMatch(/privateToggleFailure\(/);
		}
		const i18n = read('../i18n.svelte.ts');
		for (const key of ['threads.private_purge_incomplete', 'threads.error_extraction']) {
			expect(i18n).toMatch(new RegExp(`'${key.replace('.', '\\.')}': \\{ de: '[^']+', en: '[^']+' \\}`));
		}
	});
});
